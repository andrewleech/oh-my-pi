/**
 * Contract: a collab guest mirrors lifecycle-relevant host events into the
 * local extension runner. The guest's own agent loop never runs, so the
 * session's extension-event path stays silent for the whole join — without
 * this mirror, extension-installed lifecycle integrations (e.g. Herdr's
 * pane-state reporter) never observe `agent_start`/`agent_end` and report a
 * stale pane state while the host is streaming or settles.
 *
 * A scripted host socket drives a real CollabGuestLink over the in-memory
 * relay, same contract as the other collab guest tests. Determinism uses the
 * same sentinel-`error`-frame barrier as guest-ui-request.test.ts: frames
 * apply strictly in arrival order, so a barrier after the event frames proves
 * they applied.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { CompactionFragmentAssembler, MAX_AUTO_REJOINS } from "@oh-my-pi/pi-wire";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { MappedExtensionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSpeechEnabled, cfgSpeechMode } from "@oh-my-pi/pi-coding-agent/tts/settings";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import * as fsp from "node:fs/promises";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Harness {
	guest: CollabGuestLink;
	hostSocket: CollabSocket;
	/** Mock runner receiving the mirrored events; per-test overrides allowed. */
	runner: {
		hasHandlers: () => boolean;
		emit: (event: MappedExtensionEvent) => Promise<unknown>;
	};
	emitted: MappedExtensionEvent[];
	sessionManager: SessionManager;
	get leafId(): string | null;
	get helloCount(): number;
	get renderCount(): number;
	get reloadCount(): number;
	get loadingAnimationRequests(): number;
	get agentMessages(): AgentMessage[];
	renderedMessages: AgentMessage[][];
	resynced: Promise<void>;
	restored: Promise<void>;
	replicaContents: string[];
	helloSupportsFragments: boolean[];
	drafts: Array<{ text: string; images?: ImageContent[] }>;
	errors: string[];
	statuses: string[];
	send(frame: CollabFrame): void;

	/** Deterministic apply-chain barrier via a sentinel `error` frame. */
	barrier(): Promise<void>;
	cleanup(): Promise<void>;
}

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function userMessage(text: string): Extract<AgentMessage, { role: "user" }> {
	return { role: "user", content: text, timestamp: Date.now() };
}

function compactionFragments(
	entry: Extract<CollabFrame, { t: "entry" }>["entry"],
	scope: "snapshot" | "live",
): Extract<CollabFrame, { t: "compaction-fragment" }>[] {
	const json = JSON.stringify(entry);
	const parts = Math.ceil(json.length / (64 * 1024));
	return Array.from({ length: parts }, (_, part) => ({
		t: "compaction-fragment",
		transferId: `${scope}-${entry.id}`,
		scope,
		entryId: entry.id,
		part,
		parts,
		byteLength: new TextEncoder().encode(json).byteLength,
		data: json.slice(part * 64 * 1024, (part + 1) * 64 * 1024),
	}));
}

function assistantMessage(text: string): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function makeHarness(
	roomId: string,
	options: {
		isStreaming?: boolean;
		rewind?: boolean;
		eventController?: EventController;
		snapshot?: Extract<CollabFrame, { t: "entry" }>["entry"];
		snapshotLeaf?: string | null;
		onSwitch?: (manager: SessionManager, messages: AgentMessage[]) => void | Promise<void>;
		onHello?: (socket: CollabSocket, count: number) => boolean;
	} = {},
): Promise<Harness> {
	const sessionManager = Object.assign(SessionManager.inMemory(), {
		getSessionFile: () => null,
		getSessionName: () => "local session",
		getCwd: () => "/local",
	});
	const drafts: Array<{ text: string; images?: ImageContent[] }> = [];
	const errors: string[] = [];
	const statuses: string[] = [];
	let helloCount = 0;
	const agentMessages: AgentMessage[] = [];
	const renderedMessages: AgentMessage[][] = [];
	const replicaContents: string[] = [];
	const helloSupportsFragments: boolean[] = [];
	let renderCount = 0;
	let reloadCount = 0;
	let loadingAnimationRequests = 0;
	const resynced = Promise.withResolvers<void>();
	const restored = Promise.withResolvers<void>();
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);

	const emitted: MappedExtensionEvent[] = [];
	const runner = {
		hasHandlers: () => true,
		emit: (event: MappedExtensionEvent) => {
			emitted.push(event);
			return Promise.resolve();
		},
	};

	const errorWaiters = new Map<string, () => void>();
	let barrierSeq = 0;
	const barrier = (): Promise<void> => {
		const sentinel = `__barrier_${++barrierSeq}__`;
		const { promise, resolve } = Promise.withResolvers<void>();
		errorWaiters.set(sentinel, resolve);
		const socket = harness.hostSocket;
		socket.send({ t: "error", message: sentinel } as CollabFrame);
		return promise;
	};

	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t !== "hello") return;
		helloCount++;
		helloSupportsFragments.push(frame.compactionFragments === true);
		if (helloCount > 1) resynced.resolve();
		if (options.onHello?.(hostSocket, helloCount)) return;
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
			state: { ...makeState(), isStreaming: options.isStreaming ?? false },
			agents: [],
			entryCount: helloCount === 1 && options.snapshot ? 1 : 0,
			leafId: options.snapshotLeaf,
			rewind: options.rewind ?? true,
		} as CollabFrame);
		if (helloCount === 1 && options.snapshot) {
			for (const fragment of compactionFragments(options.snapshot, "snapshot")) hostSocket.send(fragment);
		}
	};
	hostSocket.connect();
	const send = (frame: CollabFrame): void => {
		hostSocket.send(frame);
	};
	await hostOpen.promise;

	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager,
		editor: {
			setDraft: (text: string, images?: ImageContent[]) => drafts.push({ text, images }),
		},
		session: {
			messages: agentMessages,
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			switchSession: async (file: string) => {
				if (options.snapshot) replicaContents.push(await fsp.readFile(file, "utf8"));
				await options.onSwitch?.(sessionManager, agentMessages);
			},
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
				replaceMessages: (messages: AgentMessage[]) => {
					agentMessages.splice(0, agentMessages.length, ...messages);
				},
			},
			extensionRunner: runner,
		},
		statusContainer: { clear: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		ensureLoadingAnimation: () => {
			loadingAnimationRequests++;
		},
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {
			renderCount++;
			renderedMessages.push([...agentMessages]);
		},
		reloadTodos: () => {
			reloadCount++;
			return Promise.resolve();
		},
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => {
			for (const [sentinel, waiter] of errorWaiters) {
				if (message.includes(sentinel)) {
					errorWaiters.delete(sentinel);
					waiter();
					return;
				}
			}
			errors.push(message);
		},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: options.eventController ?? {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
			if (!guest) restored.resolve();
		},
		eventBus: new EventBus(),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	const harness: Harness = {
		guest,
		hostSocket,
		runner,
		statuses,
		errors,
		emitted,
		sessionManager,
		renderedMessages,
		replicaContents,
		helloSupportsFragments,
		get leafId() {
			return sessionManager.getLeafId();
		},
		drafts,
		send,
		get helloCount() {
			return helloCount;
		},
		get renderCount() {
			return renderCount;
		},
		get reloadCount() {
			return reloadCount;
		},
		get loadingAnimationRequests() {
			return loadingAnimationRequests;
		},
		get agentMessages() {
			return agentMessages;
		},
		resynced: resynced.promise,
		restored: restored.promise,
		barrier,
		cleanup: async () => {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
		},
	};
	await guest.join(link);
	return harness;
}

