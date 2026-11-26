/**
 * Integration contract for a Collab side request. A guest frame reaches a real `CollabHost`, which runs the real
 * `startSideRequest` against a live `AgentSession`; only the model provider is scripted. The child must be a real
 * interactive subagent started from the parent's live state at the fork point, while the parent is never diverted.
 * The parent and the child share one workspace: these tests state that conflict risk instead of assuming isolation.
 */
import { type } from "@oh-my-pi/omptype";
import { describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { waitFor } from "./helpers/throttled-host";
import {
	START_MODEL,
	SWITCHED_MODEL,
	type SideRequestHarness,
	type TestGuest,
	startSideRequestHost,
	transcript,
} from "./helpers/side-request-harness";

// Each test runs a real host, sessions and shell commands; a loaded machine must not turn a slow start into a failure.
setDefaultTimeout(30_000);

/** What a provider sees of one tool: the definition the model reasons about. */
function toolDefinitions(tools: readonly { name: string; description?: string; parameters?: unknown }[] | undefined) {
	return (tools ?? []).map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: JSON.stringify(tool.parameters),
	}));
}

/** The child's first user message: the framing that the history is the parent's, then the task as typed. */
function framedTask(task: string) {
	return expect.stringMatching(
		new RegExp(`^user: <system-notice cause="side-request">[^<]*</system-notice>\\n\\n${task}$`),
	);
}

function messages(request: { context: { messages: unknown } }): AgentMessage[] {
	return request.context.messages as AgentMessage[];
}

/** Rows of the parent's persisted branch: ids, so any entry the child added to it shows. */
function parentEntryIds(h: SideRequestHarness): string[] {
	return h.session.sessionManager.getEntries().map(entry => entry.id);
}

