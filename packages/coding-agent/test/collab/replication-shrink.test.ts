/**
 * Regression contract for issue #3739: a session entry whose serialized JSON
 * exceeds the relay's per-frame `maxPayloadLength` MUST NOT kill the host's
 * WebSocket. Before that fix, `CollabHost.#sendSnapshotChunks` shipped any
 * single oversized entry as its own oversized chunk; the relay closed the
 * host with `1006 Received too big message`, `CollabSocket` reconnected on
 * the non-fatal code, the next guest hello triggered the same oversized
 * send, and the loop never broke ("/collab disconnects when session is too
 * large").
 *
 * The host bounds every replicated entry through `serializeReplicatedEntry`
 * so a head-truncated mirror ships instead. The test stands up a real
 * Bun.serve relay with `maxPayloadLength` set tight, hosts a snapshot
 * containing one ~5 MB entry, and asserts:
 *
 *   1. The host's connection survives — no `Connection ended` close, no
 *      "reconnecting…" status loop.
 *   2. The guest receives a final `snapshot-chunk` train carrying the
 *      oversized entry with its content head-truncated and the elision
 *      marker present.
 *
 * Regression contract for issue #11433: the ceiling is *enforced*, not
 * approached. String/array shrinking cannot touch size that lives in object
 * keys, the walk used to recurse into a `RangeError` on a deep entry, and the
 * cap was compared against UTF-16 code units instead of the bytes the relay
 * sees. Each of those is reproduced below against the fixed helper, whose
 * observable contract is: never throws, always returns something under
 * {@link MAX_REPLICATED_PAYLOAD_BYTES}, and preserves the entry's
 * `id`/`parentId` so the guest's branch chain stays connected.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabElided,
	type CollabFrame,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { placeholdImagesForReplication } from "@oh-my-pi/pi-coding-agent/collab/replication-images";
import {
	copyForReplication,
	MAX_REPLICATED_PAYLOAD_BYTES,
	type ReplicatedEntry,
	replicationByteLength,
	serializeReplicatedEntry,
	serializeReplicatedEvent,
} from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { COLLAB_ENTRY_OMITTED_CUSTOM_TYPE } from "@oh-my-pi/pi-wire";
import { expectFetchable, valueAtPath } from "./helpers/collab-elided";
import { installTestCollabHome, uninstallTestCollabHome } from "./helpers/in-memory-relay";
import { buildTailFixture, type TailFixture } from "./helpers/tail-fixture";
import { getAgentDir, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

interface RelayData {
	role: "host" | "guest";
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<RelayData>;

interface TestRelay {
	url: string;
	stop(): void;
}

/**
 * Single-room relay mirroring the omp-collab-relay forwarding contract, with
 * a configurable `maxPayloadLength` so the test asserts the same close path
 * the public relay (Bun.serve default = 16 MB, proxies often lower) exposes.
 */
function startTestRelay(maxPayloadLength: number): TestRelay {
	let host: RelaySocket | null = null;
	const guests = new Map<number, RelaySocket>();
	let nextPeerId = 1;
	const server = Bun.serve({
		port: 0,
		fetch(req, srv): Response | undefined {
			const role = new URL(req.url).searchParams.get("role") === "host" ? "host" : "guest";
			const data: RelayData = { role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			maxPayloadLength,
			open(ws: RelaySocket): void {
				if (ws.data.role === "host") {
					host = ws;
					return;
				}
				ws.data.peerId = nextPeerId++;
				guests.set(ws.data.peerId, ws);
				host?.send(JSON.stringify({ t: "peer-joined", peer: ws.data.peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return;
				const bytes = new Uint8Array(message);
				if (ws.data.role === "host") {
					const envelope = unpackEnvelope(bytes);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of guests.values()) guest.send(bytes);
					} else {
						guests.get(envelope.peerId)?.send(bytes);
					}
					return;
				}
				rewriteEnvelopePeer(bytes, ws.data.peerId);
				host?.send(bytes);
			},
			close(ws: RelaySocket): void {
				if (ws.data.role === "guest") {
					guests.delete(ws.data.peerId);
					host?.send(JSON.stringify({ t: "peer-left", peer: ws.data.peerId }));
				}
			},
		},
	});
	return { url: `ws://localhost:${server.port}`, stop: () => server.stop(true) };
}

interface HostSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: readonly SessionEntry[];
}

interface OversizedSnapshot extends HostSnapshot {
	bigEntryId: string;
	bigPayloadLength: number;
}

function userMessage(id: string, parentId: string | null, timestamp: string, content: string): ReplicatedEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 0 } };
}

/**
 * Snapshot with one well-formed small entry plus one ~5 MB entry. The
 * oversized payload sits in a `MessageEntry`'s user `content` because that
 * matches the realistic trigger (a tool result/message accumulated multiple
 * megabytes of `read`/`bash`/`search` output during the host session). This
 * one is *shrinkable*: the size lives in a single string leaf.
 */
function makeOversizedSnapshot(bigBytes: number): OversizedSnapshot {
	const big = "x".repeat(bigBytes);
	return {
		header: { type: "session", id: "sess-big", timestamp: "2026-06-28T00:00:00Z", cwd: "/tmp" },
		entries: [
			userMessage("small-1", null, "2026-06-28T00:00:00Z", "hi"),
			userMessage("big-1", "small-1", "2026-06-28T00:00:01Z", big),
		],
		bigEntryId: "big-1",
		bigPayloadLength: bigBytes,
	};
}

/**
 * Snapshot whose second entry is *unshrinkable*: its size lives entirely in a
 * single 17 MiB object key, which no string/array pass may drop because keys
 * are identity. Pre-#11433 this entry shipped at full size (17.8 MB), tripping
 * the relay's frame limit; the fixed host substitutes a typed placeholder
 * that keeps the entry's id, so the chunk train still terminates.
 */
function makeUnshrinkableSnapshot(): HostSnapshot & { omittedEntryId: string } {
	const giantKey = "k".repeat(17 * 1024 * 1024);
	return {
		header: { type: "session", id: "sess-key", timestamp: "2026-09-13T00:00:00Z", cwd: "/tmp" },
		entries: [
			userMessage("small-1", null, "2026-09-13T00:00:00Z", "hi"),
			{
				type: "message",
				id: "huge-key-1",
				parentId: "small-1",
				timestamp: "2026-09-13T00:00:01Z",
				message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
			} as unknown as ReplicatedEntry,
		],
		omittedEntryId: "huge-key-1",
	};
}

interface HostHarness {
	ctx: InteractiveModeContext;
	statusMessages: string[];
}

