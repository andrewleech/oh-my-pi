import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { SideRequestError, startSideRequest } from "@oh-my-pi/pi-coding-agent/task/side-request";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = getBundledModel("openai", "gpt-4o-mini");

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

/** Message text without the dated `<system-reminder>` a session's first user message carries. */
function text(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const raw =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	return raw.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>/, "");
}

/** Role and text of a conversation, the shape two views of one history must agree on. */
function transcript(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => `${message.role}: ${text(message)}`);
}

/** The child's first user message: the framing that the history is the parent's, then the task as typed. */
function sideTask(task: string) {
	const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return expect.stringMatching(
		new RegExp(`^user: <system-notice cause="side-request">[^<]*</system-notice>\\n\\n${escaped}$`),
	);
}

async function fixture(
	options: {
		persisted?: boolean;
		customTools?: sdk.CustomTool[];
		settings?: Record<string, unknown>;
		files?: Record<string, string>;
	} = {},
) {
	const dir = TempDir.createSync("@omp-side-request-");
	// Written before the first session: discovery results are cached per directory.
	for (const [file, content] of Object.entries(options.files ?? {})) await Bun.write(dir.join(file), content);
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("openai", "test-key");
	const script = { parent: [] as MockResponse[], side: [] as MockResponse[] };
	const parent: { sessionId?: string } = {};
	const isParentCall = (requestOptions?: SimpleStreamOptions) => requestOptions?.sessionId === parent.sessionId;
	const mock: MockModel = createMockModel({
		handler: (_context: Context, requestOptions?: SimpleStreamOptions) => {
			const queue = isParentCall(requestOptions) ? script.parent : script.side;
			return queue.shift() ?? { content: ["ok"] };
		},
	});
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(_model, context, requestOptions) => mock.stream(model, context, requestOptions),
			slow,
		),
	);
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"task.agentIdleTtlMs": 0,
		...options.settings,
	});
	const sessionDir = dir.join("sessions");
	const { session } = await sdk.createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage: auth,
		model,
		settings,
		sessionManager:
			options.persisted === false
				? SessionManager.inMemory(dir.path())
				: SessionManager.create(dir.path(), sessionDir),
		systemPrompt: ["Parent prompt"],
		toolNames: ["read", "write", "bash", ...(options.customTools?.map(tool => tool.name) ?? [])],
		customTools: options.customTools,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	});
	parent.sessionId = session.sessionId;
	const bus = new EventBus();
	const ctx = {
		session,
		sessionManager: session.sessionManager,
		settings,
		eventBus: bus,
		subagentEventBus: bus,
	} as unknown as InteractiveModeContext;
	return {
		dir,
		session,
		ctx,
		bus,
		mock,
		script,
		/** Provider requests the side child made. */
		sideCalls: () => mock.calls.filter(call => !isParentCall(call.options)),
		parentCalls: () => mock.calls.filter(call => isParentCall(call.options)),
		/** Lets the lifecycle revive a parked child from its session file, as the running CLI does. */
		enableRevival() {
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session,
					authStorage: session.modelRegistry.authStorage,
					modelRegistry: session.modelRegistry,
					settings,
					enableLsp: false,
				}),
				() => 0,
			);
		},
		child(id: string): AgentSession {
			const live = AgentRegistry.global().get(id)?.session;
			if (!live) throw new Error(`Agent ${id} has no live session`);
			return live as AgentSession;
		},
		async [Symbol.asyncDispose]() {
			for (const ref of AgentRegistry.global().list()) {
				if (ref.id !== MAIN_AGENT_ID) await ref.session?.dispose();
			}
			await session.dispose();
			auth.close();
			dir[Symbol.dispose]();
		},
	};
}

