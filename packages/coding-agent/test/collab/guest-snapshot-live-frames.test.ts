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

/** Records the order of replica loads and entry applies; `onApply` sees each applied entry id. */
function makeGuestContext(log: string[], onApply: (id: string) => void): InteractiveModeContext {
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
			dispatchSessionEvent: () => Promise.resolve(),
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