/**
 * The slice of `SessionManager` the host actually drives. Narrowing it here is
 * what lets a case supply either a fixture snapshot or the real manager — and
 * the real manager is the interesting one, because it owns the deep copy the
 * host performs before the shrinker runs.
 */
interface HostReplicationSource {
	getSessionId(): string;
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
	getCwd(): string;
	snapshotForReplication(copy?: <T>(value: T) => T): HostSnapshot;
	onEntryAppended?: ((entry: SessionEntry) => void) | undefined;
	onLeafChanged?: (() => void) | undefined;
}

function makeHostContext(snapshot: HostSnapshot): HostHarness {
	return makeHostHarness({
		getSessionId: () => snapshot.header.id,
		getCwd: () => snapshot.header.cwd,
		getLeafId: () => snapshot.entries.at(-1)?.id ?? null,
		getEntry: (id: string) => snapshot.entries.find(entry => entry.id === id),
		snapshotForReplication: () => snapshot,
		onEntryAppended: undefined,
		onLeafChanged: undefined,
	});
}

function makeHostHarness(sessionManager: HostReplicationSource): HostHarness {
	const statusMessages: string[] = [];
	const ctx = {
		settings: Settings.isolated(),
		sessionManager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "big",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			subscribeCommandMetadataChanged: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (msg: string) => statusMessages.push(msg),
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, statusMessages };
}

/**
 * Connect a real guest to `host` and collect its frames until the snapshot
 * train reports `final`. Races the train against a relay close so a
 * regression fails with the close reason instead of stalling out the test
 * timeout — both paths are real signals, no wall-clock sleeps.
 */
async function collectSnapshotTrain(host: CollabHost): Promise<{
	frames: CollabFrame[];
	closes: { reason: string; willReconnect: boolean }[];
}> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());

	const frames: CollabFrame[] = [];
	const closes: { reason: string; willReconnect: boolean }[] = [];
	const trainDone = Promise.withResolvers<void>();
	const guestClosed = Promise.withResolvers<void>();
	guest.onFrame = frame => {
		frames.push(frame);
		if (frame.t === "snapshot-chunk" && frame.final) trainDone.resolve();
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
	guest.onClose = (reason, willReconnect) => {
		closes.push({ reason, willReconnect });
		guestClosed.resolve();
	};
	guest.connect();

	await Promise.race([
		trainDone.promise,
		guestClosed.promise.then(() => {
			throw new Error(`snapshot train aborted by relay close: ${JSON.stringify(closes)}`);
		}),
	]);
	return { frames, closes };
}

/** Bound assertion used by every #11433 case: measurable and under the ceiling. */
function expectBounded(value: unknown): number {
	const bytes = replicationByteLength(value);
	if (bytes === null) throw new Error("expected a serializable, measurable payload");
	expect(bytes).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
	return bytes;
}

// ── Fixture ────────────────────────────────────────────────────────────────

/**
 * 5 MB single-entry payload is comfortably above the 1 MB replication ceiling
 * the host's `serializeReplicatedEntry` enforces but well below the relay's
 * `maxPayloadLength` here (8 MB). Pre-#3739 this entry shipped as its own
 * ~5 MB chunk through the relay; today it ships head-truncated to ~64 KB.
 */
const BIG_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** Tighter than Bun's 16 MB default so the test reliably exercises the same
 * close path real relays expose without making the test heavy. */
const RELAY_MAX_PAYLOAD = 8 * 1024 * 1024;

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
	installTestCollabHome();
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	uninstallTestCollabHome();
});

describe("collab replication shrinking (#3739)", () => {
	it("ships an oversized entry without disconnecting the host", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());

		const snapshot = makeOversizedSnapshot(BIG_PAYLOAD_BYTES);
		const harness = makeHostContext(snapshot);
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		const { frames, closes } = await collectSnapshotTrain(host);

		// Host stayed up: no relay-side close fanned the room shutdown to the
		// guest, and no "reconnecting…" status fired.
		expect(closes).toEqual([]);
		expect(harness.statusMessages.some(msg => msg.includes("reconnecting"))).toBe(false);

		// Guest received the welcome plus a chunk train carrying both entries.
		const welcome = frames.find(f => f.t === "welcome");
		expect(welcome).toBeDefined();
		if (welcome?.t !== "welcome") throw new Error("expected welcome frame");
		expect(welcome.entryCount).toBe(snapshot.entries.length);

		const chunkEntries: SessionEntry[] = [];
		for (const f of frames) if (f.t === "snapshot-chunk") chunkEntries.push(...f.entries);
		expect(chunkEntries.map(e => e.id)).toEqual(snapshot.entries.map(e => e.id));

		const bigShrunk = chunkEntries.find(e => e.id === snapshot.bigEntryId);
		if (bigShrunk?.type !== "message") throw new Error("expected shrunk big message entry");
		const bigMessage = bigShrunk.message;
		if (bigMessage.role !== "user") throw new Error("expected shrunk big user message");
		const shrunkContent = bigMessage.content;
		if (typeof shrunkContent !== "string") throw new Error("expected string content after shrink");
		// Original was 5 MB; the head-truncation marker carries the exact
		// number of dropped chars so the guest can show "this was bigger".
		expect(shrunkContent.length).toBeLessThan(snapshot.bigPayloadLength / 10);
		expect(shrunkContent).toContain("chars elided for collab session");
	});
});

