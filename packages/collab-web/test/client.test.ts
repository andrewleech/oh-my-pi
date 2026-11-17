import { describe, expect, it, vi } from "bun:test";
import type {
	AgentSnapshot,
	AssistantMessage,
	GuestFrame,
	HostFrame,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url, packEnvelope } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(entryCount = 0, readOnly?: boolean, rewind?: true, leafId?: string | null): HostFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: AGENTS,
		entryCount,
		readOnly,
		rewind,
		leafId,
	};
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = []): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}
function compactionFragments(scope: "snapshot" | "live") {
	const entry: SessionEntry = {
		type: "compaction",
		id: "compact",
		parentId: null,
		timestamp: "2026-06-12T00:00:01Z",
		summary: "archive 😀\n".repeat(120_000),
		firstKeptEntryId: "first",
		tokensBefore: 123,
	};
	const json = JSON.stringify(entry);
	const size = 64 * 1024;
	const parts = Math.ceil(json.length / size);
	const frames: Extract<HostFrame, { t: "compaction-fragment" }>[] = Array.from({ length: parts }, (_, part) => ({
		t: "compaction-fragment",
		transferId: "transfer",
		scope,
		entryId: entry.id,
		part,
		parts,
		byteLength: new TextEncoder().encode(json).byteLength,
		data: json.slice(part * size, (part + 1) * size),
	}));
	return { entry, frames };
}

