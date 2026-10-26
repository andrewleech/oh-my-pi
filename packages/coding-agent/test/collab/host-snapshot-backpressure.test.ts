/**
 * Contract: a guest's welcome snapshot draining over a slow uplink never ends
 * the room, never holds live traffic back from the other guests, and never
 * costs the joining guest a live frame. A send backlog that still outgrows its
 * bound (an unreachable relay, an uplink slower than the live traffic) resyncs
 * guests instead of ending the room.
 *
 * Drives the production `CollabHost` over the in-memory relay, with the host
 * socket's `bufferedAmount` standing in for the uplink. The socket polls a
 * full transport on a real 25 ms timer and seals with real AES-GCM, so the
 * uplink model runs on the real clock rather than fake timers.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { HistoryWindow, TailSnapshotRequest } from "@oh-my-pi/pi-wire";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	HIGH_WATER_MARK,
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	makeSnapshot,
	waitFor,
} from "./helpers/throttled-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

interface Received {
	who: string;
	frame: CollabFrame;
}

async function startHost(snapshotEntries: number, throttle: boolean) {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle });
	const snapshot = makeSnapshot(snapshotEntries);
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	// The host's own session subscription, so a test can stream agent events.
	const listeners: ((event: unknown) => void)[] = [];
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	ctx.session.subscribe = listener => {
		listeners.push(listener as (event: unknown) => void);
		return subscribe(listener);
	};
	const emit = (event: unknown): void => {
		for (const listener of listeners) listener(event);
	};
	const host = new CollabHost(ctx);
	cleanups.push(() => void host.stop("test done"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const received: Received[] = [];
	const join = (who: string, snapshotRequest?: TailSnapshotRequest): CollabSocket => {
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => guest.close());
		guest.onFrame = frame => received.push({ who, frame });
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: who, snapshot: snapshotRequest });
		guest.connect();
		return guest;
	};
	const framesOf = (who: string): CollabFrame[] =>
		received.filter(entry => entry.who === who).map(entry => entry.frame);
	const ended = (): string[] => seen.notices.filter(notice => notice.startsWith("Collab ended"));
	return { ctx, host, probe, snapshot, received, join, framesOf, ended, emit };
}

function tickNotices(frames: CollabFrame[]): string[] {
	return frames.flatMap(frame =>
		frame.t === "event" && frame.event.type === "notice" && frame.event.message.startsWith("tick ")
			? [frame.event.message]
			: [],
	);
}

function snapshotIds(frames: CollabFrame[]): string[] {
	return frames.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries.map(entry => entry.id) : []));
}

function isFinalChunk(frame: CollabFrame): boolean {
	return frame.t === "snapshot-chunk" && frame.final;
}

/** Drain the uplink completely until `predicate` holds. */
async function drainUntil(ws: FakeWebSocket, predicate: () => boolean, message: string): Promise<void> {
	const drain = setInterval(() => {
		ws.bufferedAmount = 0;
	}, 5);
	try {
		await waitFor(predicate, message);
	} finally {
		clearInterval(drain);
	}
}