describe("lossless Snapcompact replication", () => {
	function archive(id: string, parentId: string): SessionEntry {
		return {
			type: "compaction",
			id,
			parentId,
			timestamp: "2026-09-13T00:00:01Z",
			summary: "Archived 😀 history",
			firstKeptEntryId: parentId,
			tokensBefore: 1000,
			method: "snapcompact",
			preserveData: {
				snapcompact: {
					text: `begin 漢😀\\"\n${"archive".repeat(170_000)} end`,
					frames: [{ data: "aGVsbG8=".repeat(20_000), mimeType: "image/png", cols: 64, rows: 40, chars: 4 }],
					totalChars: 123,
					truncatedChars: 0,
				},
			},
		} as SessionEntry;
	}

	async function connect(host: CollabHost, capable: boolean) {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => socket.close());
		const frames: CollabFrame[] = [];
		const snapshotDone = Promise.withResolvers<void>();
		const refused = Promise.withResolvers<void>();
		let snapshotCount = 0;
		let expectedCount = 0;
		let snapshotFinal = false;
		let onFrame: ((frame: CollabFrame) => void) | undefined;
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "welcome") {
				expectedCount = frame.entryCount;
				snapshotCount = 0;
				snapshotFinal = false;
			} else if (frame.t === "snapshot-chunk") {
				snapshotCount += frame.entries.length;
				snapshotFinal ||= frame.final;
			} else if (frame.t === "compaction-fragment" && frame.scope === "snapshot" && frame.part === frame.parts - 1) {
				snapshotCount++;
			}
			if (snapshotFinal && snapshotCount === expectedCount) snapshotDone.resolve();
			if (frame.t === "error" || frame.t === "bye") refused.resolve();
			onFrame?.(frame);
		};
		socket.onClose = () => refused.resolve();
		const sendHello = () =>
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: capable ? "modern" : "legacy",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
				...(capable ? { compactionFragments: true } : {}),
			});
		socket.onOpen = sendHello;
		socket.connect();
		return {
			frames,
			snapshotDone: snapshotDone.promise,
			refused: refused.promise,
			sendHello,
			watch: (fn: (frame: CollabFrame) => void) => {
				onFrame = fn;
			},
		};
	}

	function entriesFrom(frames: CollabFrame[], scope: "snapshot" | "live"): SessionEntry[] {
		const entries: (SessionEntry | undefined)[] = [];
		const transfers = new Map<
			string,
			{ index: number; entryId: string; parts: number; byteLength: number; data: string[] }
		>();
		for (const frame of frames) {
			if (frame.t === "compaction-fragment" && frame.scope === scope) {
				expect(frame.data.length).toBeLessThanOrEqual(64 * 1024);
				expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(400 * 1024);
				let transfer = transfers.get(frame.transferId);
				if (!transfer) {
					transfer = {
						index: entries.length,
						entryId: frame.entryId,
						parts: frame.parts,
						byteLength: frame.byteLength,
						data: [],
					};
					transfers.set(frame.transferId, transfer);
					entries.push(undefined);
				}
				expect(frame.entryId).toBe(transfer.entryId);
				expect(frame.parts).toBe(transfer.parts);
				expect(frame.byteLength).toBe(transfer.byteLength);
				expect(frame.part).toBe(transfer.data.length);
				transfer.data.push(frame.data);
				if (transfer.data.length === transfer.parts) {
					const json = transfer.data.join("");
					expect(Buffer.byteLength(json)).toBe(transfer.byteLength);
					const entry = JSON.parse(json) as SessionEntry;
					expect(entry.id).toBe(transfer.entryId);
					entries[transfer.index] = entry;
					transfers.delete(frame.transferId);
				}
			} else if (scope === "snapshot" && frame.t === "snapshot-chunk") {
				entries.push(...frame.entries);
			} else if (scope === "live" && frame.t === "entry") {
				entries.push(frame.entry);
			}
		}
		expect(transfers.size).toBe(0);
		expect(entries.every(entry => entry !== undefined)).toBe(true);
		return entries as SessionEntry[];
	}

	it("sends an intact archive in order to live and late-joining guests", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());
		const before = userMessage("before", null, "2026-09-13T00:00:00Z", "ordinary before");
		const compact = archive("compact", before.id);
		const second = archive("second", compact.id);
		const after = userMessage("after", second.id, "2026-09-13T00:00:02Z", "ordinary after");
		const entries: SessionEntry[] = [before];
		const snapshot: HostSnapshot = {
			header: { type: "session", id: "lossless", timestamp: before.timestamp, cwd: "/tmp" },
			entries,
		};
		let selectedLeaf = before.id;
		const source: HostReplicationSource = {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			getLeafId: () => selectedLeaf,
			getEntry: id => snapshot.entries.find(entry => entry.id === id),
			snapshotForReplication: () => snapshot,
		};
		const host = new CollabHost(makeHostHarness(source).ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));
		const live = await connect(host, true);
		await live.snapshotDone;
		const liveStart = live.frames.length;
		const liveDone = Promise.withResolvers<void>();
		const completed = new Set<string>();
		let receivedAfter = false;
		let receivedLeaf = false;
		live.watch(frame => {
			if (frame.t === "compaction-fragment" && frame.scope === "live" && frame.part === frame.parts - 1) {
				completed.add(frame.entryId);
			}
			if (frame.t === "entry" && frame.entry.id === after.id) receivedAfter = true;
			if (frame.t === "leaf" && frame.leafId === compact.id) receivedLeaf = true;
			if (completed.has(compact.id) && completed.has(second.id) && receivedAfter && receivedLeaf) liveDone.resolve();
		});
		entries.push(compact);
		source.onEntryAppended?.(compact);
		entries.push(second);
		source.onEntryAppended?.(second);
		entries.push(after);
		source.onEntryAppended?.(after);
		selectedLeaf = compact.id;
		source.onLeafChanged?.();
		await liveDone.promise;
		const liveFrames = live.frames.slice(liveStart);
		expect(liveFrames.some(frame => frame.t === "compaction-fragment" && frame.scope === "live")).toBe(true);
		expect(entriesFrom(liveFrames, "live")).toEqual([compact, second, after]);
		const firstFragment = (id: string) =>
			liveFrames.findIndex(frame => frame.t === "compaction-fragment" && frame.entryId === id && frame.part === 0);
		const childIndex = liveFrames.findIndex(frame => frame.t === "entry" && frame.entry.id === after.id);
		const leafIndex = liveFrames.findIndex(frame => frame.t === "leaf" && frame.leafId === compact.id);
		expect(firstFragment(compact.id)).toBeGreaterThanOrEqual(0);
		expect(firstFragment(second.id)).toBeGreaterThan(firstFragment(compact.id));
		expect(childIndex).toBeGreaterThan(firstFragment(second.id));
		expect(leafIndex).toBeGreaterThan(firstFragment(compact.id));

		const late = await connect(host, true);
		await late.snapshotDone;
		const welcome = late.frames.find(frame => frame.t === "welcome");
		if (welcome?.t !== "welcome") throw new Error("expected welcome");
		expect(welcome.entryCount).toBe(snapshot.entries.length);
		expect(late.frames.some(frame => frame.t === "compaction-fragment" && frame.scope === "snapshot")).toBe(true);
		expect(entriesFrom(late.frames, "snapshot")).toEqual(entries);
	});

	it("materializes persisted archive frames for a late guest and refuses a missing blob", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "collab-archive-"));
		const oldAgentDir = getAgentDir();
		const oldAgentEnv = process.env.PI_CODING_AGENT_DIR;
		setAgentDir(path.join(root, "agent"));
		cleanups.push(async () => {
			setAgentDir(oldAgentDir);
			if (oldAgentEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentEnv;
			await fs.rm(root, { recursive: true, force: true });
		});

		const frame = {
			data: Buffer.alloc(900_000, 7).toString("base64"),
			mimeType: "image/png" as const,
			cols: 64,
			rows: 40,
			chars: 4,
		};
		const variantFrame = { ...frame, data: Buffer.alloc(100_000, 9).toString("base64") };
		const archiveData: snapcompact.Archive = {
			frames: [frame],
			totalChars: 42,
			truncatedChars: 0,
			text: "archive text",
			withoutThinking: {
				summary: "without thinking",
				archive: { frames: [variantFrame], totalChars: 42, truncatedChars: 0 },
			},
		};
		const sessionDir = path.join(root, "sessions");
		const writer = SessionManager.create(root, sessionDir);
		const anchor = writer.appendMessage({ role: "user", content: "before", timestamp: 1 });
		const compactId = writer.appendCompaction("summary", undefined, anchor, 1000, {
			preserveData: { [snapcompact.PRESERVE_KEY]: archiveData },
		});
		await writer.ensureOnDisk();
		await writer.flush();
		const sessionFile = writer.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const journal = await Bun.file(sessionFile).text();
		const blobHash = journal.match(/blob:sha256:([0-9a-f]{64})/)?.[1];
		if (!blobHash) throw new Error("expected persisted archive blob");
		await writer.close();
		const resumed = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
		cleanups.push(() => resumed.close());
		const stored = resumed.getEntry(compactId);
		if (stored?.type !== "compaction") throw new Error("expected reopened compaction");
		const storedArchive = snapcompact.getPreservedArchive(stored.preserveData);
		if (!storedArchive) throw new Error("expected reopened archive");
		expect(storedArchive.frames[0]?.data).toStartWith("blob:sha256:");
		expect(storedArchive.withoutThinking?.archive.frames[0]?.data).toStartWith("blob:sha256:");

		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());
		const host = new CollabHost(makeHostHarness(resumed).ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));
		const guest = await connect(host, true);
		await guest.snapshotDone;
		const replicated = entriesFrom(guest.frames, "snapshot").find(entry => entry.id === compactId);
		if (replicated?.type !== "compaction") throw new Error("expected guest compaction");
		expect(snapcompact.getPreservedArchive(replicated.preserveData)).toEqual(archiveData);
		expect(storedArchive.frames[0]?.data).toStartWith("blob:sha256:");
		expect(storedArchive.withoutThinking?.archive.frames[0]?.data).toStartWith("blob:sha256:");

		const liveStart = guest.frames.length;
		const liveDone = Promise.withResolvers<void>();
		guest.watch(frame => {
			if (frame.t === "compaction-fragment" && frame.scope === "live" && frame.part === frame.parts - 1)
				liveDone.resolve();
		});
		resumed.onEntryAppended?.(stored);
		await liveDone.promise;
		const live = entriesFrom(guest.frames.slice(liveStart), "live");
		expect(live).toHaveLength(1);
		const liveEntry = live[0];
		if (liveEntry?.type !== "compaction") throw new Error("expected live compaction");
		expect(snapcompact.getPreservedArchive(liveEntry.preserveData)).toEqual(archiveData);

		await fs.rm(path.join(getBlobsDir(), blobHash));
		const missingLiveStart = guest.frames.length;
		resumed.onEntryAppended?.(stored);
		await guest.refused;
		const missingLive = guest.frames.slice(missingLiveStart);
		expect(missingLive.some(frame => frame.t === "bye" || frame.t === "error")).toBe(true);
		expect(missingLive.some(frame => frame.t === "compaction-fragment" || frame.t === "entry")).toBe(false);
		const missingGuest = await connect(host, true);
		await missingGuest.refused;
		expect(missingGuest.frames.some(frame => frame.t === "error" || frame.t === "bye")).toBe(true);
		expect(missingGuest.frames.some(frame => frame.t === "compaction-fragment")).toBe(false);
		expect(
			missingGuest.frames.some(
				frame => frame.t === "snapshot-chunk" && frame.entries.some(entry => entry.id === compactId),
			),
		).toBe(false);
	});

	it("replaces an in-flight snapshot when the guest sends another hello", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());
		const before = userMessage("before", null, "2026-09-13T00:00:00Z", "ordinary");
		const compact = archive("compact", before.id);
		const entries: SessionEntry[] = [before, compact];
		const snapshot: HostSnapshot = {
			header: { type: "session", id: "resync", timestamp: before.timestamp, cwd: "/tmp" },
			entries,
		};
		const host = new CollabHost(makeHostContext(snapshot).ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));
		const guest = await connect(host, true);
		await guest.snapshotDone;
		const start = guest.frames.length;
		const finished = Promise.withResolvers<void>();
		let welcomes = 0;
		let requestedReplacement = false;
		let finalSeen = false;
		let compactSeen = false;
		guest.watch(frame => {
			if (frame.t === "welcome") welcomes++;
			if (welcomes === 1 && frame.t === "compaction-fragment" && !requestedReplacement) {
				requestedReplacement = true;
				guest.sendHello();
			}
			if (welcomes === 2 && frame.t === "snapshot-chunk" && frame.final) finalSeen = true;
			if (welcomes === 2 && frame.t === "compaction-fragment" && frame.part === frame.parts - 1) compactSeen = true;
			if (finalSeen && compactSeen) finished.resolve();
		});
		guest.sendHello();
		await finished.promise;
		const response = guest.frames.slice(start);
		expect(requestedReplacement).toBe(true);
		expect(response.filter(frame => frame.t === "welcome")).toHaveLength(2);
		expect(response.some(frame => frame.t === "error" || frame.t === "bye")).toBe(false);
		const finalWelcome = response.findLastIndex(frame => frame.t === "welcome");
		expect(entriesFrom(response.slice(finalWelcome + 1), "snapshot")).toEqual(entries);
	});

	it("does not send a legacy guest a partial archive", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());
		const before = userMessage("before", null, "2026-09-13T00:00:00Z", "ordinary");
		const compact = archive("compact", before.id);
		const snapshot: HostSnapshot = {
			header: { type: "session", id: "legacy", timestamp: before.timestamp, cwd: "/tmp" },
			entries: [before, compact],
		};
		const host = new CollabHost(makeHostContext(snapshot).ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));
		const legacy = await connect(host, false);
		await legacy.refused;
		expect(legacy.frames.some(frame => frame.t === "compaction-fragment")).toBe(false);
		for (const frame of legacy.frames) {
			if (frame.t === "snapshot-chunk") expect(frame.entries.some(entry => entry.id === compact.id)).toBe(false);
			if (frame.t === "entry") expect(frame.entry.id).not.toBe(compact.id);
		}
	});
	it("disconnects a legacy guest instead of delivering a truncated live archive", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());
		const before = userMessage("before", null, "2026-09-13T00:00:00Z", "ordinary");
		const compact = archive("compact", before.id);
		const entries: SessionEntry[] = [before];
		const snapshot: HostSnapshot = {
			header: { type: "session", id: "legacy-live", timestamp: before.timestamp, cwd: "/tmp" },
			entries,
		};
		const source: HostReplicationSource = {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			getLeafId: () => snapshot.entries.at(-1)?.id ?? null,
			getEntry: id => snapshot.entries.find(entry => entry.id === id),
			snapshotForReplication: () => snapshot,
		};
		const host = new CollabHost(makeHostHarness(source).ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));
		const legacy = await connect(host, false);
		await legacy.snapshotDone;
		entries.push(compact);
		source.onEntryAppended?.(compact);
		await legacy.refused;
		expect(legacy.frames.some(frame => frame.t === "bye" || frame.t === "error")).toBe(true);
		expect(legacy.frames.some(frame => frame.t === "compaction-fragment")).toBe(false);
		expect(legacy.frames.some(frame => frame.t === "entry" && frame.entry.id === compact.id)).toBe(false);
	});
});