describe("GuestClient frame apply", () => {
	it("discards pre-welcome traffic covered by the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		const { frames } = compactionFragments("live");
		const snapshot = messageEntry("snapshot", { role: "user", content: "snapshot", timestamp: 1 });
		client.applyFrameForTest(frames[0]);
		client.applyFrameForTest({ t: "entry", entry: snapshot });
		client.applyFrameForTest({ t: "leaf", leafId: "stale" });
		client.applyFrameForTest(welcomeFrame(1, false, true, "snapshot"));
		client.applyFrameForTest(snapshotChunk([snapshot]));
		for (const frame of frames.slice(1)) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([snapshot]);
		expect(client.getSnapshot().phase).toBe("live");
		client.close();
	});

	it("does not send a frame sealed across an intentional close", async () => {
		const nativeWebSocket = globalThis.WebSocket;
		const sockets: TestWebSocket[] = [];
		class TestWebSocket {
			static readonly OPEN = 1;
			readyState = 1;
			binaryType = "";
			onopen: (() => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: (() => void) | null = null;
			sent: unknown[] = [];
			constructor(_url: string) {
				sockets.push(this);
			}
			send(data: unknown): void {
				this.sent.push(data);
			}
			close(): void {}
		}
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
		const started = Promise.withResolvers<void>();
		const encrypted = Promise.withResolvers<ArrayBuffer>();
		const encryptSpy = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(() => {
			started.resolve();
			return encrypted.promise;
		});
		try {
			const socket = new CollabSocket({ wsUrl: "wss://example.test", role: "guest", key: {} as CryptoKey });
			socket.connect();
			socket.send({ t: "prompt", text: "old" });
			await started.promise;
			socket.close();
			socket.connect();
			encrypted.resolve(new ArrayBuffer(16));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(sockets[1].sent).toEqual([]);
			socket.close();
		} finally {
			encryptSpy.mockRestore();
			Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: nativeWebSocket });
		}
	});

	it("times out a reconnect that never opens", () => {
		vi.useFakeTimers();
		let socket: CollabSocket | undefined;
		const connectSpy = vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			socket = this;
			this.onOpen?.();
		});
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
		try {
			const client = new GuestClient(LINK, "tester");
			client.connect();
			client.applyFrameForTest(welcomeFrame());
			socket!.onClose?.("lost", true);
			vi.advanceTimersByTime(30_000);
			expect(client.getSnapshot().phase).toBe("ended");
			expect(client.getSnapshot().endedReason).toContain("welcome");
		} finally {
			connectSpy.mockRestore();
			sendSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("rejects missing and cyclic snapshot ancestry", () => {
		const missing = new GuestClient(LINK, "tester");
		missing.applyFrameForTest(welcomeFrame(1, false, true, "missing"));
		missing.applyFrameForTest(snapshotChunk([messageEntry("first", { role: "user", content: "hi", timestamp: 1 })]));
		expect(missing.getSnapshot().phase).toBe("ended");
		expect(missing.getSnapshot().endedReason).toContain("missing");
		const cycle = new GuestClient(LINK, "tester");
		cycle.applyFrameForTest(welcomeFrame(1, false, true, "first"));
		cycle.applyFrameForTest(
			snapshotChunk([
				{ ...messageEntry("first", { role: "user", content: "hi", timestamp: 1 }), parentId: "first" },
			]),
		);
		expect(cycle.getSnapshot().phase).toBe("ended");
		expect(cycle.getSnapshot().endedReason).toContain("cycle");
	});

	it("buffers snapshot chunks and live entries between fragments", () => {
		const { entry, frames } = compactionFragments("snapshot");
		const next = messageEntry("next", { role: "user", content: "next", timestamp: 1 });
		const live = messageEntry("live", { role: "user", content: "live", timestamp: 2 });
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(frames[0]);
		client.applyFrameForTest(snapshotChunk([next]));
		client.applyFrameForTest({ t: "entry", entry: live });
		expect(client.getSnapshot().entries).toEqual([]);
		for (const frame of frames.slice(1)) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([entry, next, live]);
		client.close();
	});

	it("does not close a new socket when an old frame fails to decrypt", async () => {
		vi.useFakeTimers();
		const nativeWebSocket = globalThis.WebSocket;
		const sockets: TestWebSocket[] = [];
		class TestWebSocket {
			static readonly OPEN = 1;
			readyState = 1;
			binaryType = "";
			onopen: (() => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: (() => void) | null = null;
			closed = false;
			constructor(_url: string) {
				sockets.push(this);
			}
			send(_data: unknown): void {}
			close(): void {
				this.closed = true;
			}
		}
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
		try {
			const key = Promise.withResolvers<CryptoKey>();
			const socket = new CollabSocket({ wsUrl: "wss://example.test", role: "guest", key: key.promise });
			const closes: string[] = [];
			socket.onClose = reason => closes.push(reason);
			socket.connect();
			sockets[0].onmessage?.({ data: packEnvelope(0, new Uint8Array([1])) } as MessageEvent);
			await Promise.resolve();
			sockets[0].onclose?.({ code: 1006, reason: "lost" } as CloseEvent);
			vi.advanceTimersByTime(2_000);
			expect(sockets).toHaveLength(2);
			key.reject(new Error("old key failed"));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(sockets[1].closed).toBe(false);
			expect(closes).toEqual(["lost"]);
			socket.close();
		} finally {
			Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: nativeWebSocket });
			vi.useRealTimers();
		}
	});

	it("handles a rejected or unanswered hello after reconnect", () => {
		vi.useFakeTimers();
		let socket: CollabSocket | undefined;
		const connectSpy = vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			socket = this;
			this.onOpen?.();
		});
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
		try {
			const rejected = new GuestClient(LINK, "tester");
			rejected.connect();
			rejected.applyFrameForTest(welcomeFrame());
			socket!.onClose?.("lost", true);
			socket!.onOpen?.();
			rejected.applyFrameForTest({ t: "error", message: "join rejected" });
			expect(rejected.getSnapshot().phase).toBe("ended");
			expect(rejected.getSnapshot().endedReason).toBe("join rejected");

			const unanswered = new GuestClient(LINK, "tester");
			unanswered.connect();
			unanswered.applyFrameForTest(welcomeFrame());
			socket!.onClose?.("lost", true);
			socket!.onOpen?.();
			vi.advanceTimersByTime(30_000);
			expect(unanswered.getSnapshot().phase).toBe("ended");
			expect(unanswered.getSnapshot().endedReason).toContain("welcome");
		} finally {
			connectSpy.mockRestore();
			sendSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("rejects early final and overflowing snapshot chunks", () => {
		const entry = messageEntry("first", { role: "user", content: "first", timestamp: 1 });
		const early = new GuestClient(LINK, "tester");
		early.applyFrameForTest(welcomeFrame(2));
		early.applyFrameForTest(snapshotChunk([entry]));
		expect(early.getSnapshot().phase).toBe("ended");
		expect(early.getSnapshot().entries).toEqual([]);
		expect(early.getSnapshot().endedReason).toContain("entry count");

		const overflow = new GuestClient(LINK, "tester");
		overflow.applyFrameForTest(welcomeFrame(1));
		overflow.applyFrameForTest(snapshotChunk([entry, entry], false));
		expect(overflow.getSnapshot().phase).toBe("ended");
		expect(overflow.getSnapshot().entries).toEqual([]);
		expect(overflow.getSnapshot().endedReason).toContain("entry count");
	});

	it("advertises fragment support and resets an interrupted transfer on reconnect", () => {
		const sent: GuestFrame[] = [];
		let socket: CollabSocket | undefined;
		const connectSpy = vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			socket = this;
			this.onOpen?.();
		});
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
		});
		try {
			const client = new GuestClient(LINK, "tester");
			client.connect();
			expect(sent[0]).toMatchObject({ t: "hello", compactionFragments: true });
			const { entry, frames } = compactionFragments("snapshot");
			client.applyFrameForTest(welcomeFrame(1));
			client.applyFrameForTest(frames[0]);
			socket!.onClose?.("connection lost", true);
			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(client.getSnapshot().entries).toEqual([]);
			socket!.onOpen?.();
			expect(sent[1]).toMatchObject({ t: "hello", compactionFragments: true });
			client.applyFrameForTest(welcomeFrame(1));
			for (const frame of frames) client.applyFrameForTest(frame);
			expect(client.getSnapshot().entries).toEqual([entry]);
			client.close();
		} finally {
			connectSpy.mockRestore();
			sendSpy.mockRestore();
		}
	});

	it("assembles an oversized snapshot entry without advancing the logical count early", () => {
		const { entry, frames } = compactionFragments("snapshot");
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(2));
		for (const frame of frames.slice(0, -1)) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([]);
		expect(client.getSnapshot().loading).toEqual({ received: 0, total: 2 });
		client.applyFrameForTest(frames[frames.length - 1]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });
		const next = messageEntry("next", { role: "user", content: "next", timestamp: 1 });
		client.applyFrameForTest(snapshotChunk([next]));
		expect(client.getSnapshot().entries).toEqual([entry, next]);
		client.close();
	});

	it("assembles a live entry before later entries", () => {
		const { entry, frames } = compactionFragments("live");
		const client = liveClient();
		for (const frame of frames.slice(0, -1)) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([]);
		client.applyFrameForTest(frames[frames.length - 1]);
		const next = messageEntry("next", { role: "user", content: "next", timestamp: 1 });
		client.applyFrameForTest({ t: "entry", entry: next });
		expect(client.getSnapshot().entries).toEqual([entry, next]);
		client.close();
	});

	it("rejects malformed transfers without applying them", () => {
		const { frames } = compactionFragments("live");
		const malformed = liveClient();
		malformed.applyFrameForTest(frames[1]);
		expect(malformed.getSnapshot().phase).toBe("ended");
		expect(malformed.getSnapshot().entries).toEqual([]);
	});

	it("buffers interleaved entries and transfers in arrival order", () => {
		const first = compactionFragments("live");
		const second = compactionFragments("live");
		const next = messageEntry("next", { role: "user", content: "next", timestamp: 1 });
		const client = liveClient();
		client.applyFrameForTest(first.frames[0]);
		client.applyFrameForTest({ t: "entry", entry: next });
		const secondFrames = second.frames.map(frame => ({ ...frame, transferId: "second" }));
		for (const frame of secondFrames) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([]);
		for (const frame of first.frames.slice(1)) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([first.entry, next, second.entry]);
		client.close();
	});

	it("discards an incomplete transfer on a fresh welcome", () => {
		const { entry, frames } = compactionFragments("snapshot");
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(1));
		client.applyFrameForTest(frames[0]);
		client.applyFrameForTest(welcomeFrame(1));
		for (const frame of frames) client.applyFrameForTest(frame);
		expect(client.getSnapshot().entries).toEqual([entry]);
		expect(client.getSnapshot().phase).toBe("live");
		client.close();
	});

	it("times out an incomplete live transfer and extends the timeout on progress", () => {
		vi.useFakeTimers();
		try {
			const { frames } = compactionFragments("live");
			const client = liveClient();
			client.applyFrameForTest(frames[0]);
			vi.advanceTimersByTime(29_999);
			client.applyFrameForTest(frames[1]);
			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("live");
			vi.advanceTimersByTime(1);
			expect(client.getSnapshot().phase).toBe("ended");
			expect(client.getSnapshot().endedReason).toContain("compaction fragments");
			expect(client.getSnapshot().entries).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("throws on an invalid link", () => {
		expect(() => new GuestClient("not a link", "tester")).toThrow();
	});

	it("welcome populates the snapshot and goes live", () => {
		const userEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const client = liveClient([userEntry]);
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.header).toEqual(HEADER);
		expect(snap.entries).toEqual([userEntry]);
		expect(snap.state).toEqual(STATE);
		expect(snap.agents).toEqual(AGENTS);
		expect(snap.working).toBe(false);
		expect(snap.stream).toBeNull();
		expect(snap.activeTools.size).toBe(0);
	});

	it("welcome readOnly flag lands in the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(false);
		client.applyFrameForTest(welcomeFrame(0, true));
		expect(client.getSnapshot().readOnly).toBe(true);
	});

	it("publishes only the branch leading to the host leaf and follows later leaf changes", () => {
		const first = { ...messageEntry("e1", { role: "user", content: "first", timestamp: 1 }), parentId: null };
		const active = { ...messageEntry("e2", assistantMessage("answer")), parentId: "e1" };
		const sibling = { ...messageEntry("e3", { role: "user", content: "sibling", timestamp: 3 }), parentId: "e1" };
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(3, false, true, "e2"));
		client.applyFrameForTest(snapshotChunk([first, active, sibling]));
		expect(client.getSnapshot().entries.map(entry => entry.id)).toEqual(["e1", "e2"]);

		client.applyFrameForTest({ t: "leaf", leafId: "e3" });
		expect(client.getSnapshot().entries.map(entry => entry.id)).toEqual(["e1", "e3"]);
	});

	it("sends rewind and resolves the host-provided text and images", async () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(0, false, true));
			const result = client.sendRewind("prompt-1");
			const request = sent[0] as Extract<GuestFrame, { t: "rewind" }>;
			expect(request).toMatchObject({ t: "rewind", entryId: "prompt-1" });
			const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
			client.applyFrameForTest({
				t: "rewind-result",
				reqId: request.reqId,
				draft: "unfinished",
				images: [image],
				replaceDraft: true,
			});
			await expect(result).resolves.toEqual({ draft: "unfinished", images: [image], replaceDraft: true });
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("sends rewind to an assistant entry and leaves the draft alone when the host does not replace it", async () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(0, false, true));
			const result = client.sendRewind("tool-result-2");
			const request = sent[0] as Extract<GuestFrame, { t: "rewind" }>;
			expect(request).toMatchObject({ t: "rewind", entryId: "tool-result-2" });
			client.applyFrameForTest({ t: "rewind-result", reqId: request.reqId, replaceDraft: false });
			await expect(result).resolves.toEqual({ draft: undefined, images: undefined, replaceDraft: false });
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("rejects rewind when the host does not advertise writable rewind support", async () => {
		const client = liveClient();
		await expect(client.sendRewind("prompt-1")).rejects.toThrow("does not support rewind");
	});

	it("times out stalled snapshot chunks and resets the clock on progress", () => {
		vi.useFakeTimers();
		try {
			const firstEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(2));
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			client.applyFrameForTest(snapshotChunk([firstEntry], false));
			expect(client.getSnapshot().entries).toEqual([]);
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			vi.advanceTimersByTime(1);
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("ended");
			expect(snap.endedReason).toBe("timed out waiting for the host's session snapshot");

			const completeClient = new GuestClient(LINK, "tester");
			completeClient.applyFrameForTest(welcomeFrame(1));
			completeClient.applyFrameForTest(snapshotChunk([firstEntry]));
			vi.advanceTimersByTime(30_000);
			expect(completeClient.getSnapshot().phase).toBe("live");
			expect(completeClient.getSnapshot().entries).toEqual([firstEntry]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the transcript on screen through a resync and swaps it in on the final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "again", timestamp: 2 });
		const client = liveClient([e1]);

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		expect(client.getSnapshot().entries).toEqual([e1]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("publishes live entries that arrive mid-snapshot after the snapshot, not inside it", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const live = messageEntry("live", { role: "user", content: "live", timestamp: 3 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "entry", entry: live });
		expect(client.getSnapshot().entries).toEqual([]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2, live]);
	});

	it("drops the finished stream ghost when its entry lands mid-snapshot", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const message = assistantMessage("hello");
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		client.applyFrameForTest({ t: "entry", entry: messageEntry("a1", message) });
		client.applyFrameForTest(snapshotChunk([e2]));

		const snap = client.getSnapshot();
		expect(snap.entries).toEqual([e1, e2, messageEntry("a1", message)]);
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
	});

	it("completes the snapshot once every promised entry arrived, even without a final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1, e2], false));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
	});

	it("message_update sets the stream ghost (synthesizing a missed start)", () => {
		const client = liveClient();
		const partial = assistantMessage("hel");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message: partial } });
		const snap = client.getSnapshot();
		expect(snap.stream).toEqual(partial);
		expect(snap.streamDone).toBe(false);
	});

	it("message_end keeps the ghost until the matching entry lands", () => {
		const client = liveClient();
		const message = assistantMessage("hello");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message } });
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		let snap = client.getSnapshot();
		expect(snap.streamDone).toBe(true);
		expect(snap.stream).toEqual(message);

		client.applyFrameForTest({ t: "entry", entry: messageEntry("e2", message) });
		snap = client.getSnapshot();
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
		expect(snap.entries).toHaveLength(1);
	});

	it("tool start/update/end maintains activeTools", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		let tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.toolName).toBe("bash");
		expect(tool?.intent).toBe("Listing");

		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: "src",
			},
		});
		tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.partialResult).toBe("src");

		client.applyFrameForTest({
			t: "event",
			event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "src\ntest" },
		});
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("agent_start/agent_end and state reconcile the working flag", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot().working).toBe(true);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().working).toBe(false);
	});
	it("a state frame recovers a stuck-idle guest when agent_start was dropped", () => {
		// The host begins streaming mid-turn, but the matching `agent_start`
		// never arrived (e.g. dropped on a reconnect). Before the fix nothing
		// set `working` true except `agent_start`, so the guest stayed idle.
		const client = liveClient();
		expect(client.getSnapshot().working).toBe(false);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } });
		expect(client.getSnapshot().working).toBe(true);
	});

	it("an idle state frame clears a pinned tool card when tool_execution_end was dropped", () => {
		// Host reports idle, but the matching `tool_execution_end` was dropped,
		// leaving a stuck tool card. The authoritative idle signal must clear it.
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		expect(client.getSnapshot().activeTools.size).toBe(1);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("bus progress frames update the progress map", () => {
		const client = liveClient();
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			task: "do things",
			progress: {
				index: 0,
				id: "Sub1",
				agent: "task",
				status: "running",
				task: "do things",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 100,
				cost: 0.01,
				durationMs: 1000,
			},
		};
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload });
		expect(client.getSnapshot().progress.get("Sub1")).toEqual(payload);
	});

	it("publishes streaming frames once per animation frame and flushes them with the next immediate frame", () => {
		vi.useFakeTimers();
		try {
			const client = liveClient();
			let commits = 0;
			client.subscribe(() => commits++);
			for (const text of ["a", "ab", "abc"]) {
				client.applyFrameForTest(
					{ t: "event", event: { type: "message_update", message: assistantMessage(text) } },
					{ flush: false },
				);
			}
			expect(commits).toBe(0);
			expect(client.getSnapshot().stream).toBeNull();

			vi.advanceTimersByTime(16);
			expect(commits).toBe(1);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abc"));

			client.applyFrameForTest(
				{ t: "event", event: { type: "message_update", message: assistantMessage("abcd") } },
				{ flush: false },
			);
			client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } }, { flush: false });
			expect(commits).toBe(2);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abcd"));
			vi.advanceTimersByTime(16);
			expect(commits).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes subagent progress once the host stops listing the agent", () => {
		const client = liveClient();
		const payload = (id: string): SubagentProgressPayload => ({
			index: 0,
			agent: "task",
			task: "t",
			progress: {
				index: 0,
				id,
				agent: "task",
				status: "running",
				task: "t",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		});
		const sub: AgentSnapshot = { ...AGENTS[0]!, id: "Sub1", kind: "sub" };
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload("Sub1") });
		// Progress may outrun its agent's first listing: one unlisted `agents` frame keeps it.
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		client.applyFrameForTest({ t: "agents", agents: [...AGENTS, sub] });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);

		const before = client.getSnapshot().progress;
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		expect(client.getSnapshot().progress).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(false);
		expect(client.getSnapshot().progress).not.toBe(before);
	});

	it("bye ends the session with a reason", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toBe("host left");
	});

	it("error frames append notices", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "error", message: "boom" });
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "boom" });
	});

	it("auto_retry_end failure surfaces an error notice", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "x" },
		});
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "x" });
	});

	it("a pre-welcome error (hello rejection, e.g. protocol mismatch) ends the session with the host's reason", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest({
			t: "error",
			message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${COLLAB_PROTO - 1}`,
		});
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toContain("protocol mismatch");
		expect(snap.endedReason).toContain(`v${COLLAB_PROTO}`);
	});

	it("tracks host UI requests and sends responses", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = liveClient();
			const request = {
				reqId: 7,
				kind: "select" as const,
				title: "Continue?",
				options: ["Yes", { label: "No", description: "Stop here" }],
				selectionMarker: "radio" as const,
			};
			client.applyFrameForTest({ t: "ui-request", request });
			expect(client.getSnapshot().uiRequest).toEqual(request);

			client.sendUiResponse(7, "Yes");
			expect(sent).toEqual([{ t: "ui-response", reqId: 7, value: "Yes" }]);
			expect(client.getSnapshot().uiRequest).toBeNull();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("clears pending host UI requests when the host ends them", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Other", prefill: "draft" },
		});
		expect(client.getSnapshot().uiRequest?.reqId).toBe(8);
		client.applyFrameForTest({ t: "ui-request-end", reqId: 8 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("queues overlapping host UI requests until the active one resolves", () => {
		const client = liveClient();
		const first = { reqId: 9, kind: "select" as const, title: "First?", options: ["A"] };
		const second = { reqId: 10, kind: "editor" as const, title: "Second?", prefill: "draft" };
		client.applyFrameForTest({ t: "ui-request", request: first });
		client.applyFrameForTest({ t: "ui-request", request: second });
		expect(client.getSnapshot().uiRequest).toEqual(first);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 9 });
		expect(client.getSnapshot().uiRequest).toEqual(second);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 10 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("snapshot reference is stable between frames and replaced per frame", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		const after = client.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.agents).not.toBe(before.agents);
		// Non-entry frames must not invalidate entry identity: Transcript's
		// memo and useSyncExternalStore skip their O(n) scans per token.
		expect(after.entries).toBe(before.entries);
	});

	it("replaces the entries reference when entry frames arrive", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "entry",
			entry: {
				type: "message",
				id: "m-new",
				parentId: null,
				timestamp: "2026-06-12T00:00:02Z",
				message: { role: "user", content: "hi", timestamp: 2 },
			},
		});
		const after = client.getSnapshot();
		expect(after.entries).not.toBe(before.entries);
		expect(after.entries).toHaveLength(before.entries.length + 1);
	});
});