it("keeps the room and live traffic flowing while a guest's snapshot drains", async () => {
	// ≈ 4 MB: eight 512 KB chunks, each taking 32 ticks of the uplink below.
	const { ctx, host, probe, snapshot, received, join, framesOf, ended } = await startHost(256, true);
	const hostWs = probe.hostSocket();

	join("early");
	await drainUntil(hostWs, () => framesOf("early").some(isFinalChunk), "the first guest never finished joining");

	// The welcome and first chunk go out; the uplink then holds the rest.
	hostWs.bufferedAmount = 0;
	join("late");
	await waitFor(
		() => framesOf("late").some(frame => frame.t === "snapshot-chunk"),
		"the second guest's snapshot never started",
	);
	expect(framesOf("late").some(isFinalChunk)).toBe(false);

	// A busy session over a slow uplink: two live frames per 16 KB drained.
	// Held behind the snapshot, they would pass the 256-frame backlog bound
	// long before the snapshot ends.
	const expected: string[] = [];
	for (let tick = 0; tick < 200; tick++) {
		hostWs.bufferedAmount = Math.max(0, hostWs.bufferedAmount - 16 * 1024);
		for (const half of ["a", "b"]) {
			const message = `tick ${tick}${half}`;
			expected.push(message);
			ctx.session.emitNotice("info", message);
		}
		await Bun.sleep(1);
	}
	expect(ended()).toEqual([]);

	await drainUntil(
		hostWs,
		() =>
			framesOf("late").some(isFinalChunk) &&
			tickNotices(framesOf("early")).length === expected.length &&
			tickNotices(framesOf("late")).length === expected.length,
		"live traffic or the snapshot never arrived",
	);
	expect(ended()).toEqual([]);
	expect(host.stopped).toBe(false);

	// The joined guest saw live traffic while the snapshot was still on its way.
	const firstLive = received.findIndex(entry => entry.who === "early" && tickNotices([entry.frame]).length > 0);
	const lateFinal = received.findIndex(entry => entry.who === "late" && isFinalChunk(entry.frame));
	expect(firstLive).toBeLessThan(lateFinal);
	expect(tickNotices(framesOf("early"))).toEqual(expected);

	// The joining guest got the whole snapshot, in order, and every live frame
	// after its welcome.
	const late = framesOf("late");
	const welcome = late.findIndex(frame => frame.t === "welcome");
	expect(welcome).toBeGreaterThanOrEqual(0);
	const afterWelcome = late.slice(welcome + 1);
	expect(snapshotIds(afterWelcome)).toEqual(snapshot.entries.map(entry => entry.id));
	expect(afterWelcome.filter(isFinalChunk)).toHaveLength(1);
	expect(tickNotices(afterWelcome)).toEqual(expected);
}, 20_000);

it("resyncs a joined guest instead of ending the room when live traffic outruns the uplink", async () => {
	const { ctx, host, probe, snapshot, join, framesOf, ended } = await startHost(96, true);
	const hostWs = probe.hostSocket();

	join("guest");
	await drainUntil(hostWs, () => framesOf("guest").some(isFinalChunk), "the guest never finished joining");
	const welcomesBefore = framesOf("guest").filter(frame => frame.t === "welcome").length;

	// The uplink stalls while the session keeps producing frames.
	hostWs.bufferedAmount = HIGH_WATER_MARK;
	for (let i = 0; i < 300; i++) ctx.session.emitNotice("info", `tick ${i}`);
	expect(ended()).toEqual([]);

	await drainUntil(
		hostWs,
		() => {
			const frames = framesOf("guest");
			const lastWelcome = frames.findLastIndex(frame => frame.t === "welcome");
			return (
				frames.filter(frame => frame.t === "welcome").length > welcomesBefore &&
				frames.slice(lastWelcome).some(isFinalChunk)
			);
		},
		"the guest was never resynced",
	);
	expect(ended()).toEqual([]);
	expect(host.stopped).toBe(false);
	const frames = framesOf("guest");
	const resync = frames.slice(frames.findLastIndex(frame => frame.t === "welcome"));
	expect(snapshotIds(resync)).toEqual(snapshot.entries.map(entry => entry.id));
}, 20_000);

