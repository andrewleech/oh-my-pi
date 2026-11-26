/**
 * Contract: a full-control guest starts an independent subagent with a `side-request` frame and gets exactly one
 * targeted `side-request-result` for its `reqId`. Read-only and forged peers, bad payloads and a host that is still
 * starting are refused with a targeted `ok:false`; the parent prompt queue is never touched and no other guest sees
 * the request or its result. Wire, auth and validation run for real over the in-memory relay; only the engine
 * (`startSideRequest`) is replaced.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost, type CollabHostOptions, validateSideRequestImages } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as sideRequestModule from "@oh-my-pi/pi-coding-agent/task/side-request";
import { logger } from "@oh-my-pi/pi-utils";
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { waitFor } from "./helpers/throttled-host";

interface Harness {
	host: CollabHost;
	ctx: InteractiveModeContext;
	session: { isStreaming: boolean };
	prompts: unknown[];
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	results(): Extract<CollabFrame, { t: "side-request-result" }>[];
	errors(): string[];
	welcome(): Extract<CollabFrame, { t: "welcome" }>;
	/** Resolves once a targeted frame that follows every earlier reply to this guest has arrived. */
	barrier(): Promise<void>;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
		uninstallInMemoryRelay();
	}
});

async function startHost(options: CollabHostOptions = {}): Promise<Harness> {
	installInMemoryRelay();
	const prompts: unknown[] = [];
	const session = { isStreaming: false };
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-side",
			getCwd: () => "/tmp",
			getLeafId: () => null,
			getEntry: () => undefined,
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-side", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
			onLeafChanged: undefined,
		},
		session: Object.assign(session, {
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			subscribeCommandMetadataChanged: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: unknown) => {
				prompts.push(message);
				return Promise.resolve(true);
			},
			abort: () => Promise.resolve(),
		}),
		updatePendingMessagesDisplay: () => {},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const host = new CollabHost(ctx, options);
	cleanups.push(() => host.stop("test done"));
	await host.start("ws://localhost:8787");
	return { host, ctx, session, prompts };
}

async function join(link: string, name: string, writeTokenOverride?: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		writeTokenOverride ?? (parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => socket.close());
	const frames: CollabFrame[] = [];
	socket.onFrame = frame => frames.push(frame);
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const welcome = () => {
		const found = frames.find(frame => frame.t === "welcome");
		if (found?.t !== "welcome") throw new Error("guest was never welcomed");
		return found;
	};
	let barrierId = 1_000_000;
	const guest: TestGuest = {
		socket,
		frames,
		results: () => frames.filter(frame => frame.t === "side-request-result"),
		errors: () => frames.flatMap(frame => (frame.t === "error" ? [frame.message] : [])),
		welcome,
		// A targeted transcript reply is queued behind every reply the host already owes this guest.
		async barrier() {
			const reqId = ++barrierId;
			socket.send({ t: "fetch-transcript", reqId, agentId: "barrier", fromByte: 0 });
			await waitFor(
				() => frames.some(frame => frame.t === "transcript" && frame.reqId === reqId),
				"barrier reply never arrived",
			);
		},
	};
	await waitFor(() => frames.some(frame => frame.t === "welcome"), `${name} was never welcomed`);
	return guest;
}

function engineSpy() {
	return spyOn(sideRequestModule, "startSideRequest");
}