describe("serializeReplicatedEntry (#11433)", () => {
	it("does not substitute a placeholder for an entry that already fits", () => {
		// Negative contract: the ceiling may only rewrite a payload it cannot
		// bound. An entry under it must reach the guest verbatim — substituting
		// here would show every ordinary entry as "too large to replicate".
		const small = userMessage("m1", null, "2026-09-13T00:00:00Z", "hi");
		const shrunk = serializeReplicatedEntry(small).value;
		expect(shrunk.type).toBe("message");
		const serialized = JSON.stringify(shrunk);
		expect(serialized).not.toContain(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		expect(serialized).not.toContain("elided for collab session");
	});

	it("clamps a single giant string under the ceiling with an elision marker", () => {
		const entry = userMessage("m1", null, "2026-09-13T00:00:00Z", "x".repeat(5 * 1024 * 1024));
		const shrunk = serializeReplicatedEntry(entry).value;
		expect(shrunk).not.toBe(entry);
		expectBounded(shrunk);
		if (shrunk.type !== "message" || shrunk.message.role !== "user") throw new Error("expected user message");
		expect(shrunk.message.content).toContain("chars elided for collab session");
	});

	it("clamps a payload built of many short strings (no individual oversized)", () => {
		// Realistic shape: a tool result content array with thousands of small
		// text blocks. No individual string crosses the final pass's 64 B
		// floor, so the helper MUST clip the array, not just the strings.
		const content = Array.from({ length: 100_000 }, (_, i) => ({ type: "text", text: `block-${i}` }));
		const entry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "toolResult", content, timestamp: 0 },
		} as unknown as ReplicatedEntry;
		expect(replicationByteLength(entry) ?? 0).toBeGreaterThan(MAX_REPLICATED_PAYLOAD_BYTES);

		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		if (shrunk.type !== "message") throw new Error("expected message entry");
		const shrunkContent = (shrunk.message as unknown as { content: unknown[] }).content;
		expect(Array.isArray(shrunkContent)).toBe(true);
		expect(
			shrunkContent.some(item => typeof item === "string" && item.includes("items elided for collab session")),
		).toBe(true);
	});

	it("replaces an entry whose size lives in one giant object key", () => {
		// Pre-fix: 17,825,798 bytes shipped untouched, because keys are identity
		// and every pass only walked string leaves and array tails.
		const giantKey = "k".repeat(17 * 1024 * 1024);
		const entry = {
			type: "message",
			id: "m1",
			parentId: "parent-1",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
		} as unknown as ReplicatedEntry;

		const shrunk = serializeReplicatedEntry(entry).value;
		expect(shrunk.type).toBe("custom_message");
		expectBounded(shrunk);
		if (shrunk.type !== "custom_message") throw new Error("expected typed placeholder");
		expect(shrunk.customType).toBe(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		// Identity survives, which is what keeps the guest's branch connected.
		expect(shrunk.id).toBe("m1");
		expect(shrunk.parentId).toBe("parent-1");
	});

	it("replaces an entry whose size lives in the number of its keys", () => {
		// Pre-fix: 200,000 short keys shipped as ~5 MB, untouched.
		const blob: Record<string, number> = {};
		for (let i = 0; i < 200_000; i++) blob[`k${i}`] = i;
		const entry = {
			type: "message",
			id: "m2",
			parentId: "parent-2",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob },
		} as unknown as ReplicatedEntry;

		const shrunk = serializeReplicatedEntry(entry).value;
		expect(shrunk.type).toBe("custom_message");
		expectBounded(shrunk);
		expect(shrunk.id).toBe("m2");
	});

	it("degrades a 50,000-deep entry instead of blowing the stack", () => {
		// Pre-fix: recursive walk threw `RangeError: Maximum call stack size
		// exceeded`, and every caller swallows it — the live path silently
		// dropped the entry, the snapshot path stranded the joining guest
		// without a `final` chunk.
		let deep: unknown = "leaf";
		for (let i = 0; i < 50_000; i++) deep = { a: deep };
		const entry = {
			type: "message",
			id: "m3",
			parentId: "parent-3",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: deep },
		} as unknown as ReplicatedEntry;

		const shrunk = serializeReplicatedEntry(entry).value;
		// The depth cap is what makes this serializable at all: the engine's own
		// `JSON.stringify`/`structuredClone` throw at ~40,000 levels, so the
		// walk must emit a shallower clone than it was given.
		expectBounded(shrunk);
		expect(shrunk.id).toBe("m3");
		const roundTripped = JSON.parse(JSON.stringify(shrunk)) as SessionEntry;
		expect(roundTripped.id).toBe("m3");
	});

	it("measures the ceiling in UTF-8 bytes, not UTF-16 code units", () => {
		// 400,000 CJK chars: ~400 KB of code units, so the old
		// `JSON.stringify(...).length` check passed it through untouched, while
		// the relay saw ~1.2 MB — a 3x overshoot on top of the intended cap.
		const entry = userMessage("m4", null, "2026-09-13T00:00:00Z", "中".repeat(400_000));
		const asJson = JSON.stringify(entry);
		expect(asJson.length).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		expect(Buffer.byteLength(asJson, "utf8")).toBeGreaterThan(MAX_REPLICATED_PAYLOAD_BYTES);

		const shrunk = serializeReplicatedEntry(entry).value;
		expect(shrunk).not.toBe(entry);
		expectBounded(shrunk);
	});

	it("degrades a cyclic payload to a marker instead of looping forever", () => {
		// The recursive walk threw on a cycle; an iterative walk would instead
		// follow it forever. Neither is acceptable, and an entry that only has a
		// cycle in one branch should keep the rest of its shape.
		const cyclic: Record<string, unknown> = { id: "m5" };
		cyclic.self = cyclic;
		const entry = {
			type: "message",
			id: "m5",
			parentId: null,
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: cyclic },
		} as unknown as ReplicatedEntry;

		// `JSON.stringify` refuses it outright, so the ceiling cannot even be
		// measured — that is what routes it through the walk rather than
		// returning it by reference.
		expect(replicationByteLength(entry)).toBeNull();

		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		expect(shrunk.id).toBe("m5");
		if (shrunk.type !== "message") throw new Error("expected the message entry to survive");
		const blob = (shrunk.message as unknown as { blob: { self: unknown } }).blob;
		expect(typeof blob.self).toBe("string");
		expect(blob.self).toContain("cyclic reference elided for collab session");
	});

	it("keeps the guest's branch connected across an omitted entry", () => {
		// The full point of preserving id/parentId: the entry after the omitted
		// one still resolves against a branch the guest can walk.
		const giantKey = "k".repeat(17 * 1024 * 1024);
		const omitted = {
			type: "message",
			id: "omitted",
			parentId: "prior",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
		} as unknown as ReplicatedEntry;
		const successor = userMessage("successor", "omitted", "2026-09-13T00:00:01Z", "after");

		const manager = SessionManager.inMemory();
		manager.ingestReplicatedEntry(userMessage("prior", null, "2026-09-13T00:00:00Z", "before"));
		manager.ingestReplicatedEntry(serializeReplicatedEntry(omitted).value);
		manager.ingestReplicatedEntry(successor);

		expect(manager.getBranch().map(entry => entry.id)).toEqual(["prior", "omitted", "successor"]);
	});
});

