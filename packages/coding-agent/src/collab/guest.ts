/**
 * Guest side of a collab live session.
 *
 * `/join <link>` writes the host's snapshot to a replica session file and
 * drives it through the normal `/resume` machinery, then applies live frames:
 * entries → SessionManager + agent.replaceMessages, events →
 * EventController.handleEvent, state → status-line overrides plus real
 * model/thinking state applied to the replica agent. Lifecycle-relevant
 * mirrored events additionally reach the local extension runner, so
 * lifecycle integrations (Herdr pane state, RPC trackers, stats) observe host
 * activity even though the guest's own agent loop never runs. The host's
 * subagent ecosystem is mirrored too: agent snapshots populate a local
 * AgentRegistry (Agent Hub), EventBus traffic (observer HUD) is republished,
 * and hub actions (chat/kill/revive/transcript reads) round-trip over the
 * wire. Host ask dialogs (`ui-request` select/editor) present through the
 * same hook selector/editor seam and answer with `ui-response`;
 * `ui-request-end` dismisses a pending presentation without responding.
 * Everything renders through the same components, so ctrl+o, theming, and
 * transcript behavior are native by construction.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ImageContent } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, logger, toError } from "@oh-my-pi/pi-utils";
import {
	COMPACTION_FRAGMENT_CHARS,
	CompactionFragmentAssembler,
	MAX_COMPACTION_FRAGMENT_BYTES,
	takeAutoRejoin,
} from "@oh-my-pi/pi-wire";
import type { AgentHubRemote, AgentHubRemoteTranscript } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { InteractiveModeContext } from "../modes/types";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { fromWireEvent } from "../session/loop-end-wire";
import type { SessionEntry } from "../session/session-entries";
import { mintSessionId, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { emitSubagentFrame } from "../utils/event-bus";
import { GuestLifecycleEmitter } from "../extensibility/extensions/lifecycle-mirror";
import { setSessionTerminalTitle } from "../utils/title-generator";
import { importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabSessionState,
	type CollabUiRequest,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";

/** Commands a guest may run locally; everything else is host-only. */
export const COLLAB_GUEST_ALLOWED_COMMANDS: Record<string, true> = {
	dump: true,
	export: true,
	copy: true,
	// Opens a link in the guest's own browser; nothing reaches the host.
	open: true,
	help: true,
	hotkeys: true,
	theme: true,
	settings: true,
	leave: true,
	collab: true,
	exit: true,
	quit: true,
};
/**
 * How long the guest waits for the host's small `welcome` frame before giving
 * up on the join. The welcome carries metadata only (`entryCount`, header,
 * state, agents), so it lands well under one second on any working relay.
 */
const WELCOME_TIMEOUT_MS = 30_000;
/**
 * How long the guest waits between `snapshot-chunk` frames during the initial
 * sync. Resets on each chunk arrival, so a multi-MB snapshot only fails when
 * the relay genuinely stalls — not because the total wall-clock crossed the
 * welcome budget. The default relay sustains ~350 KB/s; a 512 KB chunk lands
 * in under two seconds with comfortable headroom.
 */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
const TRANSCRIPT_TIMEOUT_MS = 20_000;

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
type SnapshotChunkFrame = Extract<CollabFrame, { t: "snapshot-chunk" }>;
type QueuedReplication =
	| { frame: CollabFrame; size: number }
	| { transferId: string; scope: "snapshot" | "live"; reserved: number; entry?: SessionEntry };

/** Accumulator for an in-flight chunked welcome — see {@link CollabGuestLink}. */
interface PendingSnapshot {
	header: WelcomeFrame["header"];
	state: WelcomeFrame["state"];
	agents: AgentSnapshot[];
	readOnly: boolean;
	canRewind: boolean;
	entryCount: number;
	entries: SessionEntry[];
	isResync: boolean;
	leafId?: string | null;
}

/** Minimal context surface the idle-state reconciler mutates. */
export interface GuestIdleReconcilerCtx {
	statusLine: { markActivityEnd: () => void };
	statusContainer: Pick<InteractiveModeContext["statusContainer"], "disposeChildren">;
	loadingAnimation: { stop: () => void } | undefined;
}

/**
 * Close the guest UI state held open by an earlier `agent_start` whose
 * matching `agent_end` never reached us — most often because a reconnect
 * dropped the event mid-stream. Reached via {@link reconcileGuestSnapshotHostState}
 * (the live `state`-frame and welcome/resync reconciler) when the host reports `isStreaming === false`:
 * folds the in-flight active-time window into the per-session meter (so
 * `time_spent` stops ticking) and stops the `Working…` loader if one is
 * still animating. No-op when the host is still streaming.
 *
 * Exported for direct unit testing; mutates the loader field on `ctx` so
 * the same loader is not stopped twice on subsequent reconciliations.
 */
export function reconcileGuestIdleHostState(ctx: GuestIdleReconcilerCtx, isStreaming: boolean): void {
	if (isStreaming) return;
	ctx.statusLine.markActivityEnd();
	if (ctx.loadingAnimation) {
		ctx.loadingAnimation.stop();
		ctx.loadingAnimation = undefined;
		ctx.statusContainer.disposeChildren();
	}
}

/** Reconcile a welcome/resync snapshot's host activity state into the guest meter. */
export interface GuestSnapshotActivityReconcilerCtx extends GuestIdleReconcilerCtx {
	statusLine: GuestIdleReconcilerCtx["statusLine"] & { markActivityStart: () => void };
	/**
	 * Start (or re-attach) the live "Working…" loader. Mirrors
	 * `InteractiveModeContext.ensureLoadingAnimation`, which is what
	 * `EventController` calls on `agent_start`. Required so a guest that
	 * missed an earlier `agent_start` (a reconnect dropped it mid-stream)
	 * starts its spinner when the host later reports it is streaming.
	 */
	ensureLoadingAnimation: InteractiveModeContext["ensureLoadingAnimation"];
	autoCompactionLoader: InteractiveModeContext["autoCompactionLoader"];
	retryLoader: InteractiveModeContext["retryLoader"];
}

/** Status-area state which cannot outlive removal of its child components. */
export interface GuestTransientStatusCtx {
	statusContainer: Pick<InteractiveModeContext["statusContainer"], "clear">;
	autoCompactionLoader: InteractiveModeContext["autoCompactionLoader"];
	retryLoader: InteractiveModeContext["retryLoader"];
}

