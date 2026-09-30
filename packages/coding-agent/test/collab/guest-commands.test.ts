/**
 * Guest slash commands: a writable guest is told which commands the host runs
 * for it, and every `command` frame gets exactly one `command-result`. Runs
 * the real CollabHost/CollabSocket over the in-process relay with AES-GCM
 * sealing; only the interactive context and session are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COMMAND_OUTPUT_MAX_BYTES, capCommandOutput } from "@oh-my-pi/pi-coding-agent/collab/host-commands";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface PromptCall {
	text: string;
	streamingBehavior?: string;
	/** Settles the pending `session.prompt()` call. */
	finish(agentInvoked: boolean): void;
}

/** Stand-ins for the interactive controller handlers the TUI-routed builtins call. */
interface TuiHandlers {
	compact(instructions?: string, mode?: string): Promise<void>;
	shake(mode: string): Promise<void>;
	handoff(instructions?: string): Promise<void>;
}

interface HostHarness {
	ctx: InteractiveModeContext;
	prompts: PromptCall[];
	notices: string[];
	/** Everything the host showed on its status, warning and error lines. */
	hostMessages: string[];
	/** Calls into the interactive controller handlers, with their arguments. */
	tuiCalls: { handler: keyof TuiHandlers; args: unknown[] }[];
	/** Replaceable per test; each is invoked with the context double as `ctx`. */
	tui: TuiHandlers;
	/** Entries `sessionManager.getBranch()` returns; tests append compaction entries. */
	branch: { type: string; [key: string]: unknown }[];
	extensionCommands: { name: string; description?: string }[];
	/** Resolves on the next `session.prompt()` call. */
	nextPrompt(): Promise<PromptCall>;
	/** Deliver a session event to every `session.subscribe` listener. */
	emit(event: { type: string }): void;
	/** Fire the session's command-metadata-changed listeners. */
	commandMetadataChanged(): void;
}

function defaultTuiHandlers(): TuiHandlers {
	return { compact: async () => {}, shake: async () => {}, handoff: async () => {} };
}