describe("serializeReplicatedEvent (#11433)", () => {
	it("does not substitute a notice for an event that already fits", () => {
		const event: AgentSessionEvent = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;
		const shrunk = serializeReplicatedEvent(event).value;
		expect(shrunk.type).toBe("agent_end");
		expect(JSON.stringify(shrunk)).not.toContain("Host event omitted");
	});

	it("still shrinks an event whose size lives in a string leaf", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { text: "x".repeat(8 * 1024 * 1024) },
		} as unknown as AgentSessionEvent;

		const shrunk = serializeReplicatedEvent(event).value;
		expect(shrunk).not.toBe(event);
		expect(shrunk.type).toBe("tool_execution_end");
		expectBounded(shrunk);
	});

	it("replaces an unshrinkable event with a notice naming the omitted type", () => {
		// Events carry no id to preserve, and a notice never enters agent state
		// or the model context — so the substitution stays out of the guest's
		// conversation instead of silently diverging from the host's view.
		const giantKey = "k".repeat(17 * 1024 * 1024);
		const event = {
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "read",
			result: { [giantKey]: 1 },
		} as unknown as AgentSessionEvent;

		const shrunk = serializeReplicatedEvent(event).value;
		expect(shrunk.type).toBe("notice");
		expectBounded(shrunk);
		if (shrunk.type !== "notice") throw new Error("expected notice event");
		expect(shrunk.level).toBe("warning");
		expect(shrunk.message).toContain("tool_execution_end");
	});
});