describe("startSideRequest", () => {
	it("starts an independent subagent from the persisted conversation that takes later messages", async () => {
		await using h = await fixture();
		const lifecycle: unknown[] = [];
		h.bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => lifecycle.push(frame));
		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		const parentBefore = h.session.sessionManager.getEntries().map(entry => entry.id);
		const parentMessages = transcript(h.session.messages);
		h.script.side.push({ content: ["side answer"] });
		const jobs = h.session.asyncJobManager!;
		const registered = vi.spyOn(jobs, "register");
		const published = vi.spyOn(jobs, "publishCompleted");

		const { agentId } = await startSideRequest(h.ctx, { text: "  side question\nsecond line  " });

		const ref = AgentRegistry.global().get(agentId);
		expect(ref).toMatchObject({ kind: "sub", parentId: MAIN_AGENT_ID });
		expect(ref?.displayName).toBe("Side request: side question second line");
		expect(ref?.sessionFile).toStartWith(`${h.session.sessionManager.getArtifactsDir()}${path.sep}`);
		const child = h.child(agentId);
		await child.waitForIdle();

		const firstRequest = h.sideCalls()[0]!.context;
		expect(transcript(firstRequest.messages as AgentMessage[])).toEqual([
			"user: parent question",
			"assistant: parent answer",
			expect.stringMatching(/^developer: <system-notice cause="side-request">/),
			sideTask("side question\nsecond line"),
		]);
		expect(firstRequest.systemPrompt).toEqual(["Parent prompt"]);
		expect(firstRequest.tools?.map(tool => tool.name)).toEqual(
			h.parentCalls()[0]!.context.tools?.map(tool => tool.name),
		);
		expect(h.sideCalls()[0]!.options?.sessionId).not.toBe(h.parentCalls()[0]!.options?.sessionId);

		// The parent saw nothing of the child.
		await h.session.waitForIdle();
		expect(h.session.sessionManager.getEntries().map(entry => entry.id)).toEqual(parentBefore);
		expect(transcript(h.session.messages)).toEqual(parentMessages);
		expect(h.session.isStreaming).toBe(false);

		// The child's own file replays to the same conversation after a reopen.
		await child.sessionManager.flush();
		const reopened = await SessionManager.open(ref!.sessionFile!, undefined, undefined, { suppressBreadcrumb: true });
		expect(transcript(reopened.buildSessionContext().messages)).toEqual(transcript(child.messages));
		await reopened.close();

		// A chat message reaches the child through the lifecycle, as the Agent Hub and Collab send it.
		h.script.side.push({ content: ["follow-up answer"] });
		const live = await AgentLifecycleManager.global().ensureLive(agentId);
		await live.prompt("follow-up question", { streamingBehavior: "steer" });
		await child.waitForIdle();
		await child.waitForIrcReplies();
		expect(transcript(h.sideCalls()[1]!.context.messages as AgentMessage[]).slice(-3)).toEqual([
			sideTask("side question\nsecond line"),
			"assistant: side answer",
			"user: follow-up question",
		]);
		expect(h.parentCalls()).toHaveLength(1);
		expect(transcript(h.session.messages)).toEqual(parentMessages);
		// Neither turn of the child reports a result to the parent.
		expect(registered).not.toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
		expect(lifecycle).toContainEqual(expect.objectContaining({ id: agentId, status: "started" }));
	});

	it("leaves out a tool batch the parent is still running, whatever the parent does next", async () => {
		await using h = await fixture();
		await Bun.write(h.dir.join("notes.txt"), "notes\n");
		const gate = h.dir.join("gate");
		h.script.parent.push({
			content: [
				{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "notes.txt" } },
				{
					type: "toolCall",
					id: "call-hold",
					name: "bash",
					arguments: { command: `while [ ! -e '${gate}' ]; do sleep 0.02; done` },
				},
			],
		});
		h.script.parent.push({ content: ["parent finished"] });
		// The read result is in, the bash call still running.
		const midBatch = Promise.withResolvers<void>();
		let readAnswered = false;
		let holdStarted = false;
		h.session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") readAnswered = true;
			if (event.type === "tool_execution_start" && event.toolCallId === "call-hold") holdStarted = true;
			if (readAnswered && holdStarted) midBatch.resolve();
		});
		const parentTurn = h.session.prompt("parent task");
		await midBatch.promise;
		await h.session.settleInFlightMessagePersistence();
		h.script.side.push({ content: ["side answer"] });

		const { agentId } = await startSideRequest(h.ctx, { text: "side task" });
		const child = h.child(agentId);
		await child.waitForIdle();

		// One call answered, one still running: neither the batch nor its result is in the child.
		expect(transcript(h.sideCalls()[0]!.context.messages as AgentMessage[])).toEqual([
			"user: parent task",
			expect.stringMatching(/^developer: <system-notice/),
			sideTask("side task"),
		]);
		await child.sessionManager.flush();
		const childFile = await Bun.file(child.sessionFile!).text();
		expect(childFile).not.toContain("call-read");
		expect(childFile).not.toContain("call-hold");

		// The parent was running throughout and finishes its own batch.
		expect(h.session.isStreaming).toBe(true);
		await Bun.write(gate, "");
		await parentTurn;
		expect(h.session.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);

		// The snapshot is not tied to the parent's later prompt or tools.
		h.session.agent.setSystemPrompt(["Parent changed"]);
		await h.session.setActiveToolsByName(["read"]);
		h.script.side.push({ content: ["second side answer"] });
		await (await AgentLifecycleManager.global().ensureLive(agentId)).prompt("again");
		await child.waitForIdle();
		const later = h.sideCalls()[1]!.context;
		expect(later.systemPrompt).toEqual(["Parent prompt"]);
		expect(later.tools?.map(tool => tool.name)).toEqual(h.sideCalls()[0]!.context.tools?.map(tool => tool.name));
		expect(later.tools?.map(tool => tool.name)).toContain("bash");
	});

	it("revives a parked child from its file with the parent's snapshot and goes on", async () => {
		await using h = await fixture();
		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		const createSession = vi.spyOn(sdk, "createAgentSession");
		const jobs = h.session.asyncJobManager!;
		const registered = vi.spyOn(jobs, "register");
		const published = vi.spyOn(jobs, "publishCompleted");
		h.script.side.push({ content: ["side answer"] });
		const { agentId } = await startSideRequest(h.ctx, { text: "side task" });
		await h.child(agentId).waitForIdle();
		h.enableRevival();
		const lifecycle = AgentLifecycleManager.global();
		const spillDir = async (session: AgentSession) =>
			path.dirname((await session.sessionManager.allocateArtifactPath()).path!);
		const parentArtifacts = await spillDir(h.session);
		expect(await spillDir(h.child(agentId))).toBe(parentArtifacts);

		await lifecycle.park(agentId);
		expect(AgentRegistry.global().get(agentId)).toMatchObject({ status: "parked", session: null });
		h.script.side.push({ content: ["revived answer"] });
		await (await lifecycle.ensureLive(agentId)).prompt("after revival");
		const revived = h.child(agentId);
		await revived.waitForIdle();
		await revived.waitForIrcReplies();

		const request = h.sideCalls().at(-1)!.context;
		expect(transcript(request.messages as AgentMessage[])).toEqual([
			"user: parent question",
			"assistant: parent answer",
			expect.stringMatching(/^developer: <system-notice cause="side-request">/),
			sideTask("side task"),
			"assistant: side answer",
			"user: after revival",
		]);
		expect(request.systemPrompt).toEqual(["Parent prompt"]);
		expect(request.tools?.map(tool => tool.name)).toEqual(h.sideCalls()[0]!.context.tools?.map(tool => tool.name));
		// Revived like it started: no report to the parent, the parent's artifact directory, the same depth.
		expect(registered).not.toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
		expect(await spillDir(revived)).toBe(parentArtifacts);
		const depths = createSession.mock.calls.map(([options]) => options?.taskDepth);
		expect(depths).toEqual([1, 1]);
	});

	it("keeps the parent's approval mode, live and after a revival", async () => {
		await using h = await fixture({ settings: { "tools.approvalMode": "always-ask" } });
		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		const write = (id: string) => ({
			content: [{ type: "toolCall" as const, id, name: "write", arguments: { path: `${id}.txt`, content: "x\n" } }],
		});
		h.script.side.push(write("live"), { content: ["refused"] });
		const { agentId } = await startSideRequest(h.ctx, { text: "write a file" });
		await h.child(agentId).waitForIdle();
		h.enableRevival();
		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park(agentId);
		h.script.side.push(write("revived"), { content: ["refused again"] });
		await (await lifecycle.ensureLive(agentId)).prompt("write another");
		await h.child(agentId).waitForIdle();

		// No UI can answer a prompt in the child, so a gated call fails instead of running.
		const results = h.child(agentId).messages.filter(message => message.role === "toolResult");
		expect(results.map(result => result.isError)).toEqual([true, true]);
		expect(results.map(result => text(result))).toEqual([
			expect.stringContaining("requires approval"),
			expect.stringContaining("requires approval"),
		]);
		expect(await Bun.file(h.dir.join("live.txt")).exists()).toBe(false);
		expect(await Bun.file(h.dir.join("revived.txt")).exists()).toBe(false);
	});

	it("sends the task to the model as typed, without running a slash command", async () => {
		await using h = await fixture({
			files: { ".omp/commands/expandme.md": "---\ndescription: expands\n---\nEXPANDED COMMAND BODY\n" },
		});
		h.script.side.push({ content: ["ok"] });

		const { agentId } = await startSideRequest(h.ctx, { text: "/expandme now" });
		await h.child(agentId).waitForIdle();

		expect(h.child(agentId).slashCommands.map(command => command.name)).toContain("expandme");
		expect(transcript(h.sideCalls()[0]!.context.messages as AgentMessage[]).at(-1)).toEqual(
			sideTask("/expandme now"),
		);
	});

	it("ends the child's first request with the framed task after the parent's unanswered prompt and tool round", async () => {
		await using h = await fixture();
		await Bun.write(h.dir.join("notes.txt"), "notes\n");
		const gate = h.dir.join("gate");
		h.script.parent.push(
			{ content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "notes.txt" } }] },
			{
				content: [
					{
						type: "toolCall",
						id: "call-hold",
						name: "bash",
						arguments: { command: `while [ ! -e '${gate}' ]; do sleep 0.02; done` },
					},
				],
			},
			{ content: ["parent finished"] },
		);
		// The parent's read round is complete and its next bash call is still running.
		const holding = Promise.withResolvers<void>();
		h.session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolCallId === "call-hold") holding.resolve();
		});
		const parentTurn = h.session.prompt("parent task");
		await holding.promise;
		await h.session.settleInFlightMessagePersistence();
		h.script.side.push({ content: ["side answer"] });

		const { agentId } = await startSideRequest(h.ctx, { text: "run `echo side-ok`" });
		await h.child(agentId).waitForIdle();
		await Bun.write(gate, "");
		await parentTurn;

		const messages = h.sideCalls()[0]!.context.messages as AgentMessage[];
		expect(transcript(messages)).toEqual([
			"user: parent task",
			"assistant: ",
			"toolResult: notes",
			expect.stringMatching(/^developer: <system-notice cause="side-request">/),
			sideTask("run `echo side-ok`"),
		]);
		// Nothing follows the framed task, and the task text is exact after the framing.
		const last = messages.at(-1)!;
		expect(last.role).toBe("user");
		expect(text(last).endsWith("</system-notice>\n\nrun `echo side-ok`")).toBe(true);
	});

	it("runs the child's tools in the child with the parent's advertised definitions", async () => {
		await using h = await fixture();
		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		const bash = h.session.agent.state.tools.find(tool => tool.name === "bash")!;
		Object.defineProperty(bash, "description", { value: "live parent bash description", configurable: true });
		h.script.side.push({
			content: [
				{
					type: "toolCall",
					id: "call-write",
					name: "write",
					arguments: { path: "side.txt", content: "from side\n" },
				},
			],
		});
		h.script.side.push({ content: ["written"] });

		const { agentId } = await startSideRequest(h.ctx, { text: "write the file" });
		const child = h.child(agentId);
		await child.waitForIdle();

		expect(await Bun.file(h.dir.join("side.txt")).text()).toBe("from side\n");
		expect(h.sideCalls()[0]!.context.tools?.find(tool => tool.name === "bash")?.description).toContain(
			"live parent bash description",
		);
		const childTools = new Set(child.agent.state.tools);
		expect(h.session.agent.state.tools.some(tool => childTools.has(tool))).toBe(false);
		const childResults = child.messages.filter(message => message.role === "toolResult");
		expect(childResults).toHaveLength(1);
		expect(h.session.messages.filter(message => message.role === "toolResult")).toHaveLength(0);
	});

	it("starts from an empty history when the parent has none persisted", async () => {
		await using h = await fixture();
		h.script.side.push({ content: ["side answer"] });

		const { agentId } = await startSideRequest(h.ctx, { text: "first thing" });
		await h.child(agentId).waitForIdle();

		expect(transcript(h.sideCalls()[0]!.context.messages as AgentMessage[])).toEqual([
			expect.stringMatching(/^developer: <system-notice/),
			sideTask("first thing"),
		]);
	});

	describe("failures", () => {
		async function expectNothingLeft(h: Awaited<ReturnType<typeof fixture>>, sessionDir: string) {
			expect(
				AgentRegistry.global()
					.list()
					.map(ref => ref.id),
			).toEqual([MAIN_AGENT_ID]);
			expect(await fs.readdir(sessionDir).catch(() => [])).toEqual([]);
			expect(h.sideCalls()).toHaveLength(0);
		}

		it("refuses empty text before creating anything", async () => {
			await using h = await fixture();
			await expect(startSideRequest(h.ctx, { text: "  \n" })).rejects.toBeInstanceOf(SideRequestError);
			await expect(startSideRequest(h.ctx, { text: "  \n" })).rejects.toThrow("Side request is empty");
			await expectNothingLeft(h, h.session.sessionManager.getArtifactsDir()!);
		});

		it("refuses a parent session that is not persisted", async () => {
			await using h = await fixture({ persisted: false });
			await expect(startSideRequest(h.ctx, { text: "task" })).rejects.toThrow(
				"Side requests need a persisted session",
			);
			expect(
				AgentRegistry.global()
					.list()
					.map(ref => ref.id),
			).toEqual([MAIN_AGENT_ID]);
		});

		it("fails and cleans up when a parent tool cannot be bound in the child", async () => {
			await using h = await fixture({
				customTools: [
					{
						name: "parent_only",
						label: "Parent only",
						description: "Exists only in the parent session.",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "parent" }] };
						},
					},
				],
			});
			h.script.parent.push({ content: ["parent answer"] });
			await h.session.prompt("parent question");
			const manager = new MCPManager(h.dir.path(), async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
			const release = vi.fn();
			const subscribe = manager.addToolsChangedListener.bind(manager);
			vi.spyOn(manager, "addToolsChangedListener").mockImplementation(listener => {
				const unsubscribe = subscribe(listener);
				return () => {
					release();
					return unsubscribe();
				};
			});
			const ctx = { ...h.ctx, mcpManager: manager } as InteractiveModeContext;
			const entries = h.session.sessionManager.getEntries().map(entry => entry.id);

			const failure = await startSideRequest(ctx, { text: "side task" }).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(SideRequestError);
			expect((failure as Error).message).toBe('Side request cannot bind tool "parent_only" in the new session');

			await expectNothingLeft(h, h.session.sessionManager.getArtifactsDir()!);
			expect(release).toHaveBeenCalled();
			expect(h.session.sessionManager.getEntries().map(entry => entry.id)).toEqual(entries);
			await manager.disconnectAll();
			// The parent goes on as before.
			h.script.parent.push({ content: ["still here"] });
			await h.session.prompt("next");
			expect(text(h.session.messages.at(-1)!)).toBe("still here");
		});

		it("fails and cleans up when the first request cannot be dispatched", async () => {
			await using h = await fixture();
			h.script.parent.push({ content: ["parent answer"] });
			await h.session.prompt("parent question");
			vi.spyOn(AgentSession.prototype, "prompt").mockRejectedValueOnce(new Error("cannot dispatch"));

			// An internal failure is not one the requester may be shown.
			const failure = await startSideRequest(h.ctx, { text: "side task" }).catch((error: unknown) => error);
			expect((failure as Error).message).toBe("cannot dispatch");
			expect(failure).not.toBeInstanceOf(SideRequestError);

			await expectNothingLeft(h, h.session.sessionManager.getArtifactsDir()!);
			expect(h.session.isStreaming).toBe(false);
		});

		it("fails when the first request does not start in time, and when it settles without starting", async () => {
			await using h = await fixture();
			// A real timer: the timeout itself is under test.
			vi.spyOn(AgentSession.prototype, "prompt").mockReturnValueOnce(new Promise(() => {}));
			const late = await startSideRequest(h.ctx, { text: "side task" }, { startTimeoutMs: 20 }).catch(
				(error: unknown) => error,
			);
			expect(late).toBeInstanceOf(SideRequestError);
			expect((late as Error).message).toBe("Side request did not start in time");
			await expectNothingLeft(h, h.session.sessionManager.getArtifactsDir()!);

			vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValueOnce(false);
			const dropped = await startSideRequest(h.ctx, { text: "side task" }).catch((error: unknown) => error);
			expect(dropped).toBeInstanceOf(SideRequestError);
			expect((dropped as Error).message).toBe("Side request did not start");
			await expectNothingLeft(h, h.session.sessionManager.getArtifactsDir()!);
		});

		it("caps the live side request subagents of a host, counting starts in progress", async () => {
			await using h = await fixture();
			h.script.side.push({ content: ["one"] }, { content: ["two"] });
			const limit = { maxChildren: 2 };
			const results = await Promise.allSettled([
				startSideRequest(h.ctx, { text: "first" }, limit),
				startSideRequest(h.ctx, { text: "second" }, limit),
				startSideRequest(h.ctx, { text: "third" }, limit),
			]);
			expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
			const refused = (results[2] as PromiseRejectedResult).reason;
			expect(refused).toBeInstanceOf(SideRequestError);
			expect(refused.message).toBe("Too many side request subagents are running (limit 2)");

			// A released child frees its slot.
			const [first] = results as PromiseFulfilledResult<{ agentId: string }>[];
			await h.child(first!.value.agentId).waitForIdle();
			await AgentLifecycleManager.global().release(first!.value.agentId);
			h.script.side.push({ content: ["three"] });
			await expect(startSideRequest(h.ctx, { text: "fourth" }, limit)).resolves.toHaveProperty("agentId");
		});

		it("counts a parked child again once a message revives it", async () => {
			await using h = await fixture();
			h.enableRevival();
			const lifecycle = AgentLifecycleManager.global();
			const limit = { maxChildren: 2 };
			h.script.side.push({ content: ["one"] }, { content: ["two"] });
			const first = await startSideRequest(h.ctx, { text: "first" }, limit);
			await startSideRequest(h.ctx, { text: "second" }, limit);
			await h.child(first.agentId).waitForIdle();
			await lifecycle.park(first.agentId);
			expect(AgentRegistry.global().get(first.agentId)?.session).toBeNull();
			// A parked child holds no slot, so a start fits (this one fails after the check).
			vi.spyOn(AgentSession.prototype, "prompt").mockRejectedValueOnce(new Error("cannot dispatch"));
			await expect(startSideRequest(h.ctx, { text: "third" }, limit)).rejects.toThrow("cannot dispatch");

			h.script.side.push({ content: ["revived"] });
			await (await lifecycle.ensureLive(first.agentId)).prompt("again");
			await expect(startSideRequest(h.ctx, { text: "fourth" }, limit)).rejects.toThrow(
				"Too many side request subagents are running (limit 2)",
			);
		});
	});
});