/** InteractiveModeContext double: CollabHost members plus what command listing and dispatch read. */
function makeHostContext(cwd: string): HostHarness {
	const prompts: PromptCall[] = [];
	const notices: string[] = [];
	const hostMessages: string[] = [];
	const branch: HostHarness["branch"] = [];
	const tuiCalls: HostHarness["tuiCalls"] = [];
	const extensionCommands: { name: string; description?: string }[] = [{ name: "deploy", description: "Ship it" }];
	const promptWaiters: ((call: PromptCall) => void)[] = [];
	const listeners: ((event: { type: string }) => void)[] = [];
	const metadataListeners: (() => void)[] = [];
	const sessionManager = {
		getSessionId: () => "sess-1",
		getCwd: () => cwd,
		getLeafId: () => "leaf-1",
		getBranch: () => branch,
		snapshotForReplication: () => ({
			header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd },
			entries: [],
		}),
		onEntryAppended: undefined,
	};
	const ctx = {
		settings: Settings.isolated(),
		sessionManager,
		session: {
			sessionManager,
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: { provider: "anthropic", id: "claude-test" },
			thinkingLevel: undefined,
			customCommands: [],
			skills: [],
			extensionRunner: {
				getRegisteredCommands: () => extensionCommands,
			},
			setSlashCommands: () => {},
			subscribe: (listener: (event: { type: string }) => void) => {
				listeners.push(listener);
				return () => {
					const at = listeners.indexOf(listener);
					if (at !== -1) listeners.splice(at, 1);
				};
			},
			subscribeCommandMetadataChanged: (listener: () => void) => {
				metadataListeners.push(listener);
				return () => {
					const at = metadataListeners.indexOf(listener);
					if (at !== -1) metadataListeners.splice(at, 1);
				};
			},
			emitNotice: (_level: string, message: string) => {
				notices.push(message);
			},
			prompt: (text: string, options?: { streamingBehavior?: string }) => {
				const { promise, resolve } = Promise.withResolvers<boolean>();
				const call: PromptCall = { text, streamingBehavior: options?.streamingBehavior, finish: resolve };
				prompts.push(call);
				for (const waiter of promptWaiters.splice(0)) waiter(call);
				return promise;
			},
			promptCustomMessage: () => Promise.resolve(true),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => {
			hostMessages.push(message);
		},
		showWarning: (message: string) => {
			hostMessages.push(message);
		},
		showError: (message: string) => {
			hostMessages.push(message);
		},
		handleCompactCommand: (instructions?: string, mode?: string) => {
			tuiCalls.push({ handler: "compact", args: [instructions, mode] });
			return harness.tui.compact(instructions, mode);
		},
		handleShakeCommand: (mode: string) => {
			tuiCalls.push({ handler: "shake", args: [mode] });
			return harness.tui.shake(mode);
		},
		handleHandoffCommand: (instructions?: string) => {
			tuiCalls.push({ handler: "handoff", args: [instructions] });
			return harness.tui.handoff(instructions);
		},
		reloadTodos: () => Promise.resolve(),
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const harness: HostHarness = {
		ctx,
		prompts,
		notices,
		hostMessages,
		tuiCalls,
		tui: defaultTuiHandlers(),
		branch,
		extensionCommands,
		nextPrompt: () => {
			const { promise, resolve } = Promise.withResolvers<PromptCall>();
			promptWaiters.push(resolve);
			return promise;
		},
		emit: event => {
			for (const listener of listeners.slice()) listener(event);
		},
		commandMetadataChanged: () => {
			for (const listener of metadataListeners.slice()) listener();
		},
	};
	return harness;
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/** Broadcasts and the snapshot train interleave nondeterministically with the frames asserted on. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	return {
		socket,
		nextFrame: () => {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<CollabFrame>();
			waiters.push(resolve);
			return promise;
		},
	};
}

async function expectFrame<T extends CollabFrame["t"]>(
	guest: TestGuest,
	type: T,
): Promise<Extract<CollabFrame, { t: T }>> {
	const frame = await guest.nextFrame();
	if (frame.t !== type) throw new Error(`expected ${type}, got ${JSON.stringify(frame)}`);
	return frame as Extract<CollabFrame, { t: T }>;
}

/** Join through the write link and consume the welcome and the command list that follows it. */
async function joinWriter(name: string): Promise<TestGuest> {
	const guest = await joinAsGuest(host.link, name);
	guestCleanups.push(() => guest.socket.close());
	await expectFrame(guest, "welcome");
	await expectFrame(guest, "commands");
	return guest;
}

const guestCleanups: (() => void)[] = [];
let tempDir: TempDir;
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	tempDir = await TempDir.create("@pi-collab-guest-commands-");
	harness = makeHostContext(tempDir.path());
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	for (const call of harness.prompts) call.finish(false);
	harness.prompts.length = 0;
	harness.notices.length = 0;
	harness.hostMessages.length = 0;
	harness.tuiCalls.length = 0;
	harness.tui = defaultTuiHandlers();
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
	await tempDir.remove();
});