/** `depth`-level nested object. 50 000 is past what the engine's own
 * `structuredClone`/`JSON.stringify` accept on Bun (both throw `RangeError` at
 * roughly 40 000), which is the shape this case needs. */
function nest(depth: number): unknown {
	let node: unknown = "leaf";
	for (let i = 0; i < depth; i++) node = { next: node };
	return node;
}

describe("collab snapshot train over a real SessionManager (#11433)", () => {
	it("degrades a too-deep entry instead of aborting the train before the shrinker", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());

		// Every other host case injects a snapshot object literal, which skips
		// `snapshotForReplication` entirely. This one runs the real manager, so
		// the host's own deep copy of the entries is on the path being tested —
		// the copy that used to throw before the shrinker could bound anything.
		const manager = SessionManager.inMemory();
		manager.ingestReplicatedEntry(userMessage("small-1", null, "2026-09-13T00:00:00Z", "hi"));
		manager.ingestReplicatedEntry({
			type: "message",
			id: "deep-1",
			parentId: "small-1",
			timestamp: "2026-09-13T00:00:01Z",
			message: { role: "user", content: "probe", timestamp: 0, blob: nest(50_000) },
		} as unknown as ReplicatedEntry);

		const harness = makeHostHarness(manager);
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		// Pre-fix this rejected: the throw left `#handleHello` before the chunk
		// train started, so the guest never received a `final` chunk.
		const { frames, closes } = await collectSnapshotTrain(host);
		expect(closes).toEqual([]);

		const chunkEntries: SessionEntry[] = [];
		for (const f of frames) if (f.t === "snapshot-chunk") chunkEntries.push(...f.entries);
		expect(chunkEntries.map(entry => entry.id)).toEqual(["small-1", "deep-1"]);

		// Bounding the depth, not the entry: the too-deep branch is elided, so
		// the entry keeps its own identity and still fits the ceiling — it is
		// not one of the typed placeholders reserved for payloads that cannot be
		// bounded at all.
		const deep = chunkEntries.find(entry => entry.id === "deep-1");
		if (deep?.type !== "message") throw new Error("expected the deep entry to survive as a message entry");
		expect(deep.parentId).toBe("small-1");
		expect(JSON.stringify(deep)).toContain("deeper levels elided for collab session");
		expectBounded(deep);

		const replica = SessionManager.inMemory();
		for (const entry of chunkEntries) replica.ingestReplicatedEntry(entry);
		expect(replica.getBranch().map(entry => entry.id)).toEqual(["small-1", "deep-1"]);
	});
});

