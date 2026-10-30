/**
 * Contract: live frames the host sends between a `welcome` and its final
 * `snapshot-chunk` follow that snapshot. The TUI guest applies them once the
 * snapshot is loaded, on the first join and on a resync alike, instead of
 * dropping them before the replica exists or applying them to a replica the
 * snapshot then replaces.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function messageEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-26T00:00:00Z",
		message: { role: "user", content: id, timestamp: 0 },
	};
}

function welcome(entryCount: number): CollabFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: { type: "session", id: "remote-session", timestamp: "2026-10-26T00:00:00Z", cwd: "/tmp" },
		state: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			cwd: "/tmp",
			participants: [{ name: "Host", role: "host" }],
		},
		agents: [],
		entryCount,
	} as CollabFrame;
}

/**
 * Records the order of replica loads and entry applies; `onApply` sees each
 * applied entry id, and `dispatched` each event the guest feeds its UI.
 */
function makeGuestContext(
	log: string[],
	onApply: (id: string) => void,
	dispatched: string[] = [],
): InteractiveModeContext {
	return {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
			ingestReplicatedEntry: (entry: SessionEntry) => {
				log.push(`apply ${entry.id}`);
				onApply(entry.id);
			},
		},
		session: {
			messages: [],
			switchSession: () => {
				log.push("load snapshot");
				return Promise.resolve();
			},
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
				replaceMessages: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setSubagentCount: () => {},
			get subagentCount() {
				return 0;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: {
			dispatchSessionEvent: (event: {
				type: string;
				message?: { content?: { text?: string }[] };
				assistantMessageEvent?: { type: string; delta?: string };
			}) => {
				const update = event.assistantMessageEvent;
				const detail =
					event.type === "message_update"
						? ` ${event.message?.content?.[0]?.text} ${update?.type}:${update?.delta}`
						: "";
				dispatched.push(`${event.type}${detail}`);
				return Promise.resolve();
			},
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
	} as unknown as InteractiveModeContext;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

it("applies live frames received behind a welcome after its snapshot", async () => {
	const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
	const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
	const roomId = "snapshot-live-frames-1";
	const roomKey = generateRoomKey();
	const key = await importRoomKey(roomKey);
	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = (frame, fromPeer) => {
		if (frame.t !== "hello") return;
		hostSocket.send(welcome(1), fromPeer);
		hostSocket.send({ t: "entry", entry: messageEntry("live-1") });
		hostSocket.send({ t: "snapshot-chunk", entries: [messageEntry("snap-1")], final: true }, fromPeer);
	};
	hostSocket.connect();
	await hostOpen.promise;

	const log: string[] = [];
	const lastApplied = Promise.withResolvers<void>();
	const guest = new CollabGuestLink(
		makeGuestContext(log, id => {
			if (id === "live-3") lastApplied.resolve();
		}),
	);
	try {
		await guest.join(formatCollabLink("ws://localhost:8788", roomId, roomKey));
		expect(log).toEqual(["load snapshot", "apply live-1"]);

		// A host resync: a fresh welcome to a guest that is already live.
		const before = log.length;
		hostSocket.send(welcome(1));
		hostSocket.send({ t: "entry", entry: messageEntry("live-2") });
		hostSocket.send({ t: "snapshot-chunk", entries: [messageEntry("snap-2")], final: true });
		hostSocket.send({ t: "entry", entry: messageEntry("live-3") });
		await lastApplied.promise;
		expect(log.slice(before)).toEqual(["load snapshot", "apply live-2", "apply live-3"]);
	} finally {
		hostSocket.close();
		writeSpy.mockRestore();
		renameSpy.mockRestore();
		await guest.leave("test cleanup").catch(() => {});
	}
});

function assistantEvent(
	type: "message_start" | "message_update" | "message_end",
	text: string,
	delta?: { kind: "text_delta" | "thinking_delta"; text: string },
): CollabFrame {
	const message = { role: "assistant", content: [{ type: "text", text }] };
	const assistantMessageEvent = delta && { type: delta.kind, contentIndex: 0, delta: delta.text, partial: message };
	return { t: "event", event: { type, message, assistantMessageEvent } } as CollabFrame;
}

function textDelta(text: string): { kind: "text_delta"; text: string } {
	return { kind: "text_delta", text };
}

it("merges buffered updates of a message while the snapshot loads, keeping every delta", async () => {
	const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
	const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
	const roomId = "snapshot-live-frames-2";
	const roomKey = generateRoomKey();
	const key = await importRoomKey(roomKey);
	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = (frame, fromPeer) => {
		if (frame.t !== "hello") return;
		hostSocket.send(welcome(1), fromPeer);
		hostSocket.send(assistantEvent("message_update", "a1", textDelta("a1")));
		hostSocket.send(assistantEvent("message_update", "a1a2", textDelta("a2")));
		hostSocket.send({ t: "agents", agents: [] });
		hostSocket.send(assistantEvent("message_update", "a1a2a3", textDelta("a3")));
		// Another delta kind does not merge.
		hostSocket.send(assistantEvent("message_update", "a1a2a3", { kind: "thinking_delta", text: "t4" }));
		hostSocket.send(assistantEvent("message_end", "a1a2a3"));
		hostSocket.send(assistantEvent("message_start", ""));
		hostSocket.send(assistantEvent("message_update", "b1", textDelta("b1")));
		hostSocket.send(assistantEvent("message_update", "b1b2", textDelta("b2")));
		hostSocket.send({ t: "snapshot-chunk", entries: [messageEntry("snap-1")], final: true }, fromPeer);
	};
	hostSocket.connect();
	await hostOpen.promise;

	const dispatched: string[] = [];
	const guest = new CollabGuestLink(makeGuestContext([], () => {}, dispatched));
	try {
		await guest.join(formatCollabLink("ws://localhost:8788", roomId, roomKey));
		// The first start is the guest's own, for a message whose start predates the snapshot.
		expect(dispatched).toEqual([
			"message_start",
			"message_update a1a2a3 text_delta:a1a2a3",
			"message_update a1a2a3 thinking_delta:t4",
			"message_end",
			"message_start",
			"message_update b1b2 text_delta:b1b2",
		]);
	} finally {
		hostSocket.close();
		writeSpy.mockRestore();
		renameSpy.mockRestore();
		await guest.leave("test cleanup").catch(() => {});
	}
});