describe("collab guest commands", () => {
	it("advertises the runnable commands to a writable guest after its welcome", async () => {
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await expectFrame(guest, "welcome");
		const { commands } = await expectFrame(guest, "commands");
		expect(commands.find(command => command.name === "model")).toMatchObject({
			aliases: ["models"],
			source: "builtin",
		});
		expect(commands.find(command => command.name === "deploy")).toEqual({
			name: "deploy",
			description: "Ship it",
			hint: "arguments",
			source: "extension",
		});
	});

	it("never advertises to a read-only guest and refuses its commands", async () => {
		const viewer = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => viewer.socket.close());
		await expectFrame(viewer, "welcome");
		viewer.socket.send({ t: "command", reqId: 1, text: "/model" });
		// Ordered after anything the hello produced: a leaked `commands` frame would come first.
		expect(await viewer.nextFrame()).toEqual({
			t: "command-result",
			reqId: 1,
			error: "running commands is disabled on a read-only link",
		});
	});

	it("runs a builtin and returns its output, announcing who ran it", async () => {
		const guest = await joinWriter("ada");
		guest.socket.send({ t: "command", reqId: 7, text: "/models" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 7,
			output: "Current model: anthropic/claude-test",
		});
		expect(harness.notices).toContain("ada ran /model");
	});

	it("rejects an unknown command without prompting the model", async () => {
		const guest = await joinWriter("writer");
		guest.socket.send({ t: "command", reqId: 2, text: "/nope please" });
		expect(await guest.nextFrame()).toEqual({ t: "command-result", reqId: 2, error: "unknown command /nope" });
		expect(harness.prompts).toHaveLength(0);
	});

	it("sends an extension command through session.prompt as a steer and replies once it is dispatched", async () => {
		const guest = await joinWriter("writer");
		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "command", reqId: 3, text: "/deploy prod" });
		const call = await prompted;
		expect(call).toMatchObject({ text: "/deploy prod", streamingBehavior: "steer" });

		// The agent turn beginning counts as dispatched; `session.prompt()` itself
		// only settles when that turn ends.
		harness.emit({ type: "agent_start" });
		expect(await guest.nextFrame()).toEqual({ t: "command-result", reqId: 3, output: "" });
	});

	it("refuses a second command from the same guest while the first is still running", async () => {
		const guest = await joinWriter("writer");
		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "command", reqId: 4, text: "/deploy" });
		const call = await prompted;
		guest.socket.send({ t: "command", reqId: 5, text: "/model" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 5,
			error: "another command is still running",
		});

		call.finish(false);
		expect(await guest.nextFrame()).toEqual({ t: "command-result", reqId: 4, output: "" });
		guest.socket.send({ t: "command", reqId: 6, text: "/model" });
		expect(await guest.nextFrame()).toMatchObject({ t: "command-result", reqId: 6 });
	});

	it("re-advertises to writable guests when the command set changes", async () => {
		const guest = await joinWriter("writer");
		harness.extensionCommands.push({ name: "rollback", description: "Undo it" });
		try {
			harness.commandMetadataChanged();
			const { commands } = await expectFrame(guest, "commands");
			expect(commands.map(command => command.name)).toContain("rollback");

			const prompted = harness.nextPrompt();
			guest.socket.send({ t: "command", reqId: 8, text: "/rollback" });
			(await prompted).finish(false);
			expect(await guest.nextFrame()).toEqual({ t: "command-result", reqId: 8, output: "" });
		} finally {
			harness.extensionCommands.pop();
			harness.commandMetadataChanged();
			await expectFrame(guest, "commands");
		}
	});

	it("withholds host-local and relocating builtins from the list and refuses them", async () => {
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await expectFrame(guest, "welcome");
		const { commands } = await expectFrame(guest, "commands");
		const names = commands.map(command => command.name);
		for (const denied of ["move", "wt", "stats", "trace", "browser", "computer"]) {
			expect(names).not.toContain(denied);
		}
		const session = commands.find(command => command.name === "session");
		expect(session?.subcommands?.map(subcommand => subcommand.name)).toEqual(["info", "pin"]);

		guest.socket.send({ t: "command", reqId: 20, text: "/worktree feature" });
		expect(await guest.nextFrame()).toEqual({ t: "command-result", reqId: 20, error: "unknown command /worktree" });
		guest.socket.send({ t: "command", reqId: 21, text: "/session delete" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 21,
			error: "/session delete is not available to collab guests",
		});
		expect(harness.notices.filter(notice => notice.includes(" ran /"))).toEqual([]);
	});

	it("runs /compact through the interactive handler and returns what it reported", async () => {
		harness.tui.compact = async () => {
			harness.ctx.showWarning("Nothing to compact (no messages yet)");
		};
		const guest = await joinWriter("writer");
		guest.socket.send({ t: "command", reqId: 30, text: "/compact soft keep the API notes" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 30,
			output: "Nothing to compact (no messages yet)",
		});
		expect(harness.tuiCalls).toEqual([{ handler: "compact", args: ["keep the API notes", "soft"] }]);
		// The host still shows the warning on its own screen.
		expect(harness.hostMessages).toEqual(["Nothing to compact (no messages yet)"]);
	});

	it("reports a completed /compact from the compaction entry it added", async () => {
		harness.tui.compact = async () => {
			harness.ctx.showStatus("collab: first ran /compact");
			harness.branch.push({ type: "compaction", tokensBefore: 9300, tokensAfter: 7500, method: "remote" });
		};
		const guest = await joinWriter("writer");
		guest.socket.send({ t: "command", reqId: 33, text: "/compact" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 33,
			output: "Compacted (remote): 9.3K → 7.5K tokens",
		});
		expect(harness.hostMessages).toEqual(["collab: first ran /compact"]);
	});

	it("answers rejected /compact and /shake arguments with usage text without running the handler", async () => {
		const guest = await joinWriter("writer");
		guest.socket.send({ t: "command", reqId: 31, text: "/shake everything" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 31,
			output: 'Unknown /shake mode "everything". Use elide, images, or thinking.',
		});
		guest.socket.send({ t: "command", reqId: 32, text: "/compact snapcompact the API notes" });
		expect(await guest.nextFrame()).toEqual({
			t: "command-result",
			reqId: 32,
			output: "/compact snapcompact does not take focus instructions (it archives history without an LLM summary).",
		});
		expect(harness.tuiCalls).toEqual([]);
	});

	it("fans routed output from overlapping commands out to every running guest command", async () => {
		const handoffGate = Promise.withResolvers<void>();
		harness.tui.handoff = async () => {
			await handoffGate.promise;
			harness.ctx.showError("Handoff failed: provider down");
		};
		harness.tui.shake = async () => {
			harness.ctx.showStatus("Nothing to shake.");
		};
		const first = await joinWriter("first");
		const second = await joinWriter("second");
		first.socket.send({ t: "command", reqId: 40, text: "/handoff focus on tests" });
		second.socket.send({ t: "command", reqId: 41, text: "/shake" });
		expect(await second.nextFrame()).toEqual({ t: "command-result", reqId: 41, output: "Nothing to shake." });

		handoffGate.resolve();
		const result = await expectFrame(first, "command-result");
		expect(result.reqId).toBe(40);
		// The capture cannot tell which command a host message came from.
		expect(result.output).toBe("Nothing to shake.\nHandoff failed: provider down");
		expect(harness.tuiCalls).toEqual([
			{ handler: "handoff", args: ["focus on tests"] },
			{ handler: "shake", args: ["elide"] },
		]);

		expect(harness.hostMessages).toEqual(["Nothing to shake.", "Handoff failed: provider down"]);
	});

	it("returns plain text for output that carries terminal colour codes", async () => {
		harness.tui.shake = async () => {
			harness.ctx.showStatus("\x1b[1m\x1b[32mShook\x1b[39m\x1b[22m 3 tool results");
		};
		const guest = await joinWriter("writer");
		guest.socket.send({ t: "command", reqId: 50, text: "/shake images" });
		expect(await guest.nextFrame()).toEqual({ t: "command-result", reqId: 50, output: "Shook 3 tool results" });
	});
});

describe("capCommandOutput", () => {
	it("keeps output within the cap unchanged", () => {
		const text = "a".repeat(COMMAND_OUTPUT_MAX_BYTES);
		expect(capCommandOutput(text)).toBe(text);
	});

	it("cuts oversized output on a character boundary and says so", () => {
		// Two-byte characters with a one-byte prefix: the cap falls inside a character.
		const text = `x${"é".repeat(COMMAND_OUTPUT_MAX_BYTES)}`;
		const capped = capCommandOutput(text);
		const [body, marker] = [capped.slice(0, capped.lastIndexOf("\n")), capped.slice(capped.lastIndexOf("\n") + 1)];
		expect(Buffer.byteLength(body, "utf8")).toBe(COMMAND_OUTPUT_MAX_BYTES - 1);
		expect(body).not.toContain("\uFFFD");
		expect(text.startsWith(body)).toBe(true);
		expect(marker).toBe(
			`[output truncated: ${Buffer.byteLength(text, "utf8")} bytes total, showing the first ${COMMAND_OUTPUT_MAX_BYTES - 1}]`,
		);
	});
});
