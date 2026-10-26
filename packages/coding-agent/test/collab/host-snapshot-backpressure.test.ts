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
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
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
	const host = new CollabHost(ctx);
	cleanups.push(() => void host.stop("test done"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const received: Received[] = [];
	const join = (who: string): CollabSocket => {
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => guest.close());
		guest.onFrame = frame => received.push({ who, frame });
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: who });
		guest.connect();
		return guest;
	};
	const framesOf = (who: string): CollabFrame[] =>
		received.filter(entry => entry.who === who).map(entry => entry.frame);
	const ended = (): string[] => seen.notices.filter(notice => notice.startsWith("Collab ended"));
	return { ctx, host, probe, snapshot, received, join, framesOf, ended };
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
