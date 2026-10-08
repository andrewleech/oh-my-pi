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
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
	resynced: Promise<void>;
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
	options: { isStreaming?: boolean; rewind?: boolean; eventController?: EventController } = {},
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
	let renderCount = 0;
	let reloadCount = 0;
	let loadingAnimationRequests = 0;
	const resynced = Promise.withResolvers<void>();
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
		if (helloCount > 1) resynced.resolve();
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
			state: { ...makeState(), isStreaming: options.isStreaming ?? false },
			agents: [],
			entryCount: 0,
			rewind: options.rewind ?? true,
		} as CollabFrame);
	};
	hostSocket.connect();
	const send = (frame: CollabFrame): void => hostSocket.send(frame);
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
			buildDisplaySessionContext: () => ({
				messages: sessionManager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message] : [])),
			}),
			switchSession: () => Promise.resolve(),
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
		barrier,
		cleanup: async () => {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
		},
	};
	await guest.join(link);
	return harness;
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

	it("maps a non-terminal agent_end settle to willContinue: true", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-2");
		try {
			// `isTerminal: false` is the session-layer marker for "a continuation
			// is already scheduled" — lifecycle integrations must not treat it
			// as a user-visible settle.
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: false },
			} as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			expect(ends[0].willContinue).toBe(true);
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