async function makeSocketHarness(
	roomId: string,
	options?: Parameters<typeof makeHarness>[1],
): Promise<{ harness: Harness; socket: CollabSocket }> {
	const sockets: CollabSocket[] = [];
	const connect = CollabSocket.prototype.connect;
	const spy = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
		sockets.push(this);
		return connect.call(this);
	});
	try {
		const harness = await makeHarness(roomId, options);
		return { harness, socket: sockets[1]! };
	} finally {
		spy.mockRestore();
	}
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest extension lifecycle mirror", () => {
	it("mirrors agent_start and a terminal agent_end to the extension runner", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-1");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			// Terminal settle: no continuation was scheduled on the host.
			expect(ends[0].willContinue).toBeUndefined();
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("distinguishes scheduled continuations from background waits in mirrored agent_end events", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-2");
		try {
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: false },
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: false, awaitingAsyncWork: true },
			} as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends).toHaveLength(2);
			expect(ends[0].willContinue).toBe(true);
			expect(ends[0]).not.toHaveProperty("awaitingAsyncWork");
			expect(ends[1].willContinue).toBe(true);
			expect(ends[1].awaitingAsyncWork).toBe(true);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("resets turn numbering on each agent_start like a local session", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-4");
		try {
			const assistantMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const runTurns = (): void => {
				harness.hostSocket.send({ t: "event", event: { type: "turn_start" } } as CollabFrame);
				harness.hostSocket.send({
					t: "event",
					event: { type: "turn_end", message: assistantMessage, toolResults: [] },
				} as CollabFrame);
			};
			// Two host prompts, two turns each: a local session numbers both
			// runs 0,1 — the mirror must not keep counting across agent_start.
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			const starts = harness.emitted.filter(event => event.type === "turn_start");
			expect(starts.map(event => event.turnIndex)).toEqual([0, 1, 0, 1]);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("detaches message_end payloads from the transcript's live reference", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-5");
		try {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "live" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "message_end");
			expect(ends.length).toBe(1);
			// An extension mutating its notification copy must not rewrite the
			// same object the guest renders from.
			const delivered = ends[0].message;
			expect(delivered).not.toBe(message);
			// The assistant-message shape is the transcript-relevant one here;
			// narrowing via the input object keeps the mutation contract typed.
			const liveAssistant = message as { content: { type: string; text: string }[] };
			const deliveredAssistant = delivered as { content: { type: string; text: string }[] };
			deliveredAssistant.content = [{ type: "text", text: "mutated by extension" }];
			expect(liveAssistant.content[0].text).toBe("live");
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("delivers mirrored events to handlers in emission order", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		// The mock runner resolves agent_start on an externally-gated promise;
		// unordered fire-and-forget would let the agent_end handler complete
		// first and relatch the pane to working after the host settled.
		const harness = await makeHarness("lifecycle-mirror-room-6");
		try {
			const gate = Promise.withResolvers<void>();
			const agentEndDelivered = Promise.withResolvers<void>();
			// Order in which handler delivery begins (runner.emit is invoked).
			const deliveryOrder: string[] = [];
			harness.runner.emit = (event: MappedExtensionEvent) => {
				deliveryOrder.push(event.type);
				if (event.type === "agent_start") {
					return gate.promise as Promise<undefined>;
				}
				if (event.type === "agent_end") agentEndDelivered.resolve();
				return Promise.resolve(undefined);
			};
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			// The gated agent_start must hold agent_end back: emission is
			// chained, so agent_end's handler has not even started yet.
			expect(deliveryOrder).toEqual(["agent_start"]);
			gate.resolve();
			await agentEndDelivered.promise;
			expect(deliveryOrder).toEqual(["agent_start", "agent_end"]);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("synthesizes agent_start when joining while the host is mid-run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		// The host's agent_start predates the join, so no event frame carries
		// it — the welcome's `isStreaming` is the only signal the mirror gets.
		const harness = await makeHarness("lifecycle-mirror-room-7", { isStreaming: true });
		try {
			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("synthesizes a terminal agent_end when leaving mid-run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-8");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			await harness.barrier();
			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);

			// /leave before the host settles: the terminal agent_end frame never
			// arrives, the mirror must unlatch the pane on restore.
			await harness.guest.leave("mid-run");
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			expect(ends[0].willContinue).toBeUndefined();
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("applies a mirrored stream tail in order through the event controller", async () => {
		// The controller reads global settings (speech) when it enqueues a stream delta.
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const updateGate = Promise.withResolvers<void>();
		const handled: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			// A slow streaming rebuild: later events must queue behind it, not overtake it.
			if (event.type === "message_update") await updateGate.promise;
			handled.push(event.type);
		});
		const harness = await makeHarness("lifecycle-mirror-room-9", { eventController: controller });
		try {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "tok" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "message_update",
					message,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok", partial: message },
				},
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [message], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();
			updateGate.resolve();
			// A trailing dispatch settles only after every event queued ahead of it.
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handled.filter(type => type !== "message_start" && type !== "turn_start")).toEqual([
				"message_update",
				"message_end",
				"agent_end",
			]);
		} finally {
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("coalesces a mirrored message_update burst into one handled latest snapshot", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const handledUpdates: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			if (event.type === "message_update") handledUpdates.push(messageText(event.message));
		});
		const harness = await makeHarness("lifecycle-mirror-room-10", { eventController: controller });
		// Hold the coalescing window open: only message_end may flush the burst.
		vi.useFakeTimers();
		try {
			for (const text of ["a", "ab", "abc"]) sendUpdate(harness, makeAssistant(text));
			harness.hostSocket.send({
				t: "event",
				event: { type: "message_end", message: makeAssistant("abc") },
			} as CollabFrame);
			await harness.barrier();
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handledUpdates).toEqual(["abc"]);
		} finally {
			vi.useRealTimers();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("drops a pending coalesced message_update when the guest leaves", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const handled: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			handled.push(event.type);
		});
		const harness = await makeHarness("lifecycle-mirror-room-11", { eventController: controller });
		vi.useFakeTimers();
		try {
			sendUpdate(harness, makeAssistant("tok"));
			await harness.barrier();
			await harness.guest.leave("mid-stream");
			// The coalescing window elapses after the boundary: nothing may flush.
			vi.advanceTimersByTime(1_000);
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handled).not.toContain("message_update");
		} finally {
			vi.useRealTimers();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("speaks the text of updates the host superseded", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgSpeechEnabled.set(settings, true);
		cfgSpeechMode.set(settings, "all");
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const spoken: string[] = [];
		const pushDelta = spyOn(vocalizer, "pushDelta").mockImplementation(text => {
			spoken.push(text);
		});
		const controller = new EventController(createInteractiveModeContext());
		const handleEvent = spyOn(controller, "handleEvent").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-12", { eventController: controller });
		try {
			const start = makeStreamed([]);
			harness.hostSocket.send({ t: "event", event: { type: "message_start", message: start } } as CollabFrame);
			const planned = makeStreamed([{ type: "thinking", thinking: "Plan" }]);
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "message_update",
					message: planned,
					assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Plan", partial: planned },
				},
			} as CollabFrame);
			// The updates carrying " it" and "Hello" were superseded on the host's queue.
			const answered = makeStreamed([
				{ type: "thinking", thinking: "Plan it" },
				{ type: "text", text: "Hello world" },
			]);
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "message_update",
					message: answered,
					assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " world", partial: answered },
				},
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message: answered } } as CollabFrame);
			await harness.barrier();

			expect(spoken).toEqual(["Plan", " it", "Hello", " world"]);
			// Extensions see the same reconstructed stream.
			const extensionDeltas = harness.emitted.flatMap(event =>
				event.type === "message_update" && "delta" in event.assistantMessageEvent
					? [event.assistantMessageEvent.delta]
					: [],
			);
			expect(extensionDeltas).toEqual(["Plan", " it", "Hello", " world"]);
		} finally {
			pushDelta.mockRestore();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});
});

function makeAssistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeStreamed(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function sendUpdate(harness: Harness, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	harness.hostSocket.send({
		t: "event",
		event: {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: message },
		},
	} as CollabFrame);
}

describe("collab guest branch and rewind frames", () => {
	it("does not finish joining when the snapshot leaf is missing", async () => {
		const retry = Promise.withResolvers<CollabSocket>();
		let joined = false;
		const welcome = {
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
			state: makeState(),
			agents: [],
			entryCount: 0,
		} as Extract<CollabFrame, { t: "welcome" }>;
		const pending = makeHarness("guest-missing-snapshot-leaf", {
			onHello: (socket, count) => {
				if (count === 1) socket.send({ ...welcome, leafId: "missing" });
				else retry.resolve(socket);
				return true;
			},
		}).then(harness => {
			joined = true;
			return harness;
		});
		const socket = await retry.promise;
		await Promise.resolve();
		expect(joined).toBe(false);
		socket.send(welcome);
		const harness = await pending;
		try {
			expect(harness.renderCount).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	for (const parentId of ["missing", "leaf"]) {
		it(`rejoins instead of activating snapshot ancestry with parent ${parentId}`, async () => {
			const retry = Promise.withResolvers<CollabSocket>();
			let joined = false;
			const welcome = {
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents: [],
				entryCount: 1,
				leafId: "leaf",
			} as Extract<CollabFrame, { t: "welcome" }>;
			const pending = makeHarness(`guest-invalid-ancestry-${parentId}`, {
				onHello: (socket, count) => {
					if (count === 1) {
						socket.send(welcome);
						socket.send({
							t: "snapshot-chunk",
							entries: [{ type: "message", id: "leaf", parentId, timestamp: new Date().toISOString(), message: userMessage("test") }],
							final: true,
						} as CollabFrame);
					} else retry.resolve(socket);
					return true;
				},
			}).then(harness => {
				joined = true;
				return harness;
			});
			const socket = await retry.promise;
			expect(joined).toBe(false);
			socket.send({ ...welcome, entryCount: 0, leafId: null });
			const harness = await pending;
			try {
				expect(harness.renderCount).toBe(1);
			} finally {
				await harness.cleanup();
			}
		});
	}

	it("resolves transcript replies while a snapshot is in progress", async () => {
		const { harness, socket } = await makeSocketHarness("guest-transcript-during-snapshot");
		try {
			const request = Promise.withResolvers<number>();
			harness.hostSocket.onFrame = frame => {
				if (frame.t === "fetch-transcript") request.resolve(frame.reqId);
			};
			const result = harness.guest.hubRemote.readTranscript("agent", 0);
			const reqId = await request.promise;
			socket.onFrame?.({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents: [],
				entryCount: 1,
			}, 0);
			socket.onFrame?.({ t: "transcript", reqId, text: "received", newSize: 8 }, 0);
			expect(await result).toMatchObject({ text: "received", newSize: 8 });
		} finally {
			await harness.cleanup();
		}
	});

	it("resolves correlated transcript replies while snapshot activation is held", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let switches = 0;
		const { harness, socket } = await makeSocketHarness("guest-transcript-during-activation", {
			onSwitch: () => {
				if (++switches === 2) {
					entered.resolve();
					return release.promise;
				}
			},
		});
		try {
			const requests: number[] = [];
			const received = Promise.withResolvers<void>();
			harness.hostSocket.onFrame = frame => {
				if (frame.t === "fetch-transcript") {
					requests.push(frame.reqId);
					if (requests.length === 2) received.resolve();
				}
			};
			const first = harness.guest.hubRemote.readTranscript("first", 0);
			const second = harness.guest.hubRemote.readTranscript("second", 0);
			await received.promise;
			socket.onFrame?.({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents: [],
				entryCount: 0,
			}, 0);
			await entered.promise;
			let firstResult: unknown = "pending";
			let secondResult: unknown = "pending";
			void first.then(result => { firstResult = result; });
			void second.then(result => { secondResult = result; });
			socket.onFrame?.({ t: "transcript", reqId: requests[1]!, text: "second", newSize: 6 }, 0);
			await Promise.resolve();
			expect(secondResult).toMatchObject({ text: "second", newSize: 6 });
			expect(firstResult).toBe("pending");
			socket.onFrame?.({ t: "transcript", reqId: requests[0]!, text: "first", newSize: 5 }, 0);
			await Promise.resolve();
			expect(firstResult).toMatchObject({ text: "first", newSize: 5 });
		} finally {
			release.resolve();
			await harness.cleanup();
		}
	});

	for (const stage of ["welcome", "snapshot"] as const) {
		it(`rejoins after reconnect ${stage} stalls and restores after the retry limit`, async () => {
			const { harness, socket } = await makeSocketHarness(`guest-reconnect-${stage}-timeout`);
			let helloCount = 0;
			let nextHello = Promise.withResolvers<void>();
			const send = spyOn(socket, "send").mockImplementation(frame => {
				if (typeof frame !== "string" && frame.t === "hello") {
					helloCount++;
					nextHello.resolve();
				}
				return true;
			});
			try {
				vi.useFakeTimers();
				socket.onClose?.("test disconnect", true);
				socket.onOpen?.();
				await nextHello.promise;
				let restored = false;
				void harness.restored.then(() => { restored = true; });
				for (let attempt = 0; attempt <= MAX_AUTO_REJOINS; attempt++) {
					nextHello = Promise.withResolvers<void>();
					if (stage === "snapshot") {
						socket.onFrame?.(
							{
								t: "welcome",
								proto: COLLAB_PROTO,
								header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
								state: makeState(),
								agents: [],
								entryCount: 1,
							},
							0,
						);
						await Promise.resolve();
						await Promise.resolve();
					}
					vi.advanceTimersByTime(30_000);
					if (attempt < MAX_AUTO_REJOINS) {
						await nextHello.promise;
						expect(helloCount).toBe(attempt + 2);
						expect(restored).toBe(false);
						expect(harness.errors).toHaveLength(0);
					}
				}
				vi.useRealTimers();
				await harness.restored;
				expect(helloCount).toBe(MAX_AUTO_REJOINS + 1);
				expect(
					harness.errors.some(error =>
						error.includes(stage === "welcome" ? "host's welcome" : "host's session snapshot"),
					),
				).toBe(true);
			} finally {
				vi.useRealTimers();
				send.mockRestore();
				await harness.cleanup();
			}
		});
	}

	it("restores the local session when the host rejects a reconnect", async () => {
		const { harness, socket } = await makeSocketHarness("guest-reconnect-host-error");
		try {
			const hello = Promise.withResolvers<void>();
			harness.hostSocket.onFrame = frame => {
				if (frame.t === "hello") hello.resolve();
			};
			socket.onClose?.("test disconnect", true);
			socket.onOpen?.();
			await hello.promise;
			harness.send({ t: "error", message: "resync refused" });
			await harness.restored;
			expect(harness.errors).toContain("Collab host: resync refused");
		} finally {
			await harness.cleanup();
		}
	});

	it("handles a terminal frame delivered after a reconnecting close", async () => {
		const { harness, socket } = await makeSocketHarness("guest-close-late-bye");
		try {
			socket.onClose?.("connection lost", true);
			socket.onFrame?.({ t: "bye", reason: "host stopped" }, 0);
			await harness.restored;
			expect(harness.statuses).toContain("Collab session ended (host stopped)");
		} finally {
			await harness.cleanup();
		}
	});

	it("handles a terminal frame queued before a reconnecting close", async () => {
		const { harness, socket } = await makeSocketHarness("guest-close-queued-bye");
		try {
			socket.onFrame?.({ t: "bye", reason: "host stopped" }, 0);
			socket.onClose?.("connection lost", true);
			await harness.restored;
			expect(harness.statuses).toContain("Collab session ended (host stopped)");
		} finally {
			await harness.cleanup();
		}
	});

	it("handles a terminal frame queued behind a rejoin", async () => {
		const { harness, socket } = await makeSocketHarness("guest-rejoin-queued-bye");
		try {
			socket.onFrame?.({ t: "leaf", leafId: "missing-entry" }, 0);
			socket.onFrame?.({ t: "bye", reason: "host stopped" }, 0);
			await harness.restored;
			expect(harness.statuses).toContain("Collab session ended (host stopped)");
		} finally {
			await harness.cleanup();
		}
	});

	it("bounds repeated rejoins for missing snapshot leaves", async () => {
		const { harness, socket } = await makeSocketHarness("guest-missing-leaf-budget");
		try {
			let helloCount = 0;
			let nextHello = Promise.withResolvers<void>();
			harness.hostSocket.onFrame = frame => {
				if (frame.t === "hello") {
					helloCount++;
					nextHello.resolve();
				}
			};
			socket.onFrame?.({ t: "leaf", leafId: "missing" }, 0);
			await nextHello.promise;
			for (let i = 0; i < MAX_AUTO_REJOINS; i++) {
				nextHello = Promise.withResolvers<void>();
				socket.onFrame?.({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [],
					entryCount: 0,
					leafId: "missing",
				}, 0);
				if (i + 1 < MAX_AUTO_REJOINS) await nextHello.promise;
				else await harness.restored;
			}
			expect(helloCount).toBe(MAX_AUTO_REJOINS);
			expect(harness.errors.some(error => error.includes("snapshot leaf was not held"))).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("drops pre-welcome broadcasts on resync and applies post-welcome updates", async () => {
		const { harness, socket } = await makeSocketHarness("guest-resync-welcome-boundary");
		try {
			const hello = Promise.withResolvers<void>();
			harness.hostSocket.onFrame = frame => {
				if (frame.t === "hello") hello.resolve();
			};
			socket.onClose?.("test disconnect", true);
			socket.onOpen?.();
			await hello.promise;
			const makeEntry = (id: string) => ({
				type: "message" as const,
				id,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: userMessage(id),
			});
			const stale = makeEntry("stale-broadcast");
			const live = makeEntry("post-welcome");
			const staleCompaction = {
				type: "compaction",
				id: "stale-compaction",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "old".repeat(60_000),
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				method: "snapcompact",
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			const fragments = compactionFragments(staleCompaction, "live");
			socket.onFrame?.(fragments[0]!, 0);
			socket.onFrame?.({ t: "entry", entry: stale }, 0);
			socket.onFrame?.({ t: "leaf", leafId: stale.id }, 0);
			socket.onFrame?.({ t: "event", event: { type: "agent_start" } }, 0);
			socket.onFrame?.(
				{
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [],
					entryCount: 1,
				},
				0,
			);
			for (const fragment of fragments.slice(1)) socket.onFrame?.(fragment, 0);
			socket.onFrame?.({ t: "entry", entry: live }, 0);
			socket.onFrame?.({ t: "snapshot-chunk", entries: [makeEntry("snapshot-entry")], final: true }, 0);
			await harness.barrier();
			expect(harness.sessionManager.getEntry(stale.id)).toBeUndefined();
			expect(harness.sessionManager.getEntry(staleCompaction.id)).toBeUndefined();
			expect(harness.errors).toEqual([]);
			expect(harness.sessionManager.getEntry(live.id)).toEqual(live);
			expect(harness.leafId).toBe(live.id);
			expect(harness.emitted.some(event => event.type === "agent_start")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("updates the agent context after selecting the snapshot leaf", async () => {
		const oldMessage = userMessage("wrong branch");
		const harness = await makeHarness("guest-snapshot-leaf", {
			snapshotLeaf: null,
			onSwitch: (manager, messages) => {
				manager.appendMessage(oldMessage);
				messages.push(oldMessage);
			},
		});
		try {
			expect(harness.leafId).toBeNull();
			expect(harness.agentMessages).toEqual([]);
			expect(harness.renderedMessages.at(-1)).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});
	it("discards queued frames from a closed connection", async () => {
		const { harness, socket } = await makeSocketHarness("guest-stale-connection");
		try {
			const entry = {
				type: "message",
				id: "stale-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: userMessage("stale"),
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			socket.onFrame?.({ t: "entry", entry }, 0);
			socket.onClose?.("test disconnect", true);
			socket.onOpen?.();
			await harness.resynced;
			await harness.barrier();
			expect(harness.sessionManager.getEntry(entry.id)).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("resyncs when a live compaction transfer stalls", async () => {
		const { harness, socket } = await makeSocketHarness("guest-fragment-timeout");
		try {
			const entry = {
				type: "compaction",
				id: "stalled-compaction",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "x".repeat(150_000),
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				method: "snapcompact",
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			vi.useFakeTimers();
			const fragments = compactionFragments(entry, "live");
			socket.onFrame?.(fragments[0]!, 0);
			await Promise.resolve();
			await Promise.resolve();
			vi.advanceTimersByTime(30_000);
			vi.useRealTimers();
			await harness.resynced;
			await harness.barrier();
			for (const fragment of fragments.slice(1)) socket.onFrame?.(fragment, 0);
			await harness.barrier();
			expect(harness.sessionManager.getEntry(entry.id)).toBeUndefined();
			expect(harness.errors.some(error => error.includes("compaction transfer timed out"))).toBe(true);
			expect(harness.errors).toHaveLength(1);
		} finally {
			vi.useRealTimers();
			await harness.cleanup();
		}
	});

	it("reconstructs a fragmented snapshot entry before activating the replica", async () => {
		const entry = {
			type: "compaction",
			id: "snapshot-compaction",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "snapshot 😀".repeat(120_000),
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			method: "snapcompact",
		} as Extract<CollabFrame, { t: "entry" }>["entry"];
		const harness = await makeHarness("guest-fragment-snapshot", { snapshot: entry });
		try {
			expect(harness.helloSupportsFragments).toEqual([true]);
			expect(harness.replicaContents).toHaveLength(1);
			expect(JSON.parse(harness.replicaContents[0]!.split("\n")[1]!)).toEqual(entry);
		} finally {
			await harness.cleanup();
		}
	});

	it("reconstructs and redraws a fragmented live compaction", async () => {
		const harness = await makeHarness("guest-fragment-live");
		try {
			const keptId = harness.sessionManager.appendMessage(userMessage("kept"));
			const entry = {
				type: "compaction",
				id: "fragmented-compaction",
				parentId: keptId,
				timestamp: new Date().toISOString(),
				summary: "large 😀".repeat(150_000),
				firstKeptEntryId: keptId,
				tokensBefore: 100,
				method: "snapcompact",
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			const before = harness.renderCount;
			for (const fragment of compactionFragments(entry, "live")) harness.send(fragment);
			harness.send({ t: "leaf", leafId: entry.id });
			await harness.barrier();
			expect(harness.sessionManager.getEntry(entry.id)).toEqual(entry);
			expect(harness.renderCount).toBe(before + 1);
			expect(JSON.stringify(harness.renderedMessages.at(-1))).toContain("large 😀");
		} finally {
			await harness.cleanup();
		}
	});

	it("preserves entry order across interleaved live transfers", async () => {
		const harness = await makeHarness("guest-interleaved-live");
		try {
			const kept = harness.sessionManager.appendMessage(userMessage("kept"));
			const first = {
				type: "compaction",
				id: "first-compaction",
				parentId: kept,
				timestamp: new Date().toISOString(),
				summary: "a".repeat(150_000),
				firstKeptEntryId: kept,
				tokensBefore: 100,
				method: "snapcompact",
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			const second = { ...first, id: "second-compaction", parentId: first.id, summary: "b".repeat(150_000) };
			const message = {
				type: "message",
				id: "after-compactions",
				parentId: second.id,
				timestamp: new Date().toISOString(),
				message: userMessage("after"),
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			const a = compactionFragments(first, "live");
			const b = compactionFragments(second, "live");
			harness.send(a[0]!);
			for (const fragment of b) harness.send(fragment);
			harness.send({ t: "entry", entry: message });
			for (const fragment of a.slice(1)) harness.send(fragment);
			await harness.barrier();
			expect(harness.sessionManager.getEntry(first.id)).toEqual(first);
			expect(harness.sessionManager.getEntry(second.id)).toEqual(second);
			expect(harness.sessionManager.getEntry(message.id)).toEqual(message);
			expect(harness.leafId).toBe(message.id);
			expect(harness.helloCount).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("holds interleaved live transfers until the snapshot is active", async () => {
		const snapshot = {
			type: "compaction",
			id: "snapshot-first",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "s".repeat(150_000),
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			method: "snapcompact",
		} as Extract<CollabFrame, { t: "entry" }>["entry"];
		const live = { ...snapshot, id: "live-second", parentId: snapshot.id, summary: "l".repeat(150_000) };
		const message = {
			type: "message",
			id: "live-message",
			parentId: live.id,
			timestamp: new Date().toISOString(),
			message: userMessage("after snapshot"),
		} as Extract<CollabFrame, { t: "entry" }>["entry"];
		const a = compactionFragments(snapshot, "snapshot");
		const b = compactionFragments(live, "live");
		const liveAssembled = Promise.withResolvers<void>();
		const hostReady = Promise.withResolvers<CollabSocket>();
		const accept = CompactionFragmentAssembler.prototype.accept;
		const acceptSpy = spyOn(CompactionFragmentAssembler.prototype, "accept").mockImplementation(
			function (this: CompactionFragmentAssembler, frame) {
				const result = accept.call(this, frame);
				if (frame.transferId === "live-live-second" && result) liveAssembled.resolve();
				return result;
			},
		);
		let joined = false;
		const pending = makeHarness("guest-interleaved-snapshot", {
			onSwitch: manager => manager.ingestReplicatedEntry(snapshot),
			onHello: socket => {
				socket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [],
					entryCount: 1,
				});
				socket.send(a[0]!);
				socket.send(b[0]!);
				for (const fragment of b.slice(1)) socket.send(fragment);
				socket.send({ t: "entry", entry: message });
				hostReady.resolve(socket);
				return true;
			},
		}).then(harness => {
			joined = true;
			return harness;
		});
		let harness: Harness | undefined;
		try {
			await liveAssembled.promise;
			expect(joined).toBe(false);
			const socket = await hostReady.promise;
			for (const fragment of a.slice(1)) socket.send(fragment);
			harness = await pending;
			await harness.barrier();
			expect(harness.sessionManager.getEntry(snapshot.id)).toEqual(snapshot);
			expect(harness.sessionManager.getEntry(live.id)).toEqual(live);
			expect(harness.sessionManager.getEntry(message.id)).toEqual(message);
			expect(harness.leafId).toBe(message.id);
		} finally {
			acceptSpy.mockRestore();
			await harness?.cleanup();
		}
	});
	it("rejects an out-of-order live transfer without applying it", async () => {
		const harness = await makeHarness("guest-fragment-out-of-order");
		try {
			const entry = {
				type: "compaction",
				id: "out-of-order-compaction",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "x".repeat(150_000),
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				method: "snapcompact",
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			const fragments = compactionFragments(entry, "live");
			harness.send(fragments[1]!);
			await harness.resynced;
			await harness.barrier();
			expect(harness.sessionManager.getEntry(entry.id)).toBeUndefined();
			expect(harness.errors.some(error => error.includes("Collab replication failed"))).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("redraws a replicated compaction before a matching leaf and keeps ordinary events working", async () => {
		const harness = await makeHarness("guest-compaction-redraw");
		try {
			const first = userMessage("old prompt");
			const firstId = harness.sessionManager.appendMessage(first);
			const kept = userMessage("kept prompt");
			const keptId = harness.sessionManager.appendMessage(kept);
			const renderBefore = harness.renderCount;
			const entry = {
				type: "compaction",
				id: "host-compaction",
				parentId: keptId,
				timestamp: new Date().toISOString(),
				summary: "compacted history",
				firstKeptEntryId: keptId,
				tokensBefore: 100,
				method: "snapcompact",
			} as Extract<CollabFrame, { t: "entry" }>["entry"];

			harness.send({ t: "entry", entry });
			harness.send({ t: "leaf", leafId: entry.id });
			await harness.barrier();
			expect(harness.leafId).toBe(entry.id);
			expect(harness.renderCount).toBe(renderBefore + 1);
			expect(harness.renderedMessages.at(-1)).toEqual(harness.agentMessages);
			expect(harness.agentMessages).toEqual(harness.sessionManager.buildSessionContext().messages);
			expect(harness.agentMessages).not.toContainEqual(first);
			expect(harness.agentMessages).toContainEqual(kept);
			expect(JSON.stringify(harness.renderedMessages.at(-1))).toContain("compacted history");
			expect(harness.sessionManager.getEntry(firstId)).toBeDefined();
			expect(harness.helloCount).toBe(1);

			const answer = assistantMessage("after compaction");
			harness.send({
				t: "entry",
				entry: {
					type: "message",
					id: "host-next-message",
					parentId: entry.id,
					timestamp: new Date().toISOString(),
					message: answer,
				},
			});
			harness.send({ t: "event", event: { type: "message_end", message: answer } } as CollabFrame);
			await harness.barrier();
			expect(harness.agentMessages).toContainEqual(answer);
			expect(harness.emitted.some(event => event.type === "message_end")).toBe(true);
			expect(harness.renderCount).toBe(renderBefore + 1);
		} finally {
			await harness.cleanup();
		}
	});

	it("rebuilds the guest transcript and model context when the host changes branches", async () => {
		const harness = await makeHarness("guest-rewind");
		try {
			const firstPrompt = userMessage("first prompt");
			const firstId = harness.sessionManager.appendMessage(firstPrompt);
			harness.sessionManager.appendMessage(userMessage("abandoned prompt"));
			const renderBefore = harness.renderCount;

			harness.send({ t: "leaf", leafId: firstId });
			await harness.barrier();
			expect(harness.leafId).toBe(firstId);
			expect(harness.agentMessages).toEqual([firstPrompt]);
			expect(harness.renderCount).toBe(renderBefore + 1);
			expect(harness.reloadCount).toBe(2);

			const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as ImageContent;
			harness.guest.rewind(firstId);
			await harness.barrier();
			harness.send({ t: "rewind-result", reqId: 1, draft: "restore this", images: [image], replaceDraft: true });
			await harness.barrier();
			expect(harness.drafts).toEqual([{ text: "restore this", images: [image] }]);
			expect(harness.errors).toEqual([]);

			harness.send({ t: "leaf", leafId: null });
			await harness.barrier();
			expect(harness.leafId).toBeNull();
			expect(harness.agentMessages).toEqual([]);
			expect(harness.renderCount).toBe(renderBefore + 2);
		} finally {
			await harness.cleanup();
		}
	});

	it("resends a retry only after the host confirms the rewind", async () => {
		const harness = await makeHarness("guest-rewind-retry");
		try {
			const sendPrompt = spyOn(harness.guest, "sendPrompt");
			const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as ImageContent;
			harness.guest.rewind("known-entry", true);
			expect(sendPrompt).not.toHaveBeenCalled();

			harness.send({ t: "rewind-result", reqId: 1, draft: "retry this", images: [image], replaceDraft: true });
			await harness.barrier();
			expect(sendPrompt).toHaveBeenCalledTimes(1);
			expect(sendPrompt).toHaveBeenCalledWith("retry this", [image]);
			expect(harness.drafts).toEqual([]);

			harness.send({ t: "rewind-result", reqId: 1, draft: "retry this", replaceDraft: true });
			await harness.barrier();
			expect(sendPrompt).toHaveBeenCalledTimes(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("drops a pending retry on rejoin and ignores its late result", async () => {
		const harness = await makeHarness("guest-rewind-retry-rejoin");
		try {
			const sendPrompt = spyOn(harness.guest, "sendPrompt");
			harness.guest.rewind("known-entry", true);
			harness.send({ t: "leaf", leafId: "missing-entry" });
			await harness.resynced;
			await harness.barrier();
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toMatch(/rewind.*unknown/i);
			expect(harness.errors[0]).toMatch(/check.*transcript/i);

			harness.guest.rewind("another-entry", true);
			harness.send({ t: "rewind-result", reqId: 1, draft: "stale", replaceDraft: true });
			await harness.barrier();
			expect(sendPrompt).not.toHaveBeenCalled();
			expect(harness.drafts).toEqual([]);
			expect(harness.errors).toHaveLength(1);

			harness.send({ t: "rewind-result", reqId: 2, draft: "current", replaceDraft: true });
			await harness.barrier();
			expect(sendPrompt).toHaveBeenCalledTimes(1);
			expect(sendPrompt).toHaveBeenCalledWith("current", undefined);
			expect(harness.errors).toHaveLength(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("preserves a retry sent after hello and before welcome", async () => {
		const received = Promise.withResolvers<Extract<CollabFrame, { t: "rewind" }>>();
		const harness = await makeHarness("guest-rewind-retry-before-welcome", {
			onHello: (socket, count) => {
				if (count === 1) return false;
				socket.onFrame = frame => {
					if (frame.t === "rewind") received.resolve(frame);
				};
				return true;
			},
		});
		try {
			const sendPrompt = spyOn(harness.guest, "sendPrompt");
			harness.guest.rewind("old-entry", true);
			harness.send({ t: "leaf", leafId: "missing-entry" });
			await harness.resynced;
			expect(harness.errors).toHaveLength(1);

			harness.guest.rewind("new-entry", true);
			const request = await received.promise;
			expect(request.entryId).toBe("new-entry");
			expect(request.reqId).toBe(2);
			expect(sendPrompt).not.toHaveBeenCalled();
			harness.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents: [],
				entryCount: 0,
				rewind: true,
			});
			harness.send({ t: "rewind-result", reqId: request.reqId, draft: "retry", replaceDraft: true });
			await harness.barrier();
			expect(sendPrompt).toHaveBeenCalledTimes(1);
			expect(sendPrompt).toHaveBeenCalledWith("retry", undefined);
			expect(harness.errors).toHaveLength(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not resend a retry when rewind fails or does not replace the draft", async () => {
		const harness = await makeHarness("guest-rewind-retry-error");
		try {
			const sendPrompt = spyOn(harness.guest, "sendPrompt");
			harness.guest.rewind("known-entry", true);
			harness.send({ t: "rewind-result", reqId: 1, error: "selected prompt unavailable" });
			await harness.barrier();
			expect(sendPrompt).not.toHaveBeenCalled();
			expect(harness.errors).toContain("Collab rewind failed: selected prompt unavailable");
			harness.guest.rewind("another-entry", true);
			harness.send({ t: "rewind-result", reqId: 2, draft: "not replaced" });
			await harness.barrier();
			expect(sendPrompt).not.toHaveBeenCalled();
			expect(harness.drafts).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps a streaming guest aligned after a host branch change and turn completion", async () => {
		const harness = await makeHarness("guest-rewind-streaming", { isStreaming: true });
		try {
			const prompt = userMessage("active prompt");
			const promptId = harness.sessionManager.appendMessage(prompt);
			harness.sessionManager.appendMessage(userMessage("abandoned prompt"));
			const renderBefore = harness.renderCount;
			const loadingBefore = harness.loadingAnimationRequests;

			harness.send({ t: "leaf", leafId: promptId });
			await harness.barrier();
			expect(harness.agentMessages).toEqual([prompt]);
			expect(harness.renderCount).toBe(renderBefore + 1);
			expect(harness.loadingAnimationRequests).toBe(loadingBefore + 1);
			expect(harness.guest.state?.isStreaming).toBe(true);

			const answer = assistantMessage("answer");
			const responseEntry = {
				type: "message",
				id: "host-answer",
				parentId: promptId,
				timestamp: new Date().toISOString(),
				message: answer,
			} as Extract<CollabFrame, { t: "entry" }>["entry"];
			harness.send({ t: "entry", entry: responseEntry });
			await harness.barrier();
			harness.send({ t: "state", state: { ...makeState(), isStreaming: false } });
			await harness.barrier();

			expect(harness.sessionManager.getBranch().map(entry => entry.id)).toEqual([promptId, responseEntry.id]);
			expect(harness.agentMessages).toEqual([prompt, answer]);
			expect(harness.guest.state?.isStreaming).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("surfaces rewind errors without changing the draft", async () => {
		const harness = await makeHarness("guest-rewind-error");
		try {
			harness.guest.rewind("known-entry");
			await harness.barrier();
			harness.send({ t: "rewind-result", reqId: 1, error: "selected prompt unavailable" });
			await harness.barrier();
			expect(harness.drafts).toEqual([]);
			expect(harness.errors).toContain("Collab rewind failed: selected prompt unavailable");
		} finally {
			await harness.cleanup();
		}
	});
	it("requests a fresh snapshot when the host leaf is missing from the replica", async () => {
		const harness = await makeHarness("guest-missing-leaf");
		try {
			harness.send({ t: "leaf", leafId: "not-held" });
			await harness.resynced;
			await harness.barrier();
			expect(harness.helloCount).toBe(2);
			expect(harness.leafId).toBeNull();
			expect(harness.errors).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});
	it("does not send rewind when the host has not advertised support", async () => {
		const harness = await makeHarness("guest-rewind-unsupported", { rewind: false });
		try {
			expect(harness.guest.canRewind).toBe(false);
			harness.guest.rewind("known-entry");
			expect(harness.statuses).toContain("This collab host does not support rewind");
			expect(harness.drafts).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});
});