it("sends a tail guest live traffic between its chunks and its tail again on a resync", async () => {
	// ≈ 4 MB of 16 KB turns; a 2 MB tail is four 512 KB chunks.
	const { ctx, host, probe, snapshot, join, framesOf, ended } = await startHost(256, true);
	const hostWs = probe.hostSocket();
	const tailOf = (frames: CollabFrame[]): { history: HistoryWindow | undefined; ids: string[] } => {
		const at = frames.findLastIndex(frame => frame.t === "welcome");
		const welcome = frames[at];
		if (welcome?.t !== "welcome") throw new Error("no welcome");
		return { history: welcome.history, ids: snapshotIds(frames.slice(at)) };
	};

	const guest = join("tail", { mode: "tail", maxBytes: 2 * 1024 * 1024 });
	await waitFor(() => framesOf("tail").some(frame => frame.t === "snapshot-chunk"), "the tail snapshot never started");
	expect(framesOf("tail").some(isFinalChunk)).toBe(false);
	// The uplink drains 16 KB a tick while the session streams, as in the full-snapshot case above.
	const expected: string[] = [];
	for (let tick = 0; tick < 100; tick++) {
		hostWs.bufferedAmount = Math.max(0, hostWs.bufferedAmount - 16 * 1024);
		const message = `tick ${tick}`;
		expected.push(message);
		ctx.session.emitNotice("info", message);
		await Bun.sleep(1);
	}
	await drainUntil(
		hostWs,
		() => framesOf("tail").some(isFinalChunk) && tickNotices(framesOf("tail")).length === expected.length,
		"live traffic or the tail never arrived",
	);
	const joined = framesOf("tail");
	const firstLive = joined.findIndex(frame => tickNotices([frame]).length > 0);
	expect(firstLive).toBeLessThan(joined.findIndex(isFinalChunk));
	expect(tickNotices(joined)).toEqual(expected);
	const first = tailOf(joined);
	expect(first.history?.hasEarlier).toBe(true);
	const startAt = snapshot.entries.findIndex(entry => entry.id === first.history?.startId);
	expect(first.ids).toEqual(snapshot.entries.slice(startAt).map(entry => entry.id));
	expect(first.ids.length).toBeLessThan(snapshot.entries.length);

	// A history page waits behind the stalled uplink when the backlog overflows.
	const batches = spyOn(CollabSocket.prototype, "sendBatch");
	cleanups.push(() => batches.mockRestore());
	hostWs.bufferedAmount = HIGH_WATER_MARK;
	guest.send({ t: "fetch-history", reqId: 1, before: first.history?.startId ?? "", maxBytes: 64 * 1024 });
	await waitFor(() => batches.mock.calls.some(call => call[2] !== true), "the host never queued the history page");
	for (let i = 0; i < 300; i++) ctx.session.emitNotice("info", `overflow ${i}`);
	expect(ended()).toEqual([]);
	await drainUntil(
		hostWs,
		() => {
			const frames = framesOf("tail");
			return (
				frames.filter(frame => frame.t === "welcome").length > 1 &&
				frames.slice(frames.findLastIndex(frame => frame.t === "welcome")).some(isFinalChunk)
			);
		},
		"the tail guest was never resynced",
	);
	expect(tailOf(framesOf("tail"))).toEqual(first);

	// The dropped page released its slot, so the guest can page in history again.
	guest.send({ t: "fetch-history", reqId: 2, before: first.history?.startId ?? "", maxBytes: 64 * 1024 });
	await drainUntil(
		hostWs,
		() => framesOf("tail").some(frame => frame.t === "history" && frame.reqId === 2 && frame.final),
		"the history page after the resync never arrived",
	);
	const page = framesOf("tail").filter(frame => frame.t === "history" && frame.reqId === 2);
	expect(page.map(frame => (frame.t === "history" ? frame.error : "")).filter(Boolean)).toEqual([]);
	expect(page.flatMap(frame => (frame.t === "history" ? frame.entries : [])).length).toBeGreaterThan(0);
	expect(ended()).toEqual([]);
	expect(host.stopped).toBe(false);
}, 20_000);

it("keeps the room when frames pile up while the relay is unreachable", async () => {
	const { ctx, host, probe, join, framesOf, ended } = await startHost(8, false);

	const guest = join("guest");
	await waitFor(() => framesOf("guest").some(isFinalChunk), "the guest never finished joining");

	// The uplink drops; the session keeps producing frames while the socket
	// waits to reconnect.
	const dropped = probe.hostSocket();
	dropped.close();
	guest.close();
	for (let i = 0; i < 300; i++) ctx.session.emitNotice("info", `tick ${i}`);
	expect(ended()).toEqual([]);

	await waitFor(
		() => probe.hostSocket() !== dropped && probe.hostSocket().readyState === FakeWebSocket.OPEN,
		"host never reconnected",
		8_000,
	);
	join("next");
	await waitFor(() => framesOf("next").some(isFinalChunk), "a guest could not join the reconnected room");
	expect(ended()).toEqual([]);
	expect(host.stopped).toBe(false);
}, 20_000);

