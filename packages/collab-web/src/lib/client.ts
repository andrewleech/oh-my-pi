/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * commit, so React change detection is reference equality all the way.
 *
 * High-rate frames (streaming `message_update`, `tool_execution_update`,
 * subagent progress) are applied immediately but published at most once per
 * animation frame; every other frame publishes synchronously, flushing any
 * pending state with it, so the published end state is unchanged.
 */

import { CompactionFragmentAssembler, MAX_COMPACTION_FRAGMENT_BYTES } from "@oh-my-pi/pi-wire";
import type {
	AgentSnapshot,
	AssistantMessage,
	CollabElided,
	CollabCommand,
	CollabUiRequest,
	CollabUiResponseValue,
	HostFrame,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { takeAutoRejoin } from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { applyElidedValue, sameElided } from "./elided";
import { COLLAB_PROTO, collabProtoFallback, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

/** Paging state for a guest the host joined with a tail (`welcome.history`). */
export interface HistoryState {
	/** First entry id held; the `before` cursor of the next page. */
	startId: string | null;
	/** The host's active branch has entries before `startId`. */
	hasEarlier: boolean;
	/** A page request is in flight. */
	loading: boolean;
	/** Why the last page request failed; cleared when a page lands. */
	error: string | null;
}

/** The latest slash command this guest asked the host to run. */
export interface CommandRun {
	reqId: number;
	/** The command line as sent, starting with `/`. */
	text: string;
	status: "running" | "done" | "error";
	/** Joined text output when `done`; the failure reason when `error`. */
	output: string;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	canRewind: boolean;
	canSnapcompactFrom: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
	/** Set when the host sent a tail instead of the full session; `null` for a full snapshot. */
	history: HistoryState | null;
	/**
	 * Slash commands the host runs for this guest; `null` until the host
	 * advertises them (read-only guests and hosts without command support),
	 * in which case slash text is sent as a plain prompt.
	 */
	commands: readonly CollabCommand[] | null;
	/** Latest command this guest ran, until dismissed. */
	command: CommandRun | null;
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/**
 * Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk
 * must make progress. History pages use the same per-frame budget.
 */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
/** Commit delay when `requestAnimationFrame` is unavailable (tests, non-DOM hosts). */
const FRAME_FALLBACK_MS = 16;

/** Runs `callback` on the next animation frame; returns its cancel function. */
function scheduleFrame(callback: () => void): () => void {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const timer = setTimeout(callback, FRAME_FALLBACK_MS);
	return () => clearTimeout(timer);
}

/** High-rate frames whose publish is deferred to the next animation frame. */
function isCoalescable(frame: HostFrame): boolean {
	if (frame.t === "event")
		return frame.event.type === "message_update" || frame.event.type === "tool_execution_update";
	return frame.t === "bus" && frame.channel === "task:subagent:progress";
}

/** Byte budget of the join tail; the host fills it with whole turns and earlier turns page in on demand. */
export const TAIL_BYTES = 1024 * 1024;
/** Byte budget of each "load earlier" page. */
export const PAGE_BYTES = 1024 * 1024;

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

/** The in-flight fetch-history request; its page accumulates across `history` frames. */
interface PendingHistory {
	reqId: number;
	entries: ({ entry: SessionEntry } | { transferId: string; entry?: SessionEntry })[];
	fragments: CompactionFragmentAssembler;
	transfers: Map<string, { transferId: string; entry?: SessionEntry }>;
	final: Extract<HostFrame, { t: "history" }> | null;
	timer: Timer;
}

/** Outcome of {@link GuestClient.fetchValue}: the parsed original, or why it could not be fetched. */
export type ValueResult = { kind: "value"; value: unknown } | { kind: "error"; message: string };

/** Shown when the host's copy of a trimmed value changed after it was sent. */
export const STALE_VALUE_MESSAGE = "content changed on the host; reload the session";

/** One fetch-value transfer. Every slice is its own request, continuing at `offset`. */
interface PendingValue {
	entryId: string;
	path: (string | number)[];
	hash: string;
	/** Slices so far; `offset` is their length in UTF-16 units. */
	slices: string[];
	offset: number;
	timer: Timer | undefined;
	resolve: (result: ValueResult) => void;
}

export interface RewindResult {
	draft?: string;
	images?: ImageContent[];
	replaceDraft?: boolean;
}

interface PendingAction<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timer: Timer;
}
export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	/** Keyed by the reqId of the slice in flight. */
	readonly #pendingValues = new Map<number, PendingValue>();
	readonly #pendingRewinds = new Map<number, PendingAction<RewindResult>>();
	readonly #pendingForks = new Map<number, PendingAction<void>>();
	readonly #pendingSnapcompactions = new Map<number, PendingAction<void>>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#everWelcomed = false;
	#autoRejoins: number[] = [];
	/** A live replica re-sent hello after a stale history cursor and awaits the fresh welcome. */
	#rejoining = false;
	/** Version of the hello sent on this connection; a v3 host's refusal lowers it once (see collabProtoFallback). */
	#helloProto = COLLAB_PROTO;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	#snapshotPrefixRemaining = 0;
	#pendingHistory: PendingHistory | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	/**
	 * Snapshot in flight since `welcome`: chunk entries, plus live `entry`
	 * frames that arrived meanwhile (published after the snapshot, at the tail).
	 */
	#pendingSnapshot: { entries: SessionEntry[]; live: SessionEntry[]; total: number } | null = null;
	#compactionFragments = new CompactionFragmentAssembler();
	#transfers = new Map<
		string,
		{ kind: "transfer"; id: string; scope: "snapshot" | "live"; bytes: number; entry?: SessionEntry }
	>();
	#orderedFrames: (
		| { kind: "frame"; frame: HostFrame }
		| { kind: "transfer"; id: string; scope: "snapshot" | "live"; bytes: number; entry?: SessionEntry }
	)[] = [];
	#transferBytes = 0;
	#staleTransfers = new Set<string>();
	#drainingFrames = false;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	/**
	 * Bus-map keys absent from the latest `agents` frame. Progress can arrive
	 * before its agent is listed, so such keys survive one `agents` frame and
	 * are pruned only if the next one still omits them.
	 */
	#unlistedBusIds = new Set<string>();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#canRewind = false;
	#canSnapcompactFrom = false;
	#hasHostLeaf = false;
	#hostLeafId: string | null = null;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#history: HistoryState | null = null;
	#commands: readonly CollabCommand[] | null = null;
	#command: CommandRun | null = null;
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * `#entries` is mutated (welcome/snapshot-chunk/entry/history frames). Every
	 * other frame (streaming message_update, state, bus, agents) reuses the
	 * same reference, so entry-identity consumers (Transcript memo,
	 * useSyncExternalStore) skip their O(n) scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];
	/** Cancels the scheduled deferred commit; null when none is pending. */
	#cancelFrameCommit: (() => void) | null = null;

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) this.#armWelcomeTimer();
	}

	close(): void {
		this.#staleTransfers.clear();
		this.#clearWelcomeTimer();
		this.#resetTransfers();
		this.#clearSnapshotProgressTimer();
		this.#failPendingActions("the session ended");
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced per commit (at most once per animation frame for streaming frames). */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/** Sends a prompt; `images` rides along only when there is at least one. */
	sendPrompt(text: string, images?: ImageContent[]): void {
		this.#socket.send(images && images.length > 0 ? { t: "prompt", text, images } : { t: "prompt", text });
	}

	/**
	 * Asks the host to run a slash command. The result lands in
	 * {@link GuestSnapshot.command}, replacing any previous one.
	 */
	sendCommand(text: string): void {
		const reqId = ++this.#reqSeq;
		this.#socket.send({ t: "command", reqId, text });
		this.#command = { reqId, text, status: "running", output: "" };
		this.#commit();
	}

	/** Hides a finished command result. A running command stays until its result arrives. */
	dismissCommand(): void {
		if (this.#command === null || this.#command.status === "running") return;
		this.#command = null;
		this.#commit();
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		this.#socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
	}

	sendAbort(): void {
		this.#socket.send({ t: "abort" });
	}
	sendRewind(entryId: string): Promise<RewindResult> {
		if (!this.#canRewind) return Promise.reject(new Error("the host does not support rewind"));
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<RewindResult>();
		const timer = setTimeout(() => {
			this.#pendingRewinds.delete(reqId);
			reject(new Error("the host did not answer the rewind request"));
		}, 30_000);
		this.#pendingRewinds.set(reqId, { resolve, reject, timer });
		this.#socket.send({ t: "rewind", reqId, entryId });
		return promise;
	}

	sendFork(entryId: string, name: string): Promise<void> {
		if (!this.#canRewind) return Promise.reject(new Error("the host does not support forking"));
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this.#pendingForks.delete(reqId);
			reject(new Error("the host did not answer the fork request"));
		}, 30_000);
		this.#pendingForks.set(reqId, { resolve, reject, timer });
		this.#socket.send({ t: "fork", reqId, entryId, name });
		return promise;
	}

	sendSnapcompactFrom(entryId: string): Promise<void> {
		if (!this.#canSnapcompactFrom || this.#readOnly)
			return Promise.reject(new Error("the host does not support snapcompact"));
		if (this.#phase !== "live" || this.#working || this.#uiRequest !== null)
			return Promise.reject(new Error("the session is not ready for snapcompact"));
		if (this.#pendingSnapcompactions.size > 0) return Promise.reject(new Error("snapcompact is already in progress"));
		if (!this.#publishedEntries.some(entry => entry.id === entryId))
			return Promise.reject(new Error("the selected message is no longer active"));
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this.#pendingSnapcompactions.delete(reqId);
			reject(new Error("snapcompact result is unknown: the host did not answer"));
		}, 120_000);
		this.#pendingSnapcompactions.set(reqId, { resolve, reject, timer });
		this.#socket.send({ t: "snapcompact-from", reqId, entryId });
		return promise;
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/**
	 * Request the page of history just before the oldest entry held. A no-op
	 * unless the host joined this guest with a tail that has earlier entries,
	 * the replica is live, and no page is already in flight. The outcome lands
	 * in {@link GuestSnapshot.history}; the page is prepended in one commit.
	 */
	fetchHistory(): void {
		const history = this.#history;
		if (
			history === null ||
			!history.hasEarlier ||
			history.startId === null ||
			history.loading ||
			this.#pendingSnapshot !== null ||
			this.#phase !== "live"
		) {
			return;
		}
		const reqId = ++this.#reqSeq;
		const pending: PendingHistory = {
			reqId,
			entries: [],
			fragments: new CompactionFragmentAssembler(),
			transfers: new Map(),
			final: null,
			timer: this.#historyTimer(reqId),
		};
		this.#pendingHistory = pending;
		// Any previous error stays until this page lands, so the control keeps its height.
		this.#history = { ...history, loading: true };
		this.#socket.send({ t: "fetch-history", reqId, before: history.startId, maxBytes: PAGE_BYTES });
		this.#commit();
	}

	/**
	 * The original of a value the host trimmed, reassembled from as many
	 * `value` slices as it takes. Only for a host that advertised
	 * `welcome.history`. Resolves an error for a host refusal
	 * ("stale" resolves {@link STALE_VALUE_MESSAGE} and posts it as a notice),
	 * a stalled slice, or a lost connection; nothing is retried.
	 */
	fetchValue(entryId: string, path: (string | number)[], hash: string): Promise<ValueResult> {
		if (this.#history === null || this.#phase !== "live") {
			return Promise.resolve({ kind: "error", message: "the host can't send trimmed values right now" });
		}
		const { promise, resolve } = Promise.withResolvers<ValueResult>();
		this.#requestValueSlice({ entryId, path, hash, slices: [], offset: 0, timer: undefined, resolve });
		return promise;
	}

	/**
	 * Fetch the original behind `elided`, one of entry `entryId`'s
	 * `collabElided` records, and swap the patched entry into the replica.
	 * Resolves `null` once loaded, or when nothing is left to load (loaded
	 * already, or the entry is gone); else the reason, ready to show.
	 */
	async loadFull(entryId: string, elided: CollabElided): Promise<string | null> {
		const held = this.#entries.find(entry => entry.id === entryId);
		if (!held?.collabElided?.some(record => sameElided(record, elided))) return null;
		const result = await this.fetchValue(entryId, elided.path, elided.hash);
		if (result.kind === "error") return result.message;
		// The replica may have moved on while the value was in flight.
		const index = this.#entries.findIndex(entry => entry.id === entryId);
		const entry = this.#entries[index];
		const record = entry?.collabElided?.find(other => sameElided(other, elided));
		if (entry === undefined || record === undefined) return null;
		let patched: SessionEntry;
		try {
			patched = applyElidedValue(entry, record, result.value);
		} catch (err) {
			return `couldn't show the loaded value: ${err instanceof Error ? err.message : String(err)}`;
		}
		this.#entries[index] = patched;
		this.#publishActiveBranch();
		this.#commit();
		return null;
	}

	/**
	 * Test seam: apply a synthetic host frame through the real apply path. With
	 * `flush` (default), a commit deferred to the next animation frame is
	 * published now, so the snapshot reflects the frame on return.
	 */
	applyFrameForTest(frame: HostFrame, options: { flush?: boolean } = {}): void {
		this.#applyFrameSafe(frame);
		if ((options.flush ?? true) && this.#cancelFrameCommit !== null) this.#commit();
	}

	#handleOpen(): void {
		this.#staleTransfers.clear();
		this.#welcomed = false;
		this.#resetTransfers();
		if (this.#everWelcomed) this.#armRejoinTimer();
		else if (this.#welcomeTimer === null) this.#armWelcomeTimer();
		this.#helloProto = COLLAB_PROTO;
		this.#sendHello();
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	/**
	 * Say hello again after the host dropped this guest, within the auto-rejoin
	 * budget. A welcome that does not follow retries through the same budget. Once
	 * the budget is spent the session ends, leaving the rejoin to the user.
	 */
	#rejoin(message: string): void {
		if (!takeAutoRejoin(this.#autoRejoins)) {
			this.#end(message);
			return;
		}
		for (const transfer of this.#transfers.values()) {
			if (transfer.entry === undefined) {
				if (this.#staleTransfers.size >= 128) {
					this.#end("too many stale transfers");
					return;
				}
				this.#staleTransfers.add(transfer.id);
			}
		}
		this.#clearSnapshotProgressTimer();
		this.#dropPendingHistory(null);
		this.#failPendingValues("the session reloaded; try again");
		this.#failPendingActions("the host session reloaded; try again");
		this.#rejoining = false;
		this.#resetTransfers();
		this.#welcomed = false;
		this.#pendingSnapshot = null;
		this.#clearUiRequests();
		this.#phase = "reconnecting";
		this.#sendHello();
		this.#armRejoinTimer();
		this.#commit();
	}

	/** A post-join hello the host never welcomes retries through the rejoin budget. */
	#armRejoinTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			if (this.#phase === "live" || this.#phase === "ended") return;
			this.#rejoin("timed out waiting for the host's welcome");
		}, WELCOME_TIMEOUT_MS);
	}

	/** (Re)introduce this guest; the host answers with a fresh welcome and snapshot train. */
	#sendHello(): void {
		this.#socket.send({
			t: "hello",
			proto: this.#helloProto,
			name: this.#name,
			writeToken: this.#writeToken,
			compactionFragments: true,
			historyCompactionFragments: true,
			snapshot: { mode: "tail", maxBytes: TAIL_BYTES },
		});
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#staleTransfers.clear();
		const interrupted = this.#transfers.size > 0;
		this.#resetTransfers();
		this.#welcomed = false;
		if (this.#everWelcomed) this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		// The host discards this peer's queued replies with the connection.
		this.#dropPendingHistory(null);
		this.#failPendingValues("connection lost; try again");
		this.#failRunningCommand();
		this.#failPendingActions("connection lost; try again");
		if (this.#phase === "ended") return;
		if (willReconnect) {
			if (interrupted) this.#pushNotice("error", "compaction transfer interrupted; reconnecting");
			this.#phase = "reconnecting";
			// The next open's hello supersedes an in-session rejoin.
			this.#rejoining = false;
			// The next welcome restarts the snapshot; drop the partial one.
			this.#pendingSnapshot = null;
			this.#commit();
			return;
		}
		this.#end(interrupted ? `compaction transfer interrupted: ${reason}` : reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#staleTransfers.clear();
		this.#clearSnapshotProgressTimer();
		this.#resetTransfers();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#pendingSnapshot = null;
		this.#failPendingTranscripts();
		this.#dropPendingHistory(null);
		this.#failPendingValues("the session ended");
		this.#failRunningCommand();
		this.#failPendingActions("the session ended");
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			if (this.#rejoining) {
				// The replica is still live; only its history cursor is stale. A
				// retry re-requests the page, and its "stale" reply rejoins again.
				this.#rejoining = false;
				if (this.#history !== null) {
					this.#history = { ...this.#history, loading: false, error: "timed out reloading the latest messages" };
				}
				this.#commit();
				return;
			}
			if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
		}, WELCOME_TIMEOUT_MS);
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	/** Idle timer for page `reqId`: re-armed by every `history` frame that makes progress. */
	#historyTimer(reqId: number): Timer {
		return setTimeout(() => {
			if (this.#pendingHistory?.reqId !== reqId) return;
			this.#dropPendingHistory("timed out loading earlier messages");
			this.#commit();
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	/**
	 * Forget the in-flight page request, if any; replies still on the wire
	 * are then ignored by reqId. `error` is surfaced, `null` clears it.
	 * Callers commit.
	 */
	#dropPendingHistory(error: string | null): void {
		const pending = this.#pendingHistory;
		if (pending === null) return;
		clearTimeout(pending.timer);
		pending.fragments.reset();
		this.#pendingHistory = null;
		if (this.#history !== null) this.#history = { ...this.#history, loading: false, error };
	}

	/** Send the next slice request of `pending`, from its `offset`, under a fresh reqId and idle timer. */
	#requestValueSlice(pending: PendingValue): void {
		const reqId = ++this.#reqSeq;
		pending.timer = setTimeout(() => {
			if (this.#pendingValues.get(reqId) !== pending) return;
			this.#pendingValues.delete(reqId);
			pending.resolve({ kind: "error", message: "timed out loading the full value" });
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
		this.#pendingValues.set(reqId, pending);
		this.#socket.send({
			t: "fetch-value",
			reqId,
			entryId: pending.entryId,
			path: pending.path,
			hash: pending.hash,
			offset: pending.offset,
		});
	}

	/** Resolve every value transfer in flight with `message`; late slices are then ignored. */
	#failPendingValues(message: string): void {
		for (const pending of this.#pendingValues.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ kind: "error", message });
		}
		this.#pendingValues.clear();
	}

	/** Resolve every transcript read in flight as transient (`null`), so its poller retries. */
	#failPendingTranscripts(): void {
		for (const pending of this.#pendingTranscripts.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
	}

	#resetTransfers(): void {
		this.#compactionFragments.reset();
		this.#transfers.clear();
		this.#orderedFrames = [];
		this.#transferBytes = 0;
	}

	#failPendingActions(message: string): void {
		for (const pending of this.#pendingRewinds.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.#pendingRewinds.clear();
		for (const pending of this.#pendingForks.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.#pendingForks.clear();
		for (const pending of this.#pendingSnapcompactions.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("snapcompact result is unknown; check the session before retrying"));
		}
		this.#pendingSnapcompactions.clear();
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			const reason = this.#transfers.size > 0
				? "timed out waiting for compaction fragments"
				: "timed out waiting for the host's session snapshot";
			if (this.#phase === "live" && this.#pendingSnapshot === null) this.#rejoin(reason);
			else this.#end(reason);
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** A running command's result can't arrive over a new connection; the host may still have run it. */
	#failRunningCommand(): void {
		if (this.#command?.status !== "running") return;
		this.#command = {
			...this.#command,
			status: "error",
			output:
				"Connection to the host dropped before the result arrived; the command may still have run on the host.",
		};
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "compaction-fragment" && frame.scope === "history") {
				if (this.#pendingHistory === null) {
					this.#rejoin(`failed to apply session data: ${err instanceof Error ? err.message : String(err)}`);
					return;
				}
				this.#dropPendingHistory("failed to load earlier messages");
				this.#commit();
				return;
			}
			if (
				frame.t === "compaction-fragment" ||
				frame.t === "snapshot-chunk" ||
				frame.t === "entry" ||
				frame.t === "leaf" ||
				this.#transfers.size > 0 ||
				frame.t === "welcome" ||
				frame.t === "history"
			) {
				const reason = `failed to apply session data: ${err instanceof Error ? err.message : String(err)}`;
				if (this.#everWelcomed) this.#rejoin(reason);
				else this.#end(reason);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		if (this.#pendingSnapshot) {
			if (frame.t === "snapshot-chunk" || (frame.t === "compaction-fragment" && frame.scope === "snapshot")) {
				this.#snapshotPrefixRemaining = 0;
			} else if (frame.t === "ui-request" && this.#snapshotPrefixRemaining > 0) {
				this.#snapshotPrefixRemaining--;
				this.#armSnapshotProgressTimer();
			}
		}
		if (frame.t === "compaction-fragment" && this.#staleTransfers.has(frame.transferId)) {
			if (frame.part === frame.parts - 1) this.#staleTransfers.delete(frame.transferId);
			return;
		}
		if (
			!this.#welcomed &&
			(frame.t === "entry" ||
				frame.t === "snapshot-chunk" ||
				frame.t === "leaf" ||
				frame.t === "compaction-fragment")
		) {
			if (frame.t === "compaction-fragment" && frame.part < frame.parts - 1) {
				if (this.#staleTransfers.size >= 128) throw new Error("too many stale transfers");
				this.#staleTransfers.add(frame.transferId);
			}
			// The next welcome describes the current session state.
			return;
		}
		if (
			!this.#drainingFrames &&
			this.#orderedFrames.length > 0 &&
			(frame.t === "entry" || frame.t === "snapshot-chunk" || frame.t === "leaf")
		) {
			if (this.#orderedFrames.length >= 4096) throw new Error("too many frames waiting for compaction");
			this.#orderedFrames.push({ kind: "frame", frame });
			return;
		}
		switch (frame.t) {
			case "welcome": {
				const agents = [...frame.agents];
				const working = frame.state.isStreaming;
				this.#resetTransfers();
				this.#snapshotPrefixRemaining = 64;
				// A fresh welcome (first join or reconnect) restarts the snapshot.
				// Entries already on screen stay until the new snapshot replaces
				// them once complete, so a resync never blanks the transcript.
				this.#header = frame.header;
				this.#hasHostLeaf = frame.leafId !== undefined;
				this.#hostLeafId = frame.leafId ?? null;
				this.#canRewind = frame.rewind === true && frame.readOnly !== true;
				this.#canSnapcompactFrom = frame.snapcompactFrom === true && frame.readOnly !== true;
				if (frame.entryCount === 0) {
					if (this.#hostLeafId !== null) throw new Error("snapshot leaf is missing");
					this.#entries = [];
					this.#publishedEntries = [];
					this.#pendingSnapshot = null;
				} else {
					this.#pendingSnapshot = { entries: [], live: [], total: frame.entryCount };
				}
				// Pages requested before this welcome describe the old replica.
				this.#dropPendingHistory(null);
				// So are values and transcripts: the host dropped their queued
				// replies with the old join.
				this.#failPendingValues("the session reloaded; try again");
				this.#failPendingTranscripts();
				// Tail join: `history` pages in what the tail left out.
				this.#history = frame.history
					? {
							startId: frame.history.startId,
							hasEarlier: frame.history.hasEarlier,
							loading: false,
							error: null,
						}
					: null;
				this.#failPendingActions("the host session reloaded; try again");
				this.#state = frame.state;
				this.#agents = agents;
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#unlistedBusIds.clear();
				this.#working = working;
				this.#readOnly = frame.readOnly === true;
				this.#clearUiRequests();
				// The host re-advertises commands after every welcome.
				this.#commands = null;
				this.#failRunningCommand();
				this.#welcomed = true;
				this.#rejoining = false;
				this.#everWelcomed = true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			}
			case "compaction-fragment": {
				if (frame.scope === "history") {
					const pending = this.#pendingHistory;
					if (pending?.reqId !== frame.reqId) return;
					let slot = pending.transfers.get(frame.transferId);
					if (!slot) {
						if (pending.entries.length >= 4096) throw new Error("too many history fragments");
						slot = { transferId: frame.transferId };
						pending.transfers.set(frame.transferId, slot);
						pending.entries.push(slot);
					} else if (slot.entry !== undefined) {
						throw new Error("duplicate completed history transfer");
					}
					const entry = pending.fragments.accept(frame);
					if (entry !== undefined) slot.entry = entry;
					clearTimeout(pending.timer);
					pending.timer = this.#historyTimer(pending.reqId);
					if (pending.final && !pending.fragments.pending) {
						const final = pending.final;
						pending.final = null;
						this.#applyFrame(final);
					}
					return;
				}
				if (frame.scope === "snapshot" && this.#pendingSnapshot === null) {
					throw new Error("unexpected snapshot compaction fragment");
				}
				let transfer = this.#transfers.get(frame.transferId);
				if (!transfer) {
					if (
						this.#orderedFrames.length >= 4096 ||
						this.#transferBytes + frame.byteLength > 2 * MAX_COMPACTION_FRAGMENT_BYTES
					) {
						throw new Error("too much pending compaction data");
					}
					transfer = { kind: "transfer", id: frame.transferId, scope: frame.scope, bytes: frame.byteLength };
					this.#transfers.set(frame.transferId, transfer);
					this.#orderedFrames.push(transfer);
					this.#transferBytes += frame.byteLength;
				} else if (transfer.entry !== undefined) {
					throw new Error("duplicate completed compaction transfer");
				}
				const entry = this.#compactionFragments.accept(frame);
				if (entry !== undefined) transfer.entry = entry;
				this.#armSnapshotProgressTimer();
				this.#drainingFrames = true;
				try {
					while (this.#orderedFrames.length > 0) {
						const next = this.#orderedFrames[0];
						if (next.kind === "transfer" && next.entry === undefined) break;
						this.#orderedFrames.shift();
						if (next.kind === "frame") {
							this.#applyFrame(next.frame);
						} else {
							this.#transfers.delete(next.id);
							this.#transferBytes -= next.bytes;
							this.#applyFrame(
								next.scope === "snapshot"
									? { t: "snapshot-chunk", entries: [next.entry!], final: false }
									: { t: "entry", entry: next.entry! },
							);
						}
					}
				} finally {
					this.#drainingFrames = false;
				}
				if (this.#transfers.size === 0 && this.#pendingSnapshot === null) this.#clearSnapshotProgressTimer();
				else this.#armSnapshotProgressTimer();
				return;
			}
			case "snapshot-chunk": {
				// Buffer fragments and publish the transcript once, when the
				// snapshot completes (as the TUI guest does). Intermediate chunks
				// only advance `loading`: publishing entries per chunk re-renders
				// the transcript per chunk, and a 50 MB session is ~100 chunks.
				const pending = this.#pendingSnapshot;
				if (pending === null) {
					if (frame.entries.length > 0) throw new Error("unexpected snapshot entries");
					return;
				}
				const received = pending.entries.length + frame.entries.length;
				if (received > pending.total || (frame.final && received !== pending.total)) {
					throw new Error("snapshot entry count does not match welcome");
				}
				pending.entries.push(...frame.entries);
				// Complete on `final` or once every promised entry arrived, so a
				// lost final chunk doesn't strand a fully received transcript.
				if (!frame.final && pending.entries.length < pending.total) {
					this.#armSnapshotProgressTimer();
					break;
				}
				this.#entries = pending.entries;
				this.#entries.push(...pending.live);
				this.#pendingSnapshot = null;
				this.#publishActiveBranch();
				this.#clearSnapshotProgressTimer();
				this.#phase = "live";
				break;
			}
			case "entry":
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				if (this.#hasHostLeaf) this.#hostLeafId = frame.entry.id;
				if (this.#pendingSnapshot !== null) {
					this.#pendingSnapshot.live.push(frame.entry);
					break;
				}
				this.#entries.push(frame.entry);
				this.#publishAppendedEntry(frame.entry);
				break;
			case "leaf":
				this.#hasHostLeaf = true;
				this.#hostLeafId = frame.leafId;
				if (this.#pendingSnapshot === null) this.#publishActiveBranch();
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				this.#pruneBusMaps();
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "history": {
				const pending = this.#pendingHistory;
				// A reply to a request dropped by a timeout, close or re-welcome.
				if (pending?.reqId !== frame.reqId) return;
				if (frame.error !== undefined) {
					if (frame.error === "stale") {
						// The cursor left the host's active branch (tree navigation,
						// a discarded entry), so this replica is no longer a suffix of
						// the host's: join again for the current tail. The previous
						// entries, and the spinner, stay up until it lands, and the
						// replica stays live: errors meanwhile are notices, not a
						// refused join.
						this.#dropPendingHistory(null);
						if (this.#history !== null) this.#history = { ...this.#history, loading: true };
						this.#pushNotice("info", "the host's history changed; reloaded the latest messages");
						this.#rejoining = true;
						this.#armWelcomeTimer();
						this.#sendHello();
					} else {
						this.#dropPendingHistory(frame.error);
					}
					break;
				}
				pending.entries.push(...frame.entries.map(entry => ({ entry })));
				if (frame.final && pending.fragments.pending) {
					pending.final = { ...frame, entries: [] };
					clearTimeout(pending.timer);
					pending.timer = this.#historyTimer(pending.reqId);
					return;
				}
				if (!frame.final) {
					clearTimeout(pending.timer);
					pending.timer = this.#historyTimer(pending.reqId);
					return;
				}
				// A conforming host never repeats rows the guest holds, nor answers
				// "more to come" with nothing: drop overlap so ids stay unique, and
				// treat a page that adds nothing as an error, so the near-top
				// loader stops instead of re-requesting the same cursor forever.
				const held = new Set(this.#entries.map(entry => entry.id));
				const page = pending.entries.map(slot => slot.entry!).filter(entry => !held.has(entry.id));
				if (page.length === 0 && frame.hasEarlier === true) {
					this.#dropPendingHistory("the host sent no earlier messages");
					break;
				}
				this.#dropPendingHistory(null);
				this.#entries = [...page, ...this.#entries];
				if (this.#history !== null) {
					this.#history = {
						startId: page[0]?.id ?? this.#history.startId,
						hasEarlier: frame.hasEarlier === true,
						loading: false,
						error: null,
					};
				}
				this.#publishActiveBranch();
				break;
			}
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "value": {
				const pending = this.#pendingValues.get(frame.reqId);
				// A reply to a slice that already failed (timeout, close, re-welcome).
				if (pending === undefined) return;
				this.#pendingValues.delete(frame.reqId);
				clearTimeout(pending.timer);
				if (frame.error !== undefined) {
					if (frame.error !== "stale") {
						pending.resolve({ kind: "error", message: frame.error });
						return;
					}
					this.#pushNotice("warning", STALE_VALUE_MESSAGE);
					pending.resolve({ kind: "error", message: STALE_VALUE_MESSAGE });
					break;
				}
				if (frame.offset !== pending.offset || (!frame.final && frame.data.length === 0)) {
					pending.resolve({ kind: "error", message: "malformed value reply" });
					return;
				}
				pending.slices.push(frame.data);
				pending.offset += frame.data.length;
				if (!frame.final) {
					this.#requestValueSlice(pending);
					return;
				}
				try {
					pending.resolve({ kind: "value", value: JSON.parse(pending.slices.join("")) });
				} catch {
					pending.resolve({ kind: "error", message: "the loaded value is not valid JSON" });
				}
				return;
			}
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "commands":
				this.#commands = frame.commands;
				break;
			case "command-result":
				if (this.#command?.reqId === frame.reqId && this.#command.status === "running") {
					this.#command =
						frame.error !== undefined
							? { ...this.#command, status: "error", output: frame.error }
							: { ...this.#command, status: "done", output: frame.output ?? "" };
				}
				break;
			case "rewind-result": {
				const pending = this.#pendingRewinds.get(frame.reqId);
				if (!pending) return;
				this.#pendingRewinds.delete(frame.reqId);
				clearTimeout(pending.timer);
				if (frame.error !== undefined) pending.reject(new Error(frame.error));
				else pending.resolve({ draft: frame.draft, images: frame.images, replaceDraft: frame.replaceDraft });
				break;
			}
			case "fork-result": {
				const pending = this.#pendingForks.get(frame.reqId);
				if (!pending) return;
				this.#pendingForks.delete(frame.reqId);
				clearTimeout(pending.timer);
				if (frame.error !== undefined) pending.reject(new Error(frame.error));
				else pending.resolve();
				break;
			}
			case "snapcompact-from-result": {
				const pending = this.#pendingSnapcompactions.get(frame.reqId);
				if (!pending) return;
				this.#pendingSnapcompactions.delete(frame.reqId);
				clearTimeout(pending.timer);
				if (frame.error !== undefined) pending.reject(new Error(frame.error));
				else pending.resolve();
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error": {
				if (frame.resync) {
					if (this.#phase === "ended" || this.#welcomeTimer !== null) break;
					this.#rejoin(frame.message);
					return;
				}
				const fallback = collabProtoFallback(frame.message, this.#helloProto);
				if (fallback !== undefined) {
					this.#helloProto = fallback;
					this.#sendHello();
					return;
				}
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			}
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		if (isCoalescable(frame)) this.#scheduleCommit();
		else this.#commit();
	}

	/**
	 * Drops progress/lifecycle payloads of agents the host no longer lists.
	 * A key missing from this `agents` frame is pruned when it was already
	 * missing from the previous one; the one-frame grace covers progress that
	 * outran its agent's registration.
	 */
	#pruneBusMaps(): void {
		if (this.#progress.size === 0 && this.#lifecycle.size === 0) {
			this.#unlistedBusIds.clear();
			return;
		}
		const listed = new Set<string>();
		for (const agent of this.#agents) listed.add(agent.id);
		const previouslyUnlisted = this.#unlistedBusIds;
		const unlisted = new Set<string>();
		const prune = <V>(map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
			let kept: Map<string, V> | null = null;
			for (const [id, value] of map) {
				const drop = !listed.has(id) && previouslyUnlisted.has(id);
				if (!listed.has(id) && !drop) unlisted.add(id);
				if (drop && kept === null) {
					kept = new Map();
					for (const [keptId, keptValue] of map) {
						if (keptId === id) break;
						kept.set(keptId, keptValue);
					}
				} else if (!drop && kept !== null) {
					kept.set(id, value);
				}
			}
			return kept ?? map;
		};
		this.#progress = prune(this.#progress);
		this.#lifecycle = prune(this.#lifecycle);
		this.#unlistedBusIds = unlisted;
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				if (
					event.level !== "info" ||
					event.source !== "collab" ||
					!/^.+ joined the collab session(?: \(read-only\))?$/.test(event.message)
				) {
					this.#pushNotice(event.level, event.message);
				}
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#publishAppendedEntry(entry: SessionEntry): void {
		if (!this.#hasHostLeaf) {
			this.#publishedEntries = [...this.#entries];
			return;
		}
		const activeTail = this.#publishedEntries.at(-1);
		if (entry.parentId === (activeTail?.id ?? null)) {
			this.#publishedEntries = [...this.#publishedEntries, entry];
			return;
		}
		this.#publishActiveBranch();
	}

	#publishActiveBranch(): void {
		if (!this.#hasHostLeaf) {
			this.#publishedEntries = [...this.#entries];
			return;
		}
		if (this.#hostLeafId === null) {
			this.#publishedEntries = [];
			return;
		}

		const byId = new Map(this.#entries.map(entry => [entry.id, entry]));
		let id: string | null = this.#hostLeafId;
		const seen = new Set<string>();
		const branch: SessionEntry[] = [];
		while (id !== null) {
			if (seen.has(id)) throw new Error("session ancestry contains a cycle");
			seen.add(id);
			const entry = byId.get(id);
			if (!entry) {
				if (this.#history?.hasEarlier && branch.at(-1)?.id === this.#history.startId) break;
				throw new Error(`session ancestry is missing entry ${id}`);
			}
			branch.push(entry);
			id = entry.parentId;
		}
		branch.reverse();
		this.#publishedEntries = branch;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			canRewind: this.#canRewind,
			canSnapcompactFrom: this.#canSnapcompactFrom,
			uiRequest: this.#uiRequest,
			notices: this.#notices,
			commands: this.#commands,
			command: this.#command,
			loading: this.#pendingSnapshot && {
				received: this.#pendingSnapshot.entries.length,
				total: this.#pendingSnapshot.total,
			},
			history: this.#history,
		};
	}

	/** Publishes on the next animation frame; a synchronous commit before then supersedes it. */
	#scheduleCommit(): void {
		if (this.#cancelFrameCommit !== null) return;
		this.#cancelFrameCommit = scheduleFrame(() => {
			this.#cancelFrameCommit = null;
			this.#commit();
		});
	}

	#commit(): void {
		if (this.#cancelFrameCommit !== null) {
			this.#cancelFrameCommit();
			this.#cancelFrameCommit = null;
		}
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