/** Stop and forget status-area loaders before detaching their components. */
export function clearGuestTransientStatus(ctx: GuestTransientStatusCtx): void {
	if (ctx.autoCompactionLoader) {
		ctx.autoCompactionLoader.stop();
		ctx.autoCompactionLoader = undefined;
	}
	if (ctx.retryLoader) {
		ctx.retryLoader.stop();
		ctx.retryLoader = undefined;
	}
	ctx.statusContainer.clear();
}

export function reconcileGuestSnapshotHostState(ctx: GuestSnapshotActivityReconcilerCtx, isStreaming: boolean): void {
	if (isStreaming) {
		ctx.statusLine.markActivityStart();
		if (!ctx.autoCompactionLoader && !ctx.retryLoader) ctx.ensureLoadingAnimation();
		return;
	}
	reconcileGuestIdleHostState(ctx, false);
}

/** Streamed text of a text or thinking block; `undefined` for blocks speech never reads. */
function streamedText(block: AssistantMessage["content"][number] | undefined): string | undefined {
	if (block?.type === "text") return block.text;
	if (block?.type === "thinking") return block.thinking;
	return undefined;
}

/**
 * Text and thinking deltas that grew `message` past `previous` without arriving
 * in `own`, the update's own delta. Non-empty only when the host superseded the
 * updates in between (#16956); one delta per grown block, in block order.
 */
function omittedStreamDeltas(
	previous: AssistantMessage,
	message: AssistantMessage,
	own: AssistantMessageEvent,
): AssistantMessageEvent[] {
	const omitted: AssistantMessageEvent[] = [];
	for (const [contentIndex, block] of message.content.entries()) {
		const text = streamedText(block);
		if (text === undefined) continue;
		const prior = previous.content[contentIndex];
		const start = prior?.type === block.type ? (streamedText(prior)?.length ?? 0) : 0;
		const ownsTail =
			(own.type === "text_delta" || own.type === "thinking_delta") &&
			own.contentIndex === contentIndex &&
			own.type === `${block.type}_delta`;
		const end = text.length - (ownsTail ? own.delta.length : 0);
		if (end <= start) continue;
		const delta = text.slice(start, end);
		omitted.push(
			block.type === "text"
				? { type: "text_delta", contentIndex, delta, partial: message }
				: { type: "thinking_delta", contentIndex, delta, partial: message },
		);
	}
	return omitted;
}