it("serves several overflows with one resync and one snapshot for every guest", async () => {
	const { ctx, probe, join, framesOf, ended } = await startHost(96, true);
	const hostWs = probe.hostSocket();
	join("a");
	await drainUntil(hostWs, () => framesOf("a").some(isFinalChunk), "guest a never finished joining");
	join("b");
	await drainUntil(hostWs, () => framesOf("b").some(isFinalChunk), "guest b never finished joining");
	const snapshots = spyOn(ctx.sessionManager, "snapshotForReplication");
	cleanups.push(() => snapshots.mockRestore());

	// Enough frames behind a stalled uplink to cross the backlog bound twice.
	hostWs.bufferedAmount = HIGH_WATER_MARK;
	for (let i = 0; i < 600; i++) ctx.session.emitNotice("info", `tick ${i}`);
	const resynced = (who: string): boolean => {
		const frames = framesOf(who);
		return frames.slice(frames.findLastIndex(frame => frame.t === "welcome")).some(isFinalChunk);
	};
	const welcomes = (who: string): number => framesOf(who).filter(frame => frame.t === "welcome").length;
	await drainUntil(
		hostWs,
		() => welcomes("a") > 1 && welcomes("b") > 1 && resynced("a") && resynced("b"),
		"the guests were never resynced",
	);
	expect(ended()).toEqual([]);
	expect(snapshots).toHaveBeenCalledTimes(1);
	expect([welcomes("a"), welcomes("b")]).toEqual([2, 2]);
}, 20_000);

function updateText(frame: CollabFrame): string | undefined {
	if (frame.t !== "event" || frame.event.type !== "message_update") return undefined;
	const { message } = frame.event;
	if (message.role !== "assistant") return undefined;
	const block = message.content[0];
	return block?.type === "text" ? block.text : undefined;
}

/** Every streamed text delta a guest received, in order: what its speech would say. */
function spokenText(frames: CollabFrame[]): string {
	return frames
		.map(frame =>
			frame.t === "event" &&
			frame.event.type === "message_update" &&
			frame.event.assistantMessageEvent.type === "text_delta"
				? frame.event.assistantMessageEvent.delta
				: "",
		)
		.join("");
}

it("finishes a guest's snapshot while streaming updates saturate the uplink", async () => {
	// ≈ 650 KB: two chunks, the second still queued when streaming starts.
	const { probe, join, framesOf, ended, emit } = await startHost(40, true);
	const hostWs = probe.hostSocket();
	join("early");
	await drainUntil(hostWs, () => framesOf("early").some(isFinalChunk), "the first guest never finished joining");
	hostWs.bufferedAmount = 0;
	join("late");
	await waitFor(
		() => framesOf("late").some(frame => frame.t === "snapshot-chunk"),
		"the second guest's snapshot never started",
	);
	expect(framesOf("late").some(isFinalChunk)).toBe(false);

	// Every tick the uplink drains 16 KB while the host streams a 32 KB
	// cumulative message: live traffic alone asks for twice the uplink.
	const body = "x".repeat(32 * 1024);
	const lastUpdate = (who: string): string | undefined => framesOf(who).map(updateText).filter(Boolean).at(-1);
	let lastText = "";
	let spoken = "";
	let finishedAt: number | undefined;
	for (let tick = 0; tick < 600; tick++) {
		hostWs.bufferedAmount = Math.max(0, hostWs.bufferedAmount - 16 * 1024);
		lastText = `${body}${tick}`;
		spoken += `${tick},`;
		emit({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: lastText }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${tick},` },
		});
		if (finishedAt === undefined && framesOf("late").some(isFinalChunk)) finishedAt = tick;
		await Bun.sleep(1);
	}
	expect(finishedAt).toBeDefined();

	await drainUntil(hostWs, () => lastUpdate("early") === lastText, "the latest update never reached the joined guest");
	expect(ended()).toEqual([]);
	expect(framesOf("late").filter(frame => frame.t === "welcome")).toHaveLength(1);
	expect(framesOf("early").filter(frame => frame.t === "welcome")).toHaveLength(1);
	expect(lastUpdate("late")).toBe(lastText);
	// Updates were merged, yet no delta was lost.
	expect(framesOf("early").filter(frame => updateText(frame) !== undefined).length).toBeLessThan(600);
	expect(spokenText(framesOf("early"))).toBe(spoken);
	expect(spokenText(framesOf("late"))).toBe(spoken);
}, 30_000);
