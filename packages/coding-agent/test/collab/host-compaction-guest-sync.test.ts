/**
 * Contract: after the host compacts, a joined guest's replicated model context
 * must collapse behind the compaction summary exactly as the host's does —
 * appending the compaction entry alone leaves the guest holding the stale
 * pre-compaction transcript (issue #9781).
 *
 * A real host `SessionManager` broadcasts live entries through `CollabHost`; a
 * real guest `CollabGuestLink` (backed by a real `AgentSession`) applies them.
 * The in-memory relay (see ./helpers/in-memory-relay) runs the real socket,
 * host, and guest unchanged, so the full welcome → snapshot → live-entry path
 * is exercised.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

/** Minimal host `InteractiveModeContext`: only the members `CollabHost` reads. */
function makeHostContext(manager: SessionManager): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: manager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
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
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface GuestHarness {
	guest: CollabGuestLink;
	session: AgentSession;
	ctx: InteractiveModeContext;
	statuses: string[];
	dispose: () => Promise<void>;
}

/**
 * Real guest: a live `AgentSession` + `SessionManager` behind a `CollabGuestLink`.
 * Every UI touchpoint the join/finalize/apply path calls is a no-op double; the
 * session and manager are real so `session.messages` reflects the replicated
 * (and rebuilt-on-compaction) model context.
 */
function makeGuestHarness(model: Model, modelRegistry: ModelRegistry): GuestHarness {
	const tempDir = TempDir.createSync("@pi-collab-guest-sync-");
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated(), modelRegistry });
	const statuses: string[] = [];

	const ctx = {
		settings: Settings.isolated(),
		sessionManager: manager,
		session,
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		ensureLoadingAnimation: () => {},
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			resetActiveTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		showStatus: (message: string) => { statuses.push(message); },
		showError: (message: string) => { statuses.push(message); },
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		eventBus: undefined,
		collabGuest: undefined,
		handleResumeSession: (path: string) => session.switchSession(path),
		updateEditorBorderColor: () => {},
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	return {
		guest,
		ctx,
		statuses,
		session,
		dispose: async () => {
			await guest.leave("test cleanup").catch(() => {});
			await session.dispose().catch(() => {});
			await tempDir.remove().catch(() => {});
		},
	};
}

// Frames traverse the real CollabSocket, whose AES-GCM seal/open run on
// WebCrypto — genuine async that resolves on the event loop, not on a clock
// this test controls, so fake timers cannot drive it. Poll event-loop ticks
// until the awaited state lands, bounded by wall time rather than a tick
// count: under a loaded parallel test run 500 zero-delay yields can elapse
// before the WebCrypto work is ever scheduled.
async function settleFrames(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	if (!predicate()) throw new Error("condition not met while settling collab frames");
}

// The guest writes its replica under getConfigRootDir(); redirect the config
// root to a temp HOME so the test never touches the real ~/.omp.
let homedirSpy: Mock<typeof os.homedir> | undefined;
let homeDir: TempDir | undefined;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