describe("Collab side request, real host and engine", () => {
	it("starts a child from the live parent state, runs its own tool and takes a chat follow-up that never reaches the parent", async () => {
		await using h = await startSideRequestHost();
		const writer = await h.join(h.host.link, "writer");
		const bystander = await h.join(h.host.link, "bystander");
		expect(writer.welcome().sideRequests).toBe(true);

		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		// The live state at the fork differs from how the session started: another model, a rewritten
		// prompt and an edited tool description.
		await h.session.setModelTemporary(SWITCHED_MODEL);
		h.session.agent.setSystemPrompt(["Live prompt"]);
		const bash = h.session.agent.state.tools.find(tool => tool.name === "bash")!;
		Object.defineProperty(bash, "description", { value: "live bash description", configurable: true });
		// What the provider would be told of the parent's tools now: the first request's definitions, with the edit.
		const parentTools = toolDefinitions(h.parentRequests()[0]!.context.tools).map(tool =>
			tool.name === "bash" ? { ...tool, description: "live bash description" } : tool,
		);
		const parentIds = parentEntryIds(h);
		const parentMessages = transcript(h.session.messages);
		h.script.side.push(
			{
				content: [
					{
						type: "toolCall",
						id: "side-write",
						name: "write",
						arguments: { path: "side.txt", content: "from child\n" },
					},
				],
			},
			{ content: ["written"] },
		);

		const result = await writer.sideRequest("  write the file  ");

		if (!result.ok) throw new Error(`side request failed: ${result.message}`);
		const { agentId } = result;
		const ref = AgentRegistry.global().get(agentId);
		expect(ref).toMatchObject({ kind: "sub", parentId: MAIN_AGENT_ID });
		const child = h.live(agentId);
		await child.waitForIdle();

		// The guests' agent list names the child under the parent.
		for (const guest of [writer, bystander]) {
			await waitFor(
				() => guest.agents().some(agent => agent.id === agentId),
				`${agentId} never appeared in the agents frames`,
			);
			expect(guest.agents().find(agent => agent.id === agentId)).toMatchObject({
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				hasSessionFile: true,
			});
		}
		// Only the sender gets the answer.
		await bystander.barrier();
		expect(bystander.results()).toEqual([]);

		// First request: the model, prompt and tool definitions live at the fork, and the completed history.
		const [first] = h.sideRequests();
		expect(first!.modelId).toBe(SWITCHED_MODEL.id);
		expect(first!.modelId).not.toBe(START_MODEL.id);
		expect(first!.context.systemPrompt).toEqual(["Live prompt"]);
		expect(toolDefinitions(first!.context.tools)).toEqual(parentTools);
		expect(toolDefinitions(first!.context.tools).find(tool => tool.name === "bash")?.description).toContain(
			"live bash description",
		);
		expect(transcript(messages(first!))).toEqual([
			"user: parent question",
			"assistant: parent answer",
			expect.stringMatching(/^developer: <system-notice cause="side-request">/),
			framedTask("write the file"),
		]);

		// The child's own tool ran in the shared workspace and its result is in the child's transcript.
		expect(await Bun.file(h.dir.join("side.txt")).text()).toBe("from child\n");
		expect(child.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
		const served = await writer.fetchTranscript(agentId);
		expect(served).toContain('"toolCallId":"side-write"');
		expect(served).toContain("write the file");

		// A guest chat message goes to the child, steered as the Agent Hub sends it.
		h.script.side.push({ content: ["follow-up answer"] });
		writer.chat(agentId, "follow-up question");
		await waitFor(() => h.sideRequests().length === 3, "the child never saw the follow-up");
		await child.waitForIdle();
		expect(transcript(messages(h.sideRequests()[2]!)).slice(-2)).toEqual([
			"assistant: written",
			"user: follow-up question",
		]);
		expect(transcript(child.messages).at(-1)).toBe("assistant: follow-up answer");

		// The parent saw nothing: no provider request, no new entry, same history, nothing queued.
		expect(h.parentRequests()).toHaveLength(1);
		expect(parentEntryIds(h)).toEqual(parentIds);
		expect(transcript(h.session.messages)).toEqual(parentMessages);
		expect(h.session.queuedMessageCount).toBe(0);
		expect(h.session.isStreaming).toBe(false);
	});

	it("leaves a running parent alone, leaves out its unfinished tool batch and keeps the snapshot when the parent changes", async () => {
		await using h = await startSideRequestHost();
		const guest = await h.join(h.host.link, "writer");
		await Bun.write(h.dir.join("notes.txt"), "notes\n");
		const gate = h.dir.join("gate");
		h.script.parent.push(
			{
				content: [
					{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "notes.txt" } },
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
		// The read result is in, the bash call is still running.
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
		const queuedBefore = h.session.queuedMessageCount;
		h.script.side.push({ content: ["side answer"] });

		const result = await guest.sideRequest("side task");

		if (!result.ok) throw new Error(`side request failed: ${result.message}`);
		const { agentId } = result;
		const child = h.live(agentId);
		await child.waitForIdle();
		// The parent is still inside its turn and its queue did not move.
		expect(h.session.isStreaming).toBe(true);
		expect(h.session.queuedMessageCount).toBe(queuedBefore);
		// One call answered and one running: neither the batch nor its result is in the child, in memory or on disk.
		const first = h.sideRequests()[0]!;
		// The parent's own prompt is unanswered, so it is not in the child either.
		expect(transcript(messages(first))).toEqual([
			expect.stringMatching(/^developer: <system-notice/),
			framedTask("side task"),
		]);
		await child.sessionManager.flush();
		const childFile = await Bun.file(child.sessionFile!).text();
		expect(childFile).not.toContain("call-read");
		expect(childFile).not.toContain("call-hold");

		// The parent finishes its own batch and never sees the child.
		await Bun.write(gate, "");
		await parentTurn;
		expect(h.session.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		expect(h.parentRequests()).toHaveLength(2);
		expect(JSON.stringify(h.parentRequests()[1]!.context.messages)).not.toContain("side task");

		// The parent changes after the fork; the child keeps the snapshot it started from.
		await h.session.setModelTemporary(SWITCHED_MODEL);
		h.session.agent.setSystemPrompt(["Parent changed"]);
		await h.session.setActiveToolsByName(["read"]);
		h.script.side.push({ content: ["second side answer"] });
		guest.chat(agentId, "again");
		await waitFor(() => h.sideRequests().length === 2, "the child never saw the follow-up");
		await child.waitForIdle();
		const later = h.sideRequests()[1]!;
		expect(later.modelId).toBe(START_MODEL.id);
		expect(first.modelId).toBe(START_MODEL.id);
		expect(later.context.systemPrompt).toEqual(["Parent prompt"]);
		expect(toolDefinitions(later.context.tools)).toEqual(toolDefinitions(first.context.tools));
		expect(toolDefinitions(later.context.tools).map(tool => tool.name)).toContain("bash");
		expect(transcript(messages(later)).slice(-3)).toEqual([
			framedTask("side task"),
			"assistant: side answer",
			"user: again",
		]);
		expect(transcript(messages(later))).not.toContain("assistant: parent finished");
	});

	it("revives a parked child through a guest chat with the snapshot it started from, and its file reopens to the same history", async () => {
		await using h = await startSideRequestHost();
		const guest = await h.join(h.host.link, "writer");
		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		await h.session.setModelTemporary(SWITCHED_MODEL);
		const jobs = h.session.asyncJobManager!;
		const registered = vi.spyOn(jobs, "register");
		const published = vi.spyOn(jobs, "publishCompleted");
		const parentMessages = transcript(h.session.messages);
		h.script.side.push({ content: ["side answer"] });
		const result = await guest.sideRequest("side task");
		if (!result.ok) throw new Error(`side request failed: ${result.message}`);
		const { agentId } = result;
		await h.live(agentId).waitForIdle();
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: h.session,
				authStorage: h.session.modelRegistry.authStorage,
				modelRegistry: h.session.modelRegistry,
				settings: h.ctx.settings,
				enableLsp: false,
			}),
			() => 0,
		);
		const sessionFile = AgentRegistry.global().get(agentId)!.sessionFile!;
		await h.live(agentId).sessionManager.flush();

		await lifecycle.park(agentId);
		await waitFor(
			() => guest.agents().find(agent => agent.id === agentId)?.status === "parked",
			"the guest never saw the child parked",
		);
		// The file alone replays to the conversation the child had.
		const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
		const replayed = transcript(reopened.buildSessionContext().messages);
		await reopened.close();
		expect(replayed).toEqual([
			"user: parent question",
			"assistant: parent answer",
			expect.stringMatching(/^developer: <system-notice cause="side-request">/),
			framedTask("side task"),
			"assistant: side answer",
		]);

		h.script.side.push({ content: ["revived answer"] });
		guest.chat(agentId, "after revival");
		await waitFor(() => h.sideRequests().length === 2, "the parked child never took the chat message");
		await h.live(agentId).waitForIdle();
		const [first, revived] = h.sideRequests();
		expect(revived!.modelId).toBe(SWITCHED_MODEL.id);
		expect(revived!.context.systemPrompt).toEqual(first!.context.systemPrompt);
		expect(toolDefinitions(revived!.context.tools)).toEqual(toolDefinitions(first!.context.tools));
		expect(transcript(messages(revived!))).toEqual([...replayed, "user: after revival"]);
		expect(h.parentRequests()).toHaveLength(1);
		// A revived child still reports nothing to the parent: its turns do not reach the parent as results.
		expect(registered).not.toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
		expect(transcript(h.session.messages)).toEqual(parentMessages);
	});

	describe("when the child cannot start", () => {
		/** Nothing of a child is left: no registry entry, no session file or artifacts, no provider request. */
		async function expectNoChild(h: SideRequestHarness) {
			expect(h.childIds()).toEqual([]);
			expect(h.sideRequests()).toHaveLength(0);
			expect(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(h.dir.path()))).toEqual(
				h.session.sessionManager.getSessionFile()
					? [path.relative(h.dir.path(), h.session.sessionManager.getSessionFile()!)]
					: [],
			);
		}

		/** The parent still answers a guest prompt after a failed request. */
		async function expectParentUsable(h: SideRequestHarness, guest: TestGuest) {
			h.script.parent.push({ content: ["parent still here"] });
			guest.socket.send({ t: "prompt", text: "are you there" });
			await waitFor(
				() => transcript(h.session.messages).at(-1) === "assistant: parent still here",
				"the parent did not answer after the failed side request",
			);
		}

		it("answers ok:false for a parent session that is not persisted, and creates nothing", async () => {
			await using h = await startSideRequestHost({ persisted: false });
			const guest = await h.join(h.host.link, "writer");

			const result = await guest.sideRequest("task");

			expect(result).toMatchObject({ ok: false, message: expect.stringContaining("persisted session") });
			await expectNoChild(h);
			await expectParentUsable(h, guest);
		});

		it("answers ok:false and removes everything when a parent tool cannot be bound in the child", async () => {
			await using h = await startSideRequestHost({
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
			const guest = await h.join(h.host.link, "writer");
			h.script.parent.push({ content: ["parent answer"] });
			await h.session.prompt("parent question");
			const parentIds = parentEntryIds(h);
			const artifacts = h.session.sessionManager.getArtifactsDir()!;

			const result = await guest.sideRequest("task");

			expect(result).toMatchObject({
				ok: false,
				message: expect.stringContaining('cannot bind tool "parent_only"'),
			});
			await expectNoChild(h);
			expect(await fs.readdir(artifacts).catch(() => [])).toEqual([]);
			expect(parentEntryIds(h)).toEqual(parentIds);
			await expectParentUsable(h, guest);
		});
	});

	it("refuses a read-only or forged peer with no child created, and refuses its chat to a child", async () => {
		await using h = await startSideRequestHost();
		const writer = await h.join(h.host.link, "writer");
		const viewer = await h.join(h.host.viewLink, "viewer");
		const forged = await h.join(h.host.viewLink, "forged", Buffer.alloc(16, 1).toString("base64url"));
		expect(viewer.welcome()).toMatchObject({ readOnly: true });
		expect(viewer.welcome().sideRequests).toBeUndefined();
		expect(forged.welcome().sideRequests).toBeUndefined();

		for (const peer of [viewer, forged]) {
			const result = await peer.sideRequest("sneaky");
			expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/read-only/) });
		}
		expect(h.childIds()).toEqual([]);
		expect(h.requests).toHaveLength(0);
		expect(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(h.dir.path()))).toEqual([]);

		// A real child exists now; a read-only peer cannot steer it either.
		h.script.side.push({ content: ["side answer"] });
		const started = await writer.sideRequest("legit");
		if (!started.ok) throw new Error(`side request failed: ${started.message}`);
		await h.live(started.agentId).waitForIdle();
		const requestsBefore = h.requests.length;
		viewer.chat(started.agentId, "hijack");
		await viewer.barrier();
		expect(viewer.errors().some(message => /read-only/.test(message))).toBe(true);
		expect(h.requests).toHaveLength(requestsBefore);
		expect(h.childIds()).toEqual([started.agentId]);
	});

	it("lets a parent turn and a child act on the same workspace at once; there is no isolation, and the last writer wins", async () => {
		await using h = await startSideRequestHost();
		const guest = await h.join(h.host.link, "writer");
		const gate = h.dir.join("gate");
		const log = h.dir.join("shared.log");
		const conflict = h.dir.join("conflict.txt");
		const parentCommand = [
			"echo parent >> shared.log",
			`while [ ! -e '${gate}' ]; do sleep 0.02; done`,
			"echo parent-done >> shared.log",
			"printf parent > conflict.txt",
		].join("; ");
		h.script.parent.push(
			{ content: [{ type: "toolCall", id: "parent-bash", name: "bash", arguments: { command: parentCommand } }] },
			{ content: ["parent finished"] },
		);
		const parentTurn = h.session.prompt("parent task");
		await waitFor(() => Bun.file(log).size > 0, "the parent's command never started");

		h.script.side.push(
			{
				content: [
					{
						type: "toolCall",
						id: "child-bash",
						name: "bash",
						arguments: { command: "echo child >> shared.log; printf child > conflict.txt" },
					},
				],
			},
			{ content: ["child finished"] },
		);
		const result = await guest.sideRequest("touch the shared files");
		if (!result.ok) throw new Error(`side request failed: ${result.message}`);
		const child = h.live(result.agentId);
		await child.waitForIdle();

		// The child ran while the parent's command was still running, in the parent's directory.
		expect(h.session.isStreaming).toBe(true);
		expect(child.sessionManager.getCwd()).toBe(h.session.sessionManager.getCwd());
		expect(await Bun.file(log).text()).toBe("parent\nchild\n");
		expect(await Bun.file(conflict).text()).toBe("child");

		await Bun.write(gate, "");
		await parentTurn;
		// Both appends landed. For the same path the later writer replaced the earlier one: nothing merged, nothing warned.
		expect(await Bun.file(log).text()).toBe("parent\nchild\nparent-done\n");
		expect(await Bun.file(conflict).text()).toBe("parent");
		const results = [...h.session.messages, ...child.messages].filter(message => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every(message => message.isError !== true)).toBe(true);
	});
});