const PNG: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("collab side requests", () => {
	it("advertises side requests only to full-control peers", async () => {
		const { host } = await startHost();
		const writer = await join(host.link, "writer");
		const viewer = await join(host.viewLink, "viewer");
		const forged = await join(host.viewLink, "forged", Buffer.alloc(16, 1).toString("base64url"));
		expect(writer.welcome().sideRequests).toBe(true);
		expect(viewer.welcome().sideRequests).toBeUndefined();
		expect(forged.welcome().sideRequests).toBeUndefined();
	});

	it("starts a child for a writer without queueing a parent prompt, and answers only the sender", async () => {
		const { host, ctx, session, prompts } = await startHost();
		const engine = engineSpy().mockResolvedValue({ agentId: "0-Side" });
		const sender = await join(host.link, "sender");
		const bystander = await join(host.link, "bystander");
		session.isStreaming = true;

		sender.socket.send({ t: "side-request", reqId: 7, text: "  look into the flaky test  ", images: [PNG] });
		await waitFor(() => sender.results().length > 0, "no result");

		expect(sender.results()).toEqual([{ t: "side-request-result", reqId: 7, ok: true, agentId: "0-Side" }]);
		expect(engine).toHaveBeenCalledTimes(1);
		expect(engine).toHaveBeenCalledWith(ctx, { text: "look into the flaky test", images: [PNG] });
		expect(prompts).toHaveLength(0);
		await bystander.barrier();
		expect(bystander.results()).toHaveLength(0);
		expect(bystander.errors()).toHaveLength(0);

		// An ordinary prompt still reaches the parent.
		sender.socket.send({ t: "prompt", text: "parent prompt" });
		await waitFor(() => prompts.length === 1, "parent prompt never arrived");
	});

	it("refuses read-only and forged-token peers with a targeted result and never starts a child", async () => {
		const { host } = await startHost();
		const engine = engineSpy().mockResolvedValue({ agentId: "must-not-start" });
		const writer = await join(host.link, "writer");
		const viewer = await join(host.viewLink, "viewer");
		const forged = await join(host.viewLink, "forged", Buffer.alloc(16, 9).toString("base64url"));

		viewer.socket.send({ t: "side-request", reqId: 1, text: "do it" });
		forged.socket.send({ t: "side-request", reqId: 2, text: "do it" });
		await waitFor(() => viewer.results().length > 0 && forged.results().length > 0, "refusals never arrived");

		expect(viewer.results()).toMatchObject([{ reqId: 1, ok: false, message: expect.stringContaining("read-only") }]);
		expect(forged.results()).toMatchObject([{ reqId: 2, ok: false, message: expect.stringContaining("read-only") }]);
		expect(engine).not.toHaveBeenCalled();
		await writer.barrier();
		expect(writer.results()).toHaveLength(0);
	});

	it("rejects empty text and invalid attachments before reaching the engine", async () => {
		const { host } = await startHost();
		const engine = engineSpy().mockResolvedValue({ agentId: "0-Side" });
		const writer = await join(host.link, "writer");
		const bad: [number, unknown, unknown, string][] = [
			[1, "   \n", undefined, "empty"],
			[2, 42, undefined, "empty"],
			[3, "go", [{ ...PNG, mimeType: "text/html" }], "unsupported type"],
			[4, "go", [{ ...PNG, data: "not base64!" }], "base64"],
			[5, "go", [{ ...PNG, data: "" }], "empty image data"],
			[6, "go", [{ type: "text", text: "x" }], "not an image"],
			[7, "go", "png", "must be a list"],
			[8, "x".repeat(32_769), undefined, "longer than 32768"],
			[9, "go", [PNG, PNG, PNG, PNG, PNG], "at most 4 images"],
		];
		for (const [reqId, text, images] of bad) {
			writer.socket.send({ t: "side-request", reqId, text, images } as unknown as CollabFrame);
		}
		await waitFor(() => writer.results().length === bad.length, "not every rejection arrived");

		for (const [reqId, , , fragment] of bad) {
			const result = writer.results().find(r => r.reqId === reqId);
			expect(result).toMatchObject({ ok: false, message: expect.stringContaining(fragment) });
		}
		expect(engine).not.toHaveBeenCalled();
	});

	it("answers a malformed reqId with a plain error frame and does not start a child", async () => {
		const { host } = await startHost();
		const engine = engineSpy().mockResolvedValue({ agentId: "0-Side" });
		const writer = await join(host.link, "writer");
		for (const reqId of [0, -3, 1.5, "7"]) {
			writer.socket.send({ t: "side-request", reqId, text: "go" } as unknown as CollabFrame);
		}
		await waitFor(() => writer.errors().length === 4, "errors never arrived");
		expect(writer.results()).toHaveLength(0);
		expect(engine).not.toHaveBeenCalled();
	});

	it("refuses a request while the host is still starting up", async () => {
		let ready = false;
		const { host } = await startHost({ guestActionsReady: () => ready });
		const engine = engineSpy().mockResolvedValue({ agentId: "0-Side" });
		const writer = await join(host.link, "writer");

		writer.socket.send({ t: "side-request", reqId: 1, text: "too early" });
		await waitFor(() => writer.results().length === 1, "no refusal");
		expect(writer.results()[0]).toMatchObject({
			reqId: 1,
			ok: false,
			message: expect.stringContaining("starting up"),
		});
		expect(engine).not.toHaveBeenCalled();

		ready = true;
		writer.socket.send({ t: "side-request", reqId: 2, text: "now" });
		await waitFor(() => writer.results().length === 2, "no result after startup");
		expect(writer.results()[1]).toMatchObject({ reqId: 2, ok: true });
	});

	it("runs one side request per peer at a time while other peers proceed independently", async () => {
		const { host } = await startHost();
		const gates = new Map<string, PromiseWithResolvers<{ agentId: string }>>();
		const engine = engineSpy().mockImplementation(async (_ctx, request) => {
			const gate = Promise.withResolvers<{ agentId: string }>();
			gates.set(request.text, gate);
			return gate.promise;
		});
		const first = await join(host.link, "first");
		const second = await join(host.link, "second");

		first.socket.send({ t: "side-request", reqId: 1, text: "a" });
		second.socket.send({ t: "side-request", reqId: 1, text: "c" });
		await waitFor(() => gates.size === 2, "engine never saw both peers' requests");
		first.socket.send({ t: "side-request", reqId: 2, text: "b" });
		await waitFor(() => first.results().length === 1, "no refusal for the second request");
		expect(first.results()[0]).toEqual({
			t: "side-request-result",
			reqId: 2,
			ok: false,
			message: "a side request is already starting",
		});
		expect(engine).toHaveBeenCalledTimes(2);

		gates.get("c")!.resolve({ agentId: "0-C" });
		gates.get("a")!.resolve({ agentId: "0-A" });
		await waitFor(() => first.results().length === 2 && second.results().length === 1, "results missing");
		expect(first.results()[1]).toEqual({ t: "side-request-result", reqId: 1, ok: true, agentId: "0-A" });
		expect(second.results()).toEqual([{ t: "side-request-result", reqId: 1, ok: true, agentId: "0-C" }]);

		// The slot frees once a request settles, successfully or not.
		first.socket.send({ t: "side-request", reqId: 3, text: "d" });
		await waitFor(() => gates.has("d"), "engine never saw the next request");
		gates.get("d")!.reject(new sideRequestModule.SideRequestError("no model available"));
		await waitFor(() => first.results().length === 3, "no failure result");
		first.socket.send({ t: "side-request", reqId: 4, text: "e" });
		await waitFor(() => gates.has("e"), "slot was not freed after a failure");
	});

	it("tells the guest an engine error's message but hides any other failure's detail", async () => {
		const { host } = await startHost();
		const engine = engineSpy()
			.mockRejectedValueOnce(new sideRequestModule.SideRequestError("no model available"))
			.mockRejectedValueOnce(new Error("ENOENT: /home/host-user/.omp/secret-path"));
		const warn = spyOn(logger, "warn");
		const writer = await join(host.link, "writer");

		writer.socket.send({ t: "side-request", reqId: 1, text: "private task text" });
		await waitFor(() => writer.results().length === 1, "no first result");
		writer.socket.send({ t: "side-request", reqId: 2, text: "private task text" });
		await waitFor(() => writer.results().length === 2, "no second result");

		expect(engine).toHaveBeenCalledTimes(2);
		expect(writer.results()[0]).toMatchObject({ reqId: 1, ok: false, message: "no model available" });
		expect(writer.results()[1]).toEqual({
			t: "side-request-result",
			reqId: 2,
			ok: false,
			message: "side request failed to start; see the host log",
		});
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain("secret-path");
		expect(logged).not.toContain("private task text");
	});

	it("hands the engine images rebuilt from the whitelisted fields only", async () => {
		const { host } = await startHost();
		const engine = engineSpy().mockResolvedValue({ agentId: "0-Side" });
		const writer = await join(host.link, "writer");

		writer.socket.send({
			t: "side-request",
			reqId: 1,
			text: "look",
			images: [{ ...PNG, extra: "dropped", detail: { nested: true } }],
		} as unknown as CollabFrame);
		await waitFor(() => writer.results().length === 1, "no result");

		const sent = engine.mock.calls[0]![1].images![0]!;
		expect(Object.keys(sent).sort()).toEqual(["data", "mimeType", "type"]);
		expect(sent).toEqual(PNG);
	});

	it("caps the total decoded size of side request images", () => {
		// 8 bytes per image once decoded.
		const image = { ...PNG, data: "AAAAAAAAAAA=" };
		expect(validateSideRequestImages([image, image], 16)).toEqual({ images: [image, image] });
		expect(validateSideRequestImages([image, image, image], 16)).toEqual({
			problem: "side request images are too large",
		});
	});

	it("rejects a reqId that is still in progress without answering the original", async () => {
		const { host } = await startHost();
		const gate = Promise.withResolvers<{ agentId: string }>();
		const engine = engineSpy().mockReturnValue(gate.promise);
		const writer = await join(host.link, "writer");

		writer.socket.send({ t: "side-request", reqId: 5, text: "slow" });
		await waitFor(() => engine.mock.calls.length === 1, "engine never started");
		writer.socket.send({ t: "side-request", reqId: 5, text: "again" });
		await waitFor(() => writer.errors().length === 1, "no duplicate error");
		expect(engine).toHaveBeenCalledTimes(1);
		expect(writer.results()).toHaveLength(0);

		gate.resolve({ agentId: "0-Slow" });
		await waitFor(() => writer.results().length === 1, "no result");
		expect(writer.results()).toEqual([{ t: "side-request-result", reqId: 5, ok: true, agentId: "0-Slow" }]);
	});

	it("survives the sender leaving mid-setup and keeps serving other guests", async () => {
		const { host } = await startHost();
		const gate = Promise.withResolvers<{ agentId: string }>();
		const engine = engineSpy().mockReturnValueOnce(gate.promise).mockResolvedValue({ agentId: "0-Next" });
		const leaver = await join(host.link, "leaver");
		const other = await join(host.link, "other");

		leaver.socket.send({ t: "side-request", reqId: 1, text: "slow" });
		await waitFor(() => engine.mock.calls.length === 1, "engine never started");
		leaver.socket.close();
		await waitFor(() => host.participants.every(p => p.name !== "leaver"), "leaver never left");
		gate.resolve({ agentId: "0-Orphan" });

		other.socket.send({ t: "side-request", reqId: 1, text: "next" });
		await waitFor(() => other.results().length === 1, "other guest got no result");
		expect(other.results()).toEqual([{ t: "side-request-result", reqId: 1, ok: true, agentId: "0-Next" }]);
		expect(leaver.results()).toHaveLength(0);
	});
});