describe("collab snapshot train under an unshrinkable entry (#11433)", () => {
	it("terminates the train with final:true and substitutes a typed placeholder", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());

		const snapshot = makeUnshrinkableSnapshot();
		const harness = makeHostContext(snapshot);
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		// Pre-fix the 17.8 MB entry either shipped whole (relay close, guest
		// join aborted) or, once the walk was reached with a deep payload, threw
		// out of the chunker — which `.catch`es to a debug log and leaves the
		// guest waiting for a `final` chunk that never comes.
		const { frames, closes } = await collectSnapshotTrain(host);

		expect(closes).toEqual([]);
		expect(harness.statusMessages.some(msg => msg.includes("reconnecting"))).toBe(false);

		const chunkEntries: SessionEntry[] = [];
		for (const f of frames) if (f.t === "snapshot-chunk") chunkEntries.push(...f.entries);
		expect(chunkEntries.map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));

		const omitted = chunkEntries.find(entry => entry.id === snapshot.omittedEntryId);
		if (omitted?.type !== "custom_message") throw new Error("expected the typed placeholder entry");
		expect(omitted.customType).toBe(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		expect(omitted.parentId).toBe("small-1");
		expect(omitted.display).toBe(true);

		// The replica the guest walks keeps the chain across the substitution.
		const replica = SessionManager.inMemory();
		for (const entry of chunkEntries) replica.ingestReplicatedEntry(entry);
		expect(replica.getBranch().map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));
	});
});

describe("copyForReplication JSON contract (PR #11999 review)", () => {
	it("preserves own __proto__ keys as data instead of mutating the clone's prototype", () => {
		// structuredClone round-trips an own `__proto__` key as data; the walker
		// must too. A plain `{}` destination routes the key through the
		// inherited setter: the metadata silently drops from the guest's JSONL
		// replica and the clone's prototype changes.
		const value: Record<string, unknown> = Object.create(null);
		Object.defineProperty(value, "__proto__", {
			value: { injected: true },
			writable: true,
			enumerable: true,
			configurable: true,
		});
		value.normal = "metadata";

		const copy = copyForReplication(value) as Record<string, unknown>;
		expect(Object.getPrototypeOf(copy)).toBe(null);
		expect(Object.prototype.hasOwnProperty.call(copy, "__proto__")).toBe(true);
		expect((copy.__proto__ as { injected: boolean }).injected).toBe(true);
		// Exact bytes: the own `__proto__` key must appear in the serialized
		// payload (built as a literal it would invoke the setter and vanish).
		expect(JSON.stringify(copy)).toBe('{"__proto__":{"injected":true},"normal":"metadata"}');

		// Nested containers get the same protection: the poisoned key lives one
		// level down, exactly where an extension payload would carry it.
		const nested = copyForReplication({ details: value }) as { details: Record<string, unknown> };
		expect(Object.prototype.hasOwnProperty.call(nested.details, "__proto__")).toBe(true);
		expect(JSON.stringify(nested.details)).toContain("injected");
	});

	it("honors own toJSON on snapshot leaves instead of walking them as empty objects", () => {
		// A Date survives structuredClone and serializes through its `toJSON`;
		// the walker must reflect that contract, not emit `{}` from the Date's
		// empty own-key view. Extension custom_message details are the
		// realistic carrier.
		const date = new Date("2026-09-13T12:00:00.000Z");
		const value = { details: { at: date, label: "x" } };

		const copy = copyForReplication(value) as { details: { at: unknown; label: string } };
		expect(JSON.stringify(copy)).toBe('{"details":{"at":"2026-09-13T12:00:00.000Z","label":"x"}}');
		expect(replicationByteLength(copy)).not.toBe(null);
	});
});

/** A tool-result entry over `content` (and optional `details`), as the host holds it. */
function toolResultEntry(id: string, content: unknown[], details?: unknown): ReplicatedEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-24T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content,
			details,
			isError: false,
			timestamp: 0,
		},
	} as unknown as ReplicatedEntry;
}

/** An image block whose base64 payload is `bytes` long; `seed` keeps blocks distinct. */
function imageBlock(bytes: number, seed = 0): ImageContent {
	return { type: "image", data: String.fromCharCode(65 + (seed % 26)).repeat(bytes), mimeType: "image/png" };
}