export class CollabGuestLink {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket | null = null;
	#roomId = "";
	/**
	 * This guest's replica: its own session id and file for the guest's
	 * lifetime. Ownership is keyed by session id, so the replica must not reuse
	 * the host's id (a guest on the host's machine would contend with the
	 * host), must not change on a resync (a lease handoff would leave the file
	 * briefly unowned), and must not share a file with another local guest of
	 * the same room.
	 */
	readonly #replicaId = mintSessionId();
	/**
	 * The replica's ownership lease, held from the first snapshot write until
	 * the guest has left. Opening and reloading the replica never claims it, so
	 * without this an idle guest would leave its live replica unowned (and
	 * collectable by `omp gc`).
	 */
	#replicaLease: (() => void) | undefined;
	/** Previous session file to restore on leave; null = previous session was unsaved. */
	#returnSessionFile: string | null = null;
	/** Frames apply strictly in arrival order through this chain. */
	#applyChain: Promise<void> = Promise.resolve();
	#connectionGeneration = 0;
	#syncGeneration = 0;
	/** True after the initial snapshot has been written to disk and resumed. */
	#welcomed = false;
	#autoRejoins: number[] = [];
	#left = false;
	#replicaActivated = false;
	/** One owner spans cancellation, queued snapshot work, and local restoration. */
	#restoration: Promise<boolean> | undefined;
	/**
	 * Buffer for the in-flight chunked welcome. Set by the small `welcome`
	 * frame, accumulated by every `snapshot-chunk`, drained when the final
	 * chunk lands (or the snapshot-progress timer fires).
	 */
	#pendingSnapshot: PendingSnapshot | null = null;
	readonly #compactionFragments = new CompactionFragmentAssembler();
	#snapshotQueue: QueuedReplication[] = [];
	#liveQueue: QueuedReplication[] = [];
	#fragmentSlots = new Map<string, Extract<QueuedReplication, { transferId: string }>>();
	#staleTransfers = new Set<string>();
	#reservedFragmentBytes = 0;
	#deferredBytes = 0;
	/** Rejects the initial join if synchronization fails. */
	#joinReject: ((err: Error) => void) | null = null;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	#welcomeTimerVersion = 0;
	#snapshotProgressVersion = 0;
	#fragmentProgressTimer: Timer | null = null;
	#fragmentProgressVersion = 0;
	/** Timeout handlers set during join, used for the initial sync and rejoins. */
	#onWelcomeTimeout: (() => void) | null = null;
	#onSnapshotTimeout: (() => void) | null = null;
	#requestRejoin: ((message: string) => void) | null = null;
	/** base64url write token from a full link; absent when joined via a view link. */
	#writeToken: string | undefined;
	/** True when the host marked this peer read-only (view link). */
	#readOnly = false;
	/** True when the host advertises writable transcript rewind. */
	#canRewind = false;
	/** False until the first assistant message_start (real or synthesized) since (re)sync. */
	#assistantStreamSynced = false;
	/** Last snapshot received for the streaming assistant message; diffed against the next update. */
	#streamedSnapshot: AssistantMessage | undefined;
	/** Mirrors host lifecycle events into the local extension runner while joined. */
	#lifecycleEmitter = new GuestLifecycleEmitter();
	state: CollabSessionState | null = null;
	/** Local mirror of the host's agent ecosystem (refs carry `session: null`). */
	readonly agentRegistry = new AgentRegistry();
	/** Per-agent `hasSessionFile` from the last snapshot; gates remote transcript fetches. */
	#agentHasTranscript = new Map<string, boolean>();
	#pendingTranscripts = new Map<number, (r: AgentHubRemoteTranscript | null) => void>();
	/** Host `ui-request`s presented (or queued) locally, keyed by reqId; aborting dismisses. */
	#pendingUiRequests = new Map<number, AbortController>();
	#nextReqId = 1;
	/** Rewind requests awaiting their targeted host result. */
	#pendingRewinds = new Map<number, boolean>();
	#nextRewindReqId = 1;
	readonly #hubRemote: AgentHubRemote = {
		chat: (id, text) => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "chat", agentId: id, text });
		},
		kill: id => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "kill", agentId: id });
		},
		revive: id => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "revive", agentId: id });
		},
		readTranscript: (id, fromByte) => {
			const socket = this.#socket;
			if (!socket || this.#agentHasTranscript.get(id) === false) {
				return Promise.resolve(null);
			}
			const reqId = this.#nextReqId++;
			const { promise, resolve } = Promise.withResolvers<AgentHubRemoteTranscript | null>();
			const timer = setTimeout(() => {
				this.#pendingTranscripts.delete(reqId);
				resolve(null);
			}, TRANSCRIPT_TIMEOUT_MS);
			this.#pendingTranscripts.set(reqId, result => {
				clearTimeout(timer);
				resolve(result);
			});
			socket.send({ t: "fetch-transcript", reqId, agentId: id, fromByte });
			return promise;
		},
	};

	/** Agent Hub actions routed to the host over the wire. */
	get hubRemote(): AgentHubRemote {
		return this.#hubRemote;
	}

	/** True when this guest joined through a read-only (view) link. */
	get readOnly(): boolean {
		return this.#readOnly;
	}
	/** True when the host supports writable transcript rewind for this guest. */
	get canRewind(): boolean {
		return this.#canRewind && !this.#readOnly;
	}

	/** Shows the read-only status hint when applicable; true when the action must be dropped. */
	#rejectReadOnly(): boolean {
		if (!this.#readOnly) return false;
		this.#ctx.showStatus("This collab link is read-only");
		return true;
	}

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	async join(link: string): Promise<void> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		if (this.#ctx.collabGuest || this.#left) throw new Error("Already in a collab session (/leave first)");
		this.#roomId = parsed.roomId;
		this.#writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		this.#returnSessionFile = this.#ctx.sessionManager.getSessionFile() ?? null;
		// Claim the process before any async setup or replica session transition.
		this.#ctx.setCollabGuest(this);
		let key: CryptoKey;
		try {
			key = await importRoomKey(parsed.key);
			if (this.#left) throw new Error("Collab join cancelled");
		} catch (err) {
			await this.#restoreLocalSession();
			throw err;
		}

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		this.#socket = socket;

		const firstWelcome = Promise.withResolvers<void>();
		let connectionOpen = false;
		let joined = false;
		this.#joinReject = err => firstWelcome.reject(err);

		const finishJoin = (): void => {
			if (joined || this.#left) return;
			joined = true;
			firstWelcome.resolve();
		};
		const rejoin = (message: string, preserveOnLimit = false): void => {
			if (this.#left) return;
			if (!takeAutoRejoin(this.#autoRejoins)) {
				if (joined) {
					this.#ctx.showError(`Collab host: ${message}`);
					if (!preserveOnLimit || !this.#welcomed) this.#restoreAfterDisconnect();
				} else {
					firstWelcome.reject(new Error(message));
				}
				return;
			}
			this.#ctx.showStatus(`Collab host: ${message}; rejoining…`, { dim: true });
			this.#clearUiRequests();
			this.#sendHello(socket);
		};
		this.#requestRejoin = rejoin;
		this.#onSnapshotTimeout = () => {
			const message = "timed out waiting for the host's session snapshot";
			if (joined) rejoin(message);
			else firstWelcome.reject(new Error(message));
		};
		this.#onWelcomeTimeout = () => {
			const message = "timed out waiting for the host's welcome";
			if (joined) rejoin(message);
			else firstWelcome.reject(new Error(message));
		};


		socket.onOpen = () => {
			connectionOpen = true;
			const generation = this.#connectionGeneration;
			this.#applyChain = this.#applyChain.then(() => {
				if (generation === this.#connectionGeneration) this.#sendHello(socket);
			});
		};
		const drainQueued = async (generation: number): Promise<void> => {
			const syncGeneration = this.#syncGeneration;
			while (!this.#left && generation === this.#connectionGeneration && syncGeneration === this.#syncGeneration) {
				const snapshot = this.#pendingSnapshot !== null;
				if (!snapshot && !this.#welcomed) return;
				const queue = snapshot ? this.#snapshotQueue : this.#liveQueue;
				const item = queue[0];
				if (!item || ("transferId" in item && !item.entry)) return;
				queue.shift();
				let frame: CollabFrame;
				if ("transferId" in item) {
					this.#fragmentSlots.delete(item.transferId);
					this.#reservedFragmentBytes -= item.reserved;
					frame = snapshot
						? { t: "snapshot-chunk", entries: [item.entry!], final: false }
						: { t: "entry", entry: item.entry! };
				} else {
					this.#deferredBytes -= item.size;
					frame = item.frame;
				}
				if (snapshot) {
					if (frame.t !== "snapshot-chunk") throw new Error("Invalid snapshot frame");
					if (this.#accumulateSnapshotChunk(frame)) {
						this.#discardSnapshotTail();
						await this.#finalizeSnapshot(generation);
						if (this.#welcomed && generation === this.#connectionGeneration) finishJoin();
					}
				} else {
					await this.#applyFrame(frame);
				}
			}
		};
		const processFrame = async (frame: CollabFrame, generation: number): Promise<void> => {
			try {
				if (this.#left || generation !== this.#connectionGeneration) return;
				if (frame.t === "compaction-fragment") {
					if (this.#staleTransfers.has(frame.transferId)) {
						if (frame.part === frame.parts - 1) this.#staleTransfers.delete(frame.transferId);
						return;
					}
					if (!this.#welcomed && !this.#pendingSnapshot) {
						if (frame.part < frame.parts - 1) this.#rememberStaleTransfer(frame.transferId);
						return;
					}
				}
				if (
					joined &&
					!this.#welcomed &&
					!this.#pendingSnapshot &&
					(frame.t === "entry" || frame.t === "leaf" || frame.t === "event")
				)
					return;
				if (frame.t === "bye") {
					this.#applyFrame(frame);
					return;
				}
				if (frame.t === "welcome") {
					this.#clearWelcomeTimer();
					this.#beginWelcome(frame, joined);
					if (frame.entryCount === 0) {
						this.#discardSnapshotTail();
						await this.#finalizeSnapshot(generation);
						if (this.#welcomed && generation === this.#connectionGeneration) finishJoin();
					}
				} else if (frame.t === "error" && frame.resync) {
					if (this.#welcomeTimer === null) rejoin(frame.message, true);
					return;
				} else if (frame.t === "error" && !this.#welcomed) {
					this.#clearWelcomeTimer();
					if (joined) {
						this.#ctx.showError(`Collab host: ${frame.message}`);
						this.#restoreAfterDisconnect();
					} else firstWelcome.reject(new Error(frame.message));
					return;
				} else if (frame.t === "compaction-fragment") {
					if (frame.scope === "history") throw new Error("Unexpected history fragment");
					let slot = this.#fragmentSlots.get(frame.transferId);
					if (slot && slot.entry) throw new Error("Duplicate compaction transfer");
					const reserved = Math.min(frame.byteLength, frame.parts * COMPACTION_FRAGMENT_CHARS) * 2;
					if (
						!slot &&
						this.#reservedFragmentBytes + this.#deferredBytes + reserved >
							2 * MAX_COMPACTION_FRAGMENT_BYTES + 128 * 2 * COMPACTION_FRAGMENT_CHARS
					) {
						throw new Error("Compaction transfers exceed memory limit");
					}
					const entry = this.#compactionFragments.accept(frame) as SessionEntry | undefined;
					if (!slot) {
						slot = { transferId: frame.transferId, scope: frame.scope, reserved };
						this.#fragmentSlots.set(frame.transferId, slot);
						this.#reservedFragmentBytes += reserved;
						(frame.scope === "snapshot" ? this.#snapshotQueue : this.#liveQueue).push(slot);
					}
					if (entry) slot.entry = entry;
					if (frame.scope === "snapshot" && this.#pendingSnapshot) this.#armSnapshotProgressTimer();
					if (frame.scope === "live") {
						let pendingLive = false;
						for (const item of this.#fragmentSlots.values()) {
							if (item.scope === "live" && !item.entry) {
								pendingLive = true;
								break;
							}
						}
						if (pendingLive) this.#armFragmentProgressTimer(generation);
						else this.#clearFragmentProgressTimer();
					}
				} else if (frame.t === "snapshot-chunk") {
					if (this.#pendingSnapshot || !this.#welcomed) this.#deferFrame(frame, this.#snapshotQueue);
				} else {
					this.#deferFrame(frame, this.#liveQueue);
				}
				await drainQueued(generation);
			} catch (err) {
				if (generation !== this.#connectionGeneration) return;
				this.#clearFragmentProgressTimer();
				logger.warn("collab guest frame apply failed", { type: frame.t, error: String(err) });
				if (!joined) firstWelcome.reject(toError(err));
				else if (
					!this.#welcomed ||
					frame.t === "welcome" ||
					frame.t === "snapshot-chunk" ||
					this.#pendingSnapshot
				) {
					this.#ctx.showError(`Collab replication failed: ${String(err)}`);
					this.#restoreAfterDisconnect();
				} else {
					this.#ctx.showError(`Collab replication failed: ${String(err)}`);
					rejoin("replication failed");
				}
			}
		};
		socket.onFrame = frame => {
			const generation = this.#connectionGeneration;
			const syncGeneration = this.#syncGeneration;
			this.#applyChain = this.#applyChain.then(() => {
				if (
					frame.t === "bye" &&
					!this.#left &&
					(generation === this.#connectionGeneration ||
						(!connectionOpen && generation + 1 === this.#connectionGeneration))
				) {
					this.#applyFrame(frame);
					return;
				}
				if (syncGeneration === this.#syncGeneration) return processFrame(frame, generation);
			});
		};
		socket.onClose = (reason, willReconnect) => {
			connectionOpen = false;
			this.#connectionGeneration++;
			this.#welcomed = false;
			this.#clearFragmentProgressTimer();
			this.#clearWelcomeTimer();
			this.#clearSnapshotProgressTimer();
			this.#staleTransfers.clear();
			this.#resetReplicationBuffers();
			this.#pendingSnapshot = null;
			this.#flushPendingTranscripts();
			if (this.#left) return;
			if (!joined) {
				firstWelcome.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab connection lost (${reason}), reconnecting…`, { dim: true });
				return;
			}
			this.#ctx.showStatus(`Collab session ended (${reason})`);
			this.#restoreAfterDisconnect();
		};
		try {
			socket.connect();
			// Cover a blackholed WebSocket handshake too; onOpen resets the timer.
			this.#armWelcomeTimer();
			await firstWelcome.promise;
			if (this.#left) throw new Error("Collab join cancelled");
		} catch (err) {
			this.#joinReject = null;
			try {
				await this.#restoreLocalSession();
			} catch (restoreError) {
				throw new AggregateError([err, restoreError], `${err}; local restoration failed: ${restoreError}`);
			}
			throw err;
		} finally {
			this.#joinReject = null;
			this.#clearWelcomeTimer();
			this.#clearSnapshotProgressTimer();
		}
	}

	/** User-initiated leave (or post-disconnect cleanup): restore the previous session. */
	async leave(_reason: string): Promise<void> {
		await this.#restoreLocalSession();
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		if (this.#rejectReadOnly()) return;
		this.#socket?.send({ t: "prompt", text, images: images && images.length > 0 ? images : undefined });
	}

	/** Ask the host to rewind its active branch to a transcript entry. */
	rewind(entryId: string, resend = false): void {
		if (this.#rejectReadOnly()) return;
		if (!this.canRewind) {
			this.#ctx.showStatus("This collab host does not support rewind");
			return;
		}
		const socket = this.#socket;
		if (!socket) return;
		const reqId = this.#nextRewindReqId++;
		this.#pendingRewinds.set(reqId, resend);
		socket.send({ t: "rewind", reqId, entryId });
	}

	sendAbort(): void {
		if (this.#rejectReadOnly()) return;
		this.#socket?.send({ t: "abort" });
	}
	#rememberStaleTransfer(id: string): boolean {
		if (
			typeof id !== "string" ||
			!id ||
			id.length > 256 ||
			(!this.#staleTransfers.has(id) && this.#staleTransfers.size >= 128)
		) {
			this.#ctx.showError("Collab replication failed: invalid or excessive stale transfers");
			this.#restoreAfterDisconnect();
			return false;
		}
		this.#staleTransfers.add(id);
		return true;
	}

	#deferFrame(frame: CollabFrame, queue: QueuedReplication[]): void {
		const size = JSON.stringify(frame).length * 2;
		if (
			this.#reservedFragmentBytes + this.#deferredBytes + size >
			2 * MAX_COMPACTION_FRAGMENT_BYTES + 128 * 2 * COMPACTION_FRAGMENT_CHARS
		) {
			throw new Error("Collab deferred frame buffer exceeded its limit");
		}
		queue.push({ frame, size });
		this.#deferredBytes += size;
	}
	#discardSnapshotTail(): void {
		for (const item of this.#snapshotQueue) {
			if (
				!("frame" in item) ||
				item.frame.t !== "snapshot-chunk" ||
				!item.frame.final ||
				item.frame.entries.length !== 0
			) {
				throw new Error("Snapshot entry count mismatch");
			}
			this.#deferredBytes -= item.size;
		}
		this.#snapshotQueue = [];
	}

	#resetReplicationBuffers(): void {
		this.#compactionFragments.reset();
		this.#snapshotQueue = [];
		this.#liveQueue = [];
		this.#fragmentSlots.clear();
		this.#reservedFragmentBytes = 0;
		this.#deferredBytes = 0;
	}

	/**
	 * Latch the welcome metadata and prime the snapshot accumulator. The
	 * heavy resume work (file write, `switchSession`, render) only happens in
	 * {@link #finalizeSnapshot}, so the small welcome frame clears the join
	 * timeout immediately even when the transcript still has to stream in.
	 */
	#beginWelcome(frame: WelcomeFrame, isResync: boolean): void {
		if (this.#left) return;
		this.#clearUiRequests();
		if (this.#pendingSnapshot) {
			this.#clearFragmentProgressTimer();
			this.#resetReplicationBuffers();
		}
		this.#pendingSnapshot = {
			header: frame.header,
			state: frame.state,
			agents: frame.agents,
			readOnly: frame.readOnly === true,
			canRewind: frame.rewind === true,
			entryCount: frame.entryCount,
			entries: [],
			isResync,
			leafId: frame.leafId,
		};
		this.#armSnapshotProgressTimer();
	}

	/**
	 * Append entries to the pending snapshot. Returns `true` when the
	 * accumulator has gathered every entry the welcome promised.
	 * The caller invokes {@link #finalizeSnapshot} on the same applyChain microtask.
	 */
	#accumulateSnapshotChunk(frame: SnapshotChunkFrame): boolean {
		const pending = this.#pendingSnapshot;
		if (!pending) {
			logger.debug("collab guest dropping orphan snapshot-chunk");
			return false;
		}
		pending.entries.push(...frame.entries);
		if (
			pending.entries.length > pending.entryCount ||
			(frame.final && pending.entries.length !== pending.entryCount)
		) {
			throw new Error("Snapshot entry count mismatch");
		}
		const complete = pending.entries.length === pending.entryCount;
		if (complete) {
			this.#clearSnapshotProgressTimer();
		} else {
			this.#armSnapshotProgressTimer();
		}
		return complete;
	}

	/** Write the accumulated welcome snapshot to the replica file and (re)load it through the resume machinery. */
	async #finalizeSnapshot(generation: number): Promise<void> {
		const pending = this.#pendingSnapshot;
		this.#pendingSnapshot = null;
		this.#clearSnapshotProgressTimer();
		if (!pending || this.#left) return;
		if (pending.leafId && !pending.entries.some(entry => entry.id === pending.leafId)) {
			logger.warn("collab guest snapshot leaf was not held; requesting a fresh snapshot", {
				leafId: pending.leafId,
			});
			this.#requestRejoin?.("snapshot leaf was not held");
			return;
		}
		const replicaPath = path.join(getConfigRootDir(), "collab", `${this.#roomId}-${this.#replicaId}.jsonl`);
		// A child of the host's session, as a sibling move is.
		const header = {
			...pending.header,
			id: this.#replicaId,
			parentSession: pending.header.id,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(pending.header),
		};
		const lines = [header, ...pending.entries].map(entry => JSON.stringify(entry)).join("\n");
		const storage = new FileSessionStorage();
		this.#replicaLease ??= storage.claimSession(this.#replicaId, replicaPath) ?? undefined;
		// Published atomically: `omp gc` reads the replica's header to find its
		// lease, so a resync must never expose a truncated, headerless file.
		const tempPath = `${replicaPath}.${mintSessionId()}.tmp`;
		try {
			await Bun.write(tempPath, `${lines}\n`);
			await fs.rename(tempPath, replicaPath);
		} catch (err) {
			await fs.unlink(tempPath).catch(() => {});
			throw err;
		}
		if (this.#left || generation !== this.#connectionGeneration) return;

		// Resume through AgentSession without adopting the host's cwd. The replica
		// keeps its model: #applyHostState mirrors the host's, which runs inference.
		const switched = await this.#ctx.session.switchSession(replicaPath, { preserveLocalCwd: true, keepModel: true });
		if (switched === false) {
			throw new Error("Collab replica activation was cancelled");
		}
		this.#replicaActivated = true;
		if (this.#left || generation !== this.#connectionGeneration) return;
		if (pending.leafId === null) this.#ctx.sessionManager.resetLeaf();
		else if (pending.leafId && this.#ctx.sessionManager.getEntry(pending.leafId))
			this.#ctx.sessionManager.branch(pending.leafId);
		if (pending.leafId !== undefined) {
			this.#ctx.session.agent.replaceMessages(this.#ctx.session.buildDisplaySessionContext().messages);
		}
		if (this.#left) return;
		this.#ctx.eventController.resetTranscriptAnchors();
		this.#clearAgentMirror();
		this.state = pending.state;
		this.#reconcileLifecycle(pending.state.isStreaming);
		this.#applyHostState(pending.state);
		this.#ctx.resetObserverRegistry();
		this.#applyAgentSnapshots(pending.agents);
		this.#ctx.syncRunningSubagentBadge();
		this.#assistantStreamSynced = false;
		this.#streamedSnapshot = undefined;
		setSessionTerminalTitle(pending.state.sessionName ?? pending.header.title, pending.state.cwd);
		await this.#renderReplicaTranscript();
		if (this.#left || generation !== this.#connectionGeneration) return;
		await this.#ctx.reloadTodos();
		if (this.#left || generation !== this.#connectionGeneration) return;
		this.#updateStatusSegment();
		this.#readOnly = pending.readOnly;
		this.#canRewind = pending.canRewind;
		this.#welcomed = true;
		const suffix = this.#readOnly ? " (read-only)" : "";
		this.#ctx.showStatus(
			pending.isResync ? `Reconnected to collab session${suffix}` : `Joined collab session${suffix}`,
		);
	}

	/** Render the replica's current branch without abandoning visible rows on render failure. */
	async #renderReplicaTranscript(): Promise<void> {
		const orphanedLiveBlocks = [
			...this.#ctx.pendingTools.values(),
			...this.#ctx.eventController.takeDisplaceableComponents(),
		];
		this.#clearTransientUi();
		try {
			await this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		} catch (err) {
			// The render rollback leaves old rows visible; seal their ticker handles
			// instead of disposing resources those rows still use.
			for (const handle of orphanedLiveBlocks) handle.seal();
			throw err;
		}
		reconcileGuestSnapshotHostState(this.#ctx, this.state?.isStreaming ?? false);
	}

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		const version = this.#welcomeTimerVersion;
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			this.#applyChain = this.#applyChain.then(() => {
				if (this.#left || version !== this.#welcomeTimerVersion) return;
				this.#onWelcomeTimeout?.();
			});
		}, WELCOME_TIMEOUT_MS);
	}

	#clearWelcomeTimer(): void {
		this.#welcomeTimerVersion++;
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		const onTimeout = this.#onSnapshotTimeout;
		if (this.#left || onTimeout === null) return;
		this.#clearSnapshotProgressTimer();
		const version = this.#snapshotProgressVersion;
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#applyChain = this.#applyChain.then(() => {
				if (this.#left || version !== this.#snapshotProgressVersion) return;
				onTimeout();
			});
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		this.#snapshotProgressVersion++;
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	#armFragmentProgressTimer(generation: number): void {
		this.#clearFragmentProgressTimer();
		const version = this.#fragmentProgressVersion;
		this.#fragmentProgressTimer = setTimeout(() => {
			this.#fragmentProgressTimer = null;
			this.#applyChain = this.#applyChain.then(() => {
				if (
					this.#left ||
					generation !== this.#connectionGeneration ||
					version !== this.#fragmentProgressVersion ||
					!this.#compactionFragments.pending
				)
					return;
				this.#ctx.showError("Collab replication failed: compaction transfer timed out");
				this.#requestRejoin?.("compaction transfer timed out");
			});
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearFragmentProgressTimer(): void {
		this.#fragmentProgressVersion++;
		if (this.#fragmentProgressTimer !== null) {
			clearTimeout(this.#fragmentProgressTimer);
			this.#fragmentProgressTimer = null;
		}
	}

	/** Re-introduce this guest so the host discards queued frames and sends a fresh snapshot. */
	#sendHello(socket = this.#socket): void {
		if (!socket || this.#left) return;
		for (const slot of this.#fragmentSlots.values()) {
			if (!slot.entry && !this.#rememberStaleTransfer(slot.transferId)) return;
		}
		if (this.#pendingRewinds.size > 0) {
			this.#pendingRewinds.clear();
			this.#ctx.showError("Collab rewind result is unknown after the session rejoined. Check the transcript.");
		}
		this.#syncGeneration++;
		this.#welcomed = false;
		this.#pendingSnapshot = null;
		this.#clearFragmentProgressTimer();
		this.#resetReplicationBuffers();
		this.#clearSnapshotProgressTimer();
		this.#armWelcomeTimer();
		socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: collabDisplayName(this.#ctx),
			writeToken: this.#writeToken,
			compactionFragments: true,
		});
	}

	async #applyLeafFrame(leafId: string | null): Promise<void> {
		const previousLeafId = this.#ctx.sessionManager.getLeafId();
		if (leafId === null) this.#ctx.sessionManager.resetLeaf();
		else if (this.#ctx.sessionManager.getEntry(leafId)) this.#ctx.sessionManager.branch(leafId);
		else {
			logger.warn("collab guest leaf was not held; requesting a fresh snapshot", { leafId });
			this.#requestRejoin?.("host leaf was not held");
			return;
		}
		if (this.#ctx.sessionManager.getLeafId() === previousLeafId) return;
		this.#ctx.session.agent.replaceMessages(this.#ctx.session.buildDisplaySessionContext().messages);
		await this.#renderReplicaTranscript();
		if (this.#left) return;
		await this.#ctx.reloadTodos();
		if (this.#left) return;
		this.#updateStatusSegment();
	}

	#applyFrame(frame: CollabFrame): void | Promise<void> {
		switch (frame.t) {
			case "leaf":
				return this.#applyLeafFrame(frame.leafId);
			case "rewind-result": {
				const resend = this.#pendingRewinds.get(frame.reqId);
				if (resend === undefined) break;
				this.#pendingRewinds.delete(frame.reqId);
				if (frame.error) {
					this.#ctx.showError(`Collab rewind failed: ${frame.error}`);
					break;
				}
				if (resend && frame.replaceDraft === true) {
					this.sendPrompt(frame.draft ?? "", frame.images);
					break;
				}
				if (frame.replaceDraft === true) {
					this.#ctx.editor.setDraft(frame.draft ?? "", frame.images);
					this.#ctx.updateEditorBorderColor();
					this.#ctx.ui.requestRender();
				}
				break;
			}
			case "entry": {
				// Message entries are rendered by events; entries also keep the replica
				// and the agent's context current.
				this.#ctx.sessionManager.ingestReplicatedEntry(frame.entry);
				if (frame.entry.type === "message") {
					this.#ctx.session.agent.replaceMessages([...this.#ctx.session.messages, frame.entry.message]);
				} else if (frame.entry.type === "compaction" || frame.entry.type === "branch_summary") {
					// These entries rewrite the host's model context.
					this.#ctx.session.agent.replaceMessages(this.#ctx.session.buildDisplaySessionContext().messages);
					if (frame.entry.type === "compaction") return this.#renderReplicaTranscript();
				}
				break;
			}
			case "event":
				// Hosts send every stopped loop as a flagged `agent_end` (see loop-end-wire.ts).
				this.#applyEvent(fromWireEvent(frame.event));
				break;
			case "state": {
				this.state = frame.state;
				this.#applyHostState(frame.state);
				setSessionTerminalTitle(frame.state.sessionName, frame.state.cwd);
				this.#updateStatusSegment();
				reconcileGuestSnapshotHostState(this.#ctx, frame.state.isStreaming);
				this.#reconcileLifecycle(frame.state.isStreaming);
				this.#ctx.statusLine.invalidate();
				this.#ctx.ui.requestRender();
				break;
			}
			case "bus":
				// Mirrored host EventBus traffic (task subagent lifecycle/progress)
				// feeding the observer HUD and Agent Hub progress columns. The
				// observer registry listens on the shared observability bus.
				emitSubagentFrame(this.#ctx.eventBus, this.#ctx.subagentEventBus, frame.channel, frame.data);
				break;
			case "agents":
				this.#applyAgentSnapshots(frame.agents);
				this.#ctx.syncRunningSubagentBadge();
				break;
			case "ui-request":
				this.#presentUiRequest(frame.request);
				break;
			case "ui-request-end":
				this.#endUiRequest(frame.reqId);
				break;
			case "transcript": {
				const resolve = this.#pendingTranscripts.get(frame.reqId);
				if (resolve) {
					this.#pendingTranscripts.delete(frame.reqId);
					resolve({ text: frame.text, newSize: frame.newSize, error: frame.error });
				}
				break;
			}
			case "bye": {
				this.#ctx.showStatus(`Collab session ended (${frame.reason})`);
				this.#restoreAfterDisconnect();
				break;
			}
			case "error":
				this.#ctx.showError(`Collab host: ${frame.message}`);
				break;
			default:
				logger.debug("collab guest ignoring unexpected frame", { type: frame.t });
		}
	}

	#applyEvent(event: AgentSessionEvent): void {
		// Orphan-delta guard: when joining mid-turn the message_start for the
		// in-flight assistant message predates the snapshot. message_update
		// carries the full accumulating message, so synthesize the missing start
		// before the first orphaned update; every other handler is tolerant of
		// unknown anchors (guarded by streamingComponent/pendingTools lookups).
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#assistantStreamSynced = true;
			this.#streamedSnapshot = event.message;
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			if (!this.#assistantStreamSynced) {
				this.#assistantStreamSynced = true;
				this.#streamedSnapshot = event.message;
				this.#dispatchEvent({ type: "message_start", message: event.message });
			}
			// The host supersedes still-queued updates of a streaming message, so
			// their per-update deltas (speech, extensions) never arrive. Replay the
			// text they carried, recovered from the cumulative snapshots.
			if (this.#streamedSnapshot) {
				for (const omitted of omittedStreamDeltas(
					this.#streamedSnapshot,
					event.message,
					event.assistantMessageEvent,
				)) {
					this.#mirrorEvent({ type: "message_update", message: event.message, assistantMessageEvent: omitted });
				}
			}
			this.#streamedSnapshot = event.message;
		} else if (event.type === "message_end") {
			this.#streamedSnapshot = undefined;
		}
		this.#mirrorEvent(event);
	}

	#mirrorEvent(event: AgentSessionEvent): void {
		this.#dispatchEvent(event);
		// Lifecycle mirror: the guest's own agent loop never runs, so the session's
		// extension-event path stays silent. Route the mirrored wire event through
		// the same mapping the session uses so extension-installed lifecycle
		// integrations (Herdr pane state, RPC trackers, stats) observe host
		// working/idle transitions while joined. Emissions chain (ordered but never
		// awaited inline) so a slow extension handler neither stalls frame
		// application nor completes out of order.
		const runner = this.#ctx.session.extensionRunner;
		if (runner) this.#lifecycleEmitter.emit(runner, event);
	}

	/**
	 * Feed a mirrored event through the same pipeline as a local session:
	 * `message_update` joins the controller's coalesced streaming rebuild and
	 * every other event runs serialized behind it, so a mirrored stream tail
	 * cannot reorder (message_update → message_end → agent_end).
	 */
	#dispatchEvent(event: AgentSessionEvent): void {
		this.#ctx.eventController.dispatchSessionEvent(event).catch(err => {
			logger.warn("collab guest event dispatch failed", { type: event.type, error: String(err) });
		});
	}

	/**
	 * Reconcile the lifecycle mirror with a host activity snapshot. A guest that
	 * joins (or resyncs) mid-run missed the host's `agent_start`, and the mirror
	 * must not assume the wire's first event after (re)sync carries the boundary;
	 * a host that reports `isStreaming === false` may equally have settled before
	 * the guest ever saw a start. Synthesize the missing edge so extension
	 * handlers never miss a working/idle transition. This is not an exact replay
	 * of a local session: a `state` frame landing during host prompt setup
	 * synthesizes an `agent_start` that the real one then repeats, and the
	 * host's intermediate `willContinue` settles never reach the wire.
	 */
	#reconcileLifecycle(isStreaming: boolean): void {
		const runner = this.#ctx.session.extensionRunner;
		if (!runner) return;
		if (isStreaming) {
			if (!this.#lifecycleEmitter.sawAgentStart) {
				this.#lifecycleEmitter.emit(runner, { type: "agent_start" });
			}
		} else if (this.#lifecycleEmitter.sawAgentStart) {
			this.#lifecycleEmitter.emit(runner, { type: "agent_end", messages: [...this.#ctx.session.messages] });
		}
	}

	/**
	 * Apply the host's real model/thinking state to the replica agent so model
	 * display and context-window math are native (no display-string overrides).
	 * Pure agent-state mutation: session.setModel/setThinkingLevel would
	 * persist entries and clamp to local credentials.
	 */
	#applyHostState(state: CollabSessionState): void {
		const session = this.#ctx.session;
		if (
			state.model &&
			(session.agent.state.model?.id !== state.model.id ||
				session.agent.state.model?.provider !== state.model.provider)
		) {
			session.agent.setModel(state.model);
		}
		const level = state.thinkingLevel as ThinkingLevel | undefined;
		session.agent.setThinkingLevel(toReasoningEffort(level));
		session.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/** Diff a host agent snapshot into the local registry (refs keep `session: null`). */
	#applyAgentSnapshots(agents: AgentSnapshot[]): void {
		const seen = new Set<string>();
		for (const snap of agents) seen.add(snap.id);
		for (const ref of this.agentRegistry.list()) {
			if (!seen.has(ref.id)) {
				this.agentRegistry.unregister(ref.id);
				this.#agentHasTranscript.delete(ref.id);
			}
		}
		for (const snap of agents) {
			if (this.agentRegistry.get(snap.id)) {
				this.agentRegistry.setStatus(snap.id, snap.status);
			} else {
				this.agentRegistry.register({
					id: snap.id,
					displayName: snap.displayName,
					kind: snap.kind,
					parentId: snap.parentId,
					session: null,
					status: snap.status,
				});
			}
			// Refs are returned by reference: patch host timestamps directly so
			// hub age/activity columns reflect the host, not local registration.
			const ref = this.agentRegistry.get(snap.id);
			if (ref) {
				ref.createdAt = snap.createdAt;
				ref.lastActivity = snap.lastActivity;
				ref.displayName = snap.displayName;
			}
			this.#agentHasTranscript.set(snap.id, snap.hasSessionFile);
		}
	}

	#clearAgentMirror(): void {
		for (const ref of this.agentRegistry.list()) {
			this.agentRegistry.unregister(ref.id);
		}
		this.#agentHasTranscript.clear();
	}

	/** Resolve every in-flight transcript request with null (resolvers clear their own timers). */
	#flushPendingTranscripts(): void {
		for (const resolve of this.#pendingTranscripts.values()) {
			resolve(null);
		}
		this.#pendingTranscripts.clear();
	}

	/**
	 * Surface a host `ui-request` (ask select/editor) through the local
	 * hook-dialog seam. The dialog settles on user submit/cancel — both send a
	 * `ui-response` (cancel carries `value: undefined`, mirroring the web
	 * client's Cancel button) — or when {@link #endUiRequest} aborts it because
	 * the host settled the request elsewhere; that path must NOT respond.
	 */
	#presentUiRequest(request: CollabUiRequest): void {
		// The host only targets writable peers; drop defensively on a read-only link.
		if (this.#readOnly || this.#pendingUiRequests.has(request.reqId)) return;
		const abort = new AbortController();
		this.#pendingUiRequests.set(request.reqId, abort);
		const dialog =
			request.kind === "select"
				? this.#ctx.showHookSelector(
						request.title,
						request.options,
						{
							signal: abort.signal,
							initialIndex: request.initialIndex,
							selectionMarker: request.selectionMarker,
							checkedIndices: request.checkedIndices,
							markableCount: request.markableCount,
							helpText: request.helpText,
						},
						{ kind: request.approval ? "permission" : "question" },
					)
				: this.#ctx.showHookEditor(request.title, request.prefill, { signal: abort.signal });
		dialog
			.then(value => {
				// Identity check: only the presentation that still owns the reqId
				// may respond. An abort from #endUiRequest / #clearUiRequests
				// removes (or replaces, on resync replay) the entry before this
				// microtask runs, so a dismissed dialog stays silent.
				if (this.#pendingUiRequests.get(request.reqId) !== abort) return;
				this.#pendingUiRequests.delete(request.reqId);
				this.#socket?.send({ t: "ui-response", reqId: request.reqId, value });
			})
			.catch(err => {
				if (this.#pendingUiRequests.get(request.reqId) === abort) {
					this.#pendingUiRequests.delete(request.reqId);
				}
				logger.warn("collab guest ui-request presentation failed", {
					reqId: request.reqId,
					error: String(err),
				});
			});
	}

	/** Host settled the request (answered elsewhere or aborted): dismiss without responding. */
	#endUiRequest(reqId: number): void {
		const abort = this.#pendingUiRequests.get(reqId);
		if (!abort) return;
		this.#pendingUiRequests.delete(reqId);
		abort.abort();
	}

	/**
	 * Dismiss every locally presented `ui-request` without responding: on
	 * resync the host replays the ones still pending, and on leave they are no
	 * longer ours to answer. Queued dialogs abort before the presented one
	 * (reverse insertion order) so settling the active dialog cannot flash the
	 * next queued one onto the surface first.
	 */
	#clearUiRequests(): void {
		if (this.#pendingUiRequests.size === 0) return;
		const aborts = [...this.#pendingUiRequests.values()];
		this.#pendingUiRequests.clear();
		for (const abort of aborts.reverse()) abort.abort();
	}

	#clearTransientUi(): void {
		clearGuestTransientStatus(this.#ctx);
		this.#ctx.pendingShellContainer.clear();
		this.#ctx.pendingMessagesContainer.clear();
		this.#ctx.compactionQueuedMessages = [];
		this.#ctx.streamingComponent = undefined;
		this.#ctx.streamingMessage = undefined;
		this.#ctx.pendingTools.clear();
		if (this.#ctx.loadingAnimation) {
			this.#ctx.loadingAnimation.stop();
			this.#ctx.loadingAnimation = undefined;
		}
	}

	#restoreAfterDisconnect(): void {
		void this.#restoreLocalSession().catch(err => {
			logger.warn("Collab local restoration failed", { error: String(err) });
			this.#ctx.showError(`Failed to restore local session: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	#restoreLocalSession(): Promise<boolean> {
		if (this.#restoration) return this.#restoration;
		this.#left = true;
		this.#clearUiRequests();
		this.#requestRejoin = null;
		this.#joinReject?.(new Error("Collab join cancelled"));
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearFragmentProgressTimer();
		this.#pendingSnapshot = null;
		this.#resetReplicationBuffers();
		this.#pendingRewinds.clear();
		this.#socket?.close();
		this.#socket = null;
		// The host's terminal `agent_end` may never arrive (leave mid-run,
		// disconnect, `bye`): unlatch the pane before the local session takes
		// over so extensions do not stay stuck on the host's last `agent_start`.
		this.#reconcileLifecycle(false);
		this.#restoration = this.#runRestoreLocalSession();
		this.#ctx.collabController?.resumeAfterGuest(this.#restoration);
		return this.#restoration;
	}

	async #runRestoreLocalSession(): Promise<boolean> {
		// An already-running switch cannot be cancelled halfway through. Drain
		// it before rollback; no queued frame may reactivate the replica later.
		await this.#applyChain;
		try {
			if (this.#replicaActivated) await this.#resumeLocalSession();
		} finally {
			this.#replicaLease?.();
			this.#replicaLease = undefined;
		}
		if (this.#ctx.collabGuest !== this) return false;
		this.#ctx.setCollabGuest(undefined);
		this.#ctx.syncRunningSubagentBadge();
		return this.#replicaActivated;
	}

	async #resumeLocalSession(): Promise<void> {
		this.#ctx.statusLine.setCollabStatus(null);
		this.#flushPendingTranscripts();
		// A pending coalesced mirror message_update must not flush after leave.
		this.#ctx.eventController.resetTranscriptAnchors();
		this.#clearAgentMirror();
		this.#ctx.syncRunningSubagentBadge();
		this.#ctx.resetObserverRegistry();
		this.#clearTransientUi();
		// Replica file stays on disk: it is a valid session file outside the
		// sessions dir, so it never shows up in /resume but remains readable.
		if (this.#returnSessionFile) {
			await this.#ctx.handleResumeSession(this.#returnSessionFile);
			// The TUI resume wrapper returns void even when a hook or settings
			// flush cancels it. Only the actual local file can release ownership.
			if (this.#ctx.sessionManager.getSessionFile() !== this.#returnSessionFile) {
				throw new Error("Local session restoration was cancelled");
			}
			return;
		}
		if ((await this.#ctx.session.newSession()) === false) {
			throw new Error("Local session restoration was cancelled");
		}
		setSessionTerminalTitle(this.#ctx.sessionManager.getSessionName(), this.#ctx.sessionManager.getCwd());
		this.#ctx.statusLine.invalidate();
		this.#ctx.statusLine.resetActiveTime();
		this.#ctx.ui.requestRender();
		this.#ctx.updateEditorBorderColor();
		await this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#ctx.ui.requestRender(true, { clearScrollback: true });
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({
			role: "guest",
			participantCount: this.state?.participants.length ?? 1,
			stateOverride: this.state,
		});
	}
}