beforeAll(() => {
	homeDir = TempDir.createSync("@pi-collab-guest-home-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir.path());
	refreshDirsFromEnv();
	installInMemoryRelay();
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("expected bundled anthropic model");
	model = bundled;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	authStorage.close();
	homedirSpy?.mockRestore();
	refreshDirsFromEnv();
	await homeDir?.remove().catch(() => {});
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const trigger of ["replacement hello", "host resync"] as const) {
	it(`restores a welcomed guest after a rejected ${trigger}, even if its notice is shed`, async () => {
		let hostTransport: CollabSocket | undefined;
		let guestTransport: CollabSocket | undefined;
		let hostWire: FakeWebSocket | undefined;
		let reject = false;
		let refusals = 0;
		let terminalAttempts = 0;
		const sendBatch = CollabSocket.prototype.sendBatch;
		const batchSpy = spyOn(CollabSocket.prototype, "sendBatch").mockImplementation(function (this: CollabSocket, ...args) {
			hostTransport = this;
			if (reject) {
				refusals++;
				args[0][Symbol.iterator]().return?.(undefined);
				return false;
			}
			return sendBatch.call(this, ...args);
		});
		const send = CollabSocket.prototype.send;
		const sendSpy = spyOn(CollabSocket.prototype, "send").mockImplementation(function (this: CollabSocket, frame, peer) {
			if (typeof frame !== "string" && frame.t === "hello") guestTransport = this;
			if (typeof frame !== "string" && frame.t === "bye" && frame.reason.includes("backlog is full")) terminalAttempts++;
			return send.call(this, frame, peer);
		});
		const wireSend = FakeWebSocket.prototype.send;
		const wireSpy = spyOn(FakeWebSocket.prototype, "send").mockImplementation(function (this: FakeWebSocket, data) {
			if (this.role === "host") hostWire = this;
			return wireSend.call(this, data);
		});
		cleanups.push(async () => { batchSpy.mockRestore(); sendSpy.mockRestore(); wireSpy.mockRestore(); });
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "host", timestamp: Date.now() });
		const host = new CollabHost(makeHostContext(manager));
		await host.start("ws://localhost:8788");
		cleanups.push(() => host.stop("test done"));
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);
		harness.ctx.sessionManager.appendMessage({ role: "user", content: "local", timestamp: Date.now() });
		await harness.guest.join(host.link);
		expect(harness.ctx.collabGuest).toBe(harness.guest);
		expect(harness.session.messages.some(message => "content" in message && message.content === "host")).toBe(true);
		hostWire!.bufferedAmount = 64 * 1024;
		reject = true;
		if (trigger === "replacement hello") {
			guestTransport!.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", compactionFragments: true });
		} else {
			hostTransport!.onBacklogDropped!();
		}
		await settleFrames(() => refusals > 0 && terminalAttempts > 0);
		// Fill this peer's queue to discard the admitted terminal notice.
		for (let i = 0; i < 32; i++) hostTransport!.send({ t: "error", message: `queued ${i}` }, 1);
		guestTransport!.send({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
		guestTransport!.send({ t: "prompt", text: "not accepted" });
		await settleFrames(() => terminalAttempts >= 2);
		hostWire!.bufferedAmount = 0;
		await settleFrames(() => harness.ctx.collabGuest === undefined, 10_000);
		expect(harness.statuses).toContain("Collab session ended (Collab transfer backlog is full; reconnect to resync.)");
		expect(harness.session.messages.some(message => "content" in message && message.content === "local")).toBe(true);
		expect(host.stopped).toBe(false);
	}, 20_000);
}

describe("collab host compaction → guest sync (#9781)", () => {
	it("collapses the guest's model context behind the summary after the host compacts", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const keptId = hostManager.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });

		const host = new CollabHost(makeHostContext(hostManager));
		await host.start("ws://localhost:8788");
		cleanups.push(() => host.stop("test done"));

		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);

		await harness.guest.join(host.link);

		// Snapshot replicated the full pre-compaction transcript.
		await settleFrames(() => harness.session.messages.length === 3);
		expect(
			harness.session.messages.map(m => ("content" in m && typeof m.content === "string" ? m.content : m.role)),
		).toEqual(["first", "assistant", "keep"]);

		// Host compacts: everything before `keptId` collapses behind the summary.
		hostManager.appendCompaction("SUMMARY", undefined, keptId, 100);

		await settleFrames(() => harness.session.messages[0]?.role === "compactionSummary");
		const compacted = harness.session.messages;
		expect(compacted).toHaveLength(2);
		expect(compacted[0]).toMatchObject({ role: "compactionSummary", summary: "SUMMARY" });
		expect(compacted[1]).toMatchObject({ role: "user", content: "keep" });
		// The stale pre-compaction turns are gone.
		expect(compacted.some(m => "content" in m && (m.content === "first" || m.content === "reply"))).toBe(false);

		// A live message after compaction builds on the compacted base, not the
		// stale full history.
		hostManager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await settleFrames(() => harness.session.messages.length === 3);
		const withFollowup = harness.session.messages;
		expect(withFollowup[0]?.role).toBe("compactionSummary");
		expect(withFollowup.at(-1)).toMatchObject({ role: "user", content: "after" });
	});
});

describe("collab guest replica identity", () => {
	it("gives the replica its own session id, kept across a resync, so a guest never contends for the host's lease", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const keptId = hostManager.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
		const host = new CollabHost(makeHostContext(hostManager));
		await host.start("ws://localhost:8788");
		cleanups.push(() => host.stop("test done"));
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);

		await harness.guest.join(host.link);
		await settleFrames(() => harness.session.messages.length === 3);

		// The lease is keyed by session id: sharing the host's id would make a
		// guest on the host's machine displace the host (or be displaced).
		const replica = harness.session.sessionManager;
		const replicaId = replica.getSessionId();
		expect(replicaId).not.toBe(hostManager.getSessionId());
		expect(replica.getHeader()?.parentSession).toBe(hostManager.getSessionId());
		// `omp gc` probes this lease: an idle joined guest's replica is live.
		const leaseFree = () => {
			const probe = tryAcquireSessionLease(replicaId);
			probe?.release();
			return probe !== null;
		};
		expect(leaseFree()).toBe(false);

		// A host compaction resyncs the replica. A new id there would hand the
		// lease off and leave the replica briefly unowned.
		hostManager.appendCompaction("SUMMARY", undefined, keptId, 100);
		await settleFrames(() => harness.session.messages[0]?.role === "compactionSummary");
		expect(harness.session.sessionManager.getSessionId()).toBe(replicaId);
		expect(leaseFree()).toBe(false);
	});
});