describe("collabElided: every trimmed value stays fetchable (#9469)", () => {
	let fixture: TailFixture;
	beforeAll(() => {
		fixture = buildTailFixture();
	});

	it("lists every clipped fixture string at its path in the original entry", () => {
		const entry = fixture.sessionManager.getEntry(fixture.ids.clippedString) as ReplicatedEntry;
		const before = JSON.stringify(entry);
		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		const records = shrunk.collabElided ?? [];
		expect(records.map(r => [r.kind, r.path])).toEqual(
			[0, 1, 2].map(i => ["string", ["message", "content", i, "text"]]),
		);
		for (const record of records) {
			expect(expectFetchable(entry, record)).toHaveLength(450 * 1024);
			expect(valueAtPath(shrunk, record.path)).toContain("chars elided for collab session");
		}
		// The live path hands over the session's own entry: it must come back untouched.
		expect(JSON.stringify(entry)).toBe(before);
	});

	it("sizes a clipped string by the UTF-8 bytes of its JSON", () => {
		const text = 'é"'.repeat(400_000);
		const entry = toolResultEntry("utf8", [
			{ type: "text", text: "ok" },
			{ type: "text", text },
		]);
		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		const [record, ...rest] = shrunk.collabElided ?? [];
		if (!record) throw new Error("expected a string record");
		expect(rest).toEqual([]);
		expect(record.path).toEqual(["message", "content", 1, "text"]);
		// `é` is two bytes and `"` escapes to two: four per pair, plus the JSON quotes.
		expect(record.bytes).toBe(400_000 * 4 + 2);
		expect(expectFetchable(entry, record)).toBe(text);
	});

	it("lists a clipped array by its path, keeping the original's indices", () => {
		const items = Array.from({ length: 200_000 }, (_, i) => i);
		const entry = toolResultEntry("array", [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
			{ type: "text", text: "c", items },
		]);
		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		const records = shrunk.collabElided ?? [];
		expect(records.map(r => [r.kind, r.path])).toEqual([["array", ["message", "content", 2, "items"]]]);
		const [record] = records;
		if (!record) throw new Error("expected an array record");
		expect(expectFetchable(entry, record)).toBe(items);
		expect(valueAtPath(shrunk, [...record.path, 256])).toContain("items elided for collab session");
	});

	it("gives the whole-entry placeholder one entry-level record of the original", () => {
		const entry = fixture.sessionManager.getEntry(fixture.ids.keyHeavy) as ReplicatedEntry;
		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		if (shrunk.type !== "custom_message") throw new Error("expected the typed placeholder");
		expect(shrunk.customType).toBe(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		const records = shrunk.collabElided ?? [];
		expect(records.map(r => [r.kind, r.path])).toEqual([["entry", []]]);
		const [record] = records;
		if (!record) throw new Error("expected an entry record");
		expect(expectFetchable(entry, record)).toBe(entry);
		expect(shrunk.details).toEqual({ omittedType: "message", bytes: record.bytes });
	});

	it("returns an entry that already fits by reference, without metadata", () => {
		const entry = userMessage("fits", null, "2026-09-24T00:00:00Z", "hi");
		const shrunk = serializeReplicatedEntry(entry).value;
		expect(shrunk).toBe(entry);
		expect(shrunk.collabElided).toBeUndefined();
	});

	it("ships an oversized screenshot as an image record, not as clipped base64", () => {
		const entry = fixture.sessionManager.getEntry(fixture.ids.toolImage) as ReplicatedEntry;
		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		expect(valueAtPath(shrunk, ["message", "content", 1])).toEqual({
			type: "text",
			text: expect.stringMatching(/^\[image image\/png, .+ not sent\]$/),
		});
		const records = shrunk.collabElided ?? [];
		expect(records.map(r => [r.kind, r.path, r.mimeType])).toEqual([
			["image", ["message", "content", 1], "image/png"],
		]);
		const [record] = records;
		if (!record) throw new Error("expected an image record");
		expect(expectFetchable(entry, record)).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("keeps records the entry already carries ahead of its own, once each", () => {
		// The host placeholders a whole oversized snapshot's images itself, then
		// shrinks each entry: those records must survive verbatim and not repeat.
		const original = toolResultEntry("prior", [imageBlock(2_000), { type: "text", text: "x".repeat(1_500_000) }]);
		const copy = structuredClone(original);
		expect(placeholdImagesForReplication(copy)).toBe(1);
		const imageRecords = structuredClone(copy.collabElided);
		const shrunk = serializeReplicatedEntry(copy).value;
		expectBounded(shrunk);
		const records = shrunk.collabElided ?? [];
		expect(records.map(r => [r.kind, r.path])).toEqual([
			["image", ["message", "content", 0]],
			["string", ["message", "content", 1, "text"]],
		]);
		expect(records[0]).toEqual(imageRecords?.[0] as CollabElided);
		for (const record of records) expectFetchable(original, record);
	});

	it("hashes a clipped array holding an image placeholder as the original array", () => {
		// The array record is fetched from the host's original, which still has
		// the image — hashing the placeholder copy would make it forever stale.
		const original = toolResultEntry(
			"mixed",
			Array.from({ length: 300 }, (_, i) =>
				i === 3 ? imageBlock(2_000) : { type: "text", text: "t".repeat(5_000) },
			),
		);
		const hostPlaceholdered = structuredClone(original);
		placeholdImagesForReplication(hostPlaceholdered);
		for (const input of [original, hostPlaceholdered]) {
			const shrunk = serializeReplicatedEntry(input).value;
			expectBounded(shrunk);
			const records = shrunk.collabElided ?? [];
			expect(records.map(r => [r.kind, r.path])).toEqual([
				["image", ["message", "content", 3]],
				["array", ["message", "content"]],
			]);
			for (const record of records) expectFetchable(original, record);
		}
	});

	it("addresses the original across an image-only array that lost its image", () => {
		// `details.images` loses its image outright, shifting later elements down.
		// Records inside, of, or around that array must still resolve on the
		// host's original, whoever removed the image.
		const figures = [{ type: "text", text: "figures" }];
		const chart = (text: string) => ({ type: "chart", text });
		const files: Record<string, number> = {};
		for (let i = 0; i < 20_000; i++) files[`src/generated/module-${i}/index.generated.ts`] = i;
		const cases: { entry: ReplicatedEntry; expected: [CollabElided["kind"], (string | number)[]][] }[] = [
			{
				entry: toolResultEntry("inside", figures, { images: [imageBlock(2_000), chart("c".repeat(1_500_000))] }),
				expected: [
					["image", ["message", "details", "images", 0]],
					["string", ["message", "details", "images", 1, "text"]],
				],
			},
			{
				entry: toolResultEntry("of", figures, {
					images: [imageBlock(2_000), ...Array.from({ length: 400 }, (_, i) => chart(`${i}`.padEnd(5_000, "c")))],
				}),
				expected: [
					["image", ["message", "details", "images", 0]],
					["array", ["message", "details", "images"]],
				],
			},
			{
				entry: toolResultEntry("around", figures, { images: [imageBlock(2_000)], files }),
				expected: [["entry", []]],
			},
		];
		for (const { entry: original, expected } of cases) {
			const hostPlaceholdered = structuredClone(original);
			expect(placeholdImagesForReplication(hostPlaceholdered)).toBe(1);
			for (const input of [original, hostPlaceholdered]) {
				const shrunk = serializeReplicatedEntry(input).value;
				expectBounded(shrunk);
				const records = shrunk.collabElided ?? [];
				expect(records.map(r => [r.kind, r.path])).toEqual(expected);
				for (const record of records) expectFetchable(original, record);
			}
		}
	});

	it("collapses more than 64 records into one entry-level record", () => {
		const entry = toolResultEntry(
			"many",
			Array.from({ length: 70 }, (_, i) => ({ type: "text", text: `${i}`.padEnd(20_000, "s") })),
		);
		const shrunk = serializeReplicatedEntry(entry).value;
		expectBounded(shrunk);
		expect(shrunk.type).toBe("message");
		const records = shrunk.collabElided ?? [];
		expect(records.map(r => [r.kind, r.path])).toEqual([["entry", []]]);
		const [record] = records;
		if (!record) throw new Error("expected an entry record");
		expect(expectFetchable(entry, record)).toBe(entry);
	});

	it("collapses image records with the rest, hashing the entry with its images", () => {
		const original = toolResultEntry("many-images", [
			...Array.from({ length: 70 }, (_, i) => imageBlock(1_000, i)),
			{ type: "text", text: "x".repeat(2_000_000) },
		]);
		const hostPlaceholdered = structuredClone(original);
		expect(placeholdImagesForReplication(hostPlaceholdered)).toBe(70);
		for (const input of [original, hostPlaceholdered]) {
			const shrunk = serializeReplicatedEntry(input).value;
			expectBounded(shrunk);
			const records = shrunk.collabElided ?? [];
			expect(records.map(r => [r.kind, r.path])).toEqual([["entry", []]]);
			const [record] = records;
			if (!record) throw new Error("expected an entry record");
			expectFetchable(original, record);
		}
	});
});
