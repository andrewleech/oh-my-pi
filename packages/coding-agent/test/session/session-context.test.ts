import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { ContextNotesTool } from "../../src/tools/context-notes";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import {
	type CompactionSummaryMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
} from "../../src/session/messages";
import { buildSessionContext, type StrippedToolCallsMarker } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";

const timestamp = "2026-07-09T00:00:00.000Z";

const compactedEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "before compaction" }], timestamp: 1 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m1",
		timestamp,
		summary: "summary",
		firstKeptEntryId: "m1",
		tokensBefore: 123,
		preserveData: {
			[snapcompact.PRESERVE_KEY]: {
				frames: [{ data: "base64-frame", mimeType: "image/png", cols: 10, rows: 10, chars: 100 }],
				totalChars: 100,
				truncatedChars: 0,
				textHead: "head",
				textTail: "tail",
			},
		},
	},
	{
		type: "message",
		id: "m2",
		parentId: "c1",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 2 },
	},
] satisfies SessionEntry[];

function compactionSummary(messages: AgentMessage[]): CompactionSummaryMessage {
	const summary = messages.find(
		(message): message is CompactionSummaryMessage => message.role === "compactionSummary",
	);
	if (!summary) throw new Error("Expected a compaction summary message");
	return summary;
}

describe("buildSessionContext snapcompact archives", () => {
	it("omits snapcompact archive blocks from collapsed transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		const summary = compactionSummary(context.messages);

		expect(summary.images).toBeUndefined();
		expect(summary.blocks).toBeUndefined();
	});

	it("keeps snapcompact archive blocks in full transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, { transcript: true });

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});

	it("keeps snapcompact archive blocks in provider context summaries", () => {
		const context = buildSessionContext(compactedEntries);

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});
});

it("does not restore an older request during a later notes-backed rollover", () => {
	const entries: SessionEntry[] = [
		userEntry("old", null, "older-request-secret", 1),
		assistantEntry("selected", "old", "stop", "selected-reply", 2),
		{
			type: "compaction",
			id: "selected-range",
			parentId: "selected",
			timestamp,
			summary: "selected archive",
			firstKeptEntryId: "",
			tokensBefore: 10,
			method: "snapcompact",
			details: { selectedRange: true },
		},
		assistantEntry("tail", "selected-range", "stop", "later-reply", 3),
		{
			type: "compaction",
			id: "rollover",
			parentId: "tail",
			timestamp,
			summary: "rollover summary",
			firstKeptEntryId: "tail",
			tokensBefore: 10,
			details: { kind: "experimental-context-rollover" },
		},
	];
	const context = JSON.stringify(buildSessionContext(entries).messages);
	expect(context).toContain("later-reply");
	expect(context).not.toContain("older-request-secret");
});

describe("snapcompact from a selected message", () => {
	it("persists a user-only session and its selected archive without changing session identity", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snapcompact-unsaved-"));
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model missing");
		const manager = SessionManager.create(tmp, tmp);
		manager.appendMessage({ role: "user", content: "excluded-before", timestamp: 1 });
		const selected = manager.appendMessage({ role: "user", content: "selected-unsaved", timestamp: 2 });
		manager.appendMessage({ role: "user", content: "after-unsaved", timestamp: 3 });
		const file = manager.getSessionFile();
		if (!file) throw new Error("Session file missing");
		expect(await Bun.file(file).exists()).toBe(false);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
			streamFn: createMockModel({ responses: [{ content: ["unused"] }] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
		});
		try {
			const sessionId = manager.getSessionId();
			await session.snapcompactFrom(selected);
			await manager.flush();
			const reloaded = await SessionManager.open(file, tmp, undefined, { throwIfMissing: true });
			try {
				expect(reloaded.getSessionId()).toBe(sessionId);
				const compacted = reloaded
					.getEntries()
					.filter(entry => entry.type === "compaction")
					.at(-1);
				if (!compacted) throw new Error("Compaction entry missing");
				const preserved = snapcompact.getPreservedArchive(compacted.preserveData);
				if (!preserved) throw new Error("Snapcompact archive missing");
				const archive = snapcompact.archiveSourceText(preserved);
				expect(archive).toContain("selected-unsaved");
				expect(archive).toContain("after-unsaved");
				expect(archive).not.toContain("excluded-before");
				expect(JSON.stringify(reloaded.buildSessionContext().messages)).not.toContain("excluded-before");
			} finally {
				await reloaded.close();
			}
		} finally {
			await session.dispose();
			auth.close();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("reports a persistence failure instead of reporting snapcompact success", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snapcompact-flush-"));
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model missing");
		const manager = SessionManager.create(tmp, tmp);
		const selected = manager.appendMessage({ role: "user", content: "selected", timestamp: 1 });
		await manager.ensureOnDisk();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
			streamFn: createMockModel({ responses: [{ content: ["unused"] }] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
		});
		const flush = spyOn(manager, "flush").mockRejectedValueOnce(new Error("persistence failed"));
		try {
			await expect(session.snapcompactFrom(selected)).rejects.toThrow("persistence failed");
			expect(flush).toHaveBeenCalled();
		} finally {
			flush.mockRestore();
			await session.dispose();
			auth.close();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("starts at the selected collab prompt when identical prompts share a timestamp", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snapcompact-collab-"));
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model missing");
		const manager = SessionManager.create(tmp, tmp);
		const first = manager.appendCustomMessageEntry(
			"collab-prompt",
			"same-request",
			true,
			{ from: "guest" },
			"user",
			1,
		);
		manager.appendMessage({ role: "user", content: "between-prompts-secret", timestamp: 2 });
		const selected = manager.appendCustomMessageEntry(
			"collab-prompt",
			"same-request",
			true,
			{ from: "guest" },
			"user",
			1,
		);
		manager.appendMessage({ role: "user", content: "after-selected", timestamp: 3 });
		const prompts = manager.getEntries().filter(entry => entry.id === first || entry.id === selected);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]?.timestamp).toBe(prompts[1]?.timestamp);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
			streamFn: createMockModel({ responses: [{ content: ["unused"] }] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
		});
		try {
			await manager.ensureOnDisk();
			await session.snapcompactFrom(selected);
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Session file missing");
			const reloaded = await SessionManager.open(file, tmp);
			try {
				const compacted = reloaded
					.getEntries()
					.filter(entry => entry.type === "compaction")
					.at(-1);
				if (!compacted) throw new Error("Compaction entry missing");
				expect(compacted.firstKeptEntryId).toBe("");
				const preserved = snapcompact.getPreservedArchive(compacted.preserveData);
				if (!preserved) throw new Error("Snapcompact archive missing");
				const archive = snapcompact.archiveSourceText(preserved);
				if (archive === undefined) throw new Error("Snapcompact archive source missing");
				expect(archive.match(/same-request/g)).toHaveLength(1);
				expect(archive).toContain("after-selected");
				expect(archive).not.toContain("between-prompts-secret");
			} finally {
				await reloaded.close();
			}
		} finally {
			await session.dispose();
			auth.close();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("starts from an assistant whose dangling tool call is stripped during context reconstruction", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snapcompact-orphan-"));
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model missing");
		const manager = SessionManager.create(tmp, tmp);
		manager.appendMessage({ role: "user", content: "before-assistant-secret", timestamp: 1 });
		const entry = toolCallAssistantEntry("assistant", null, "toolUse", "orphan-call", 2);
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Assistant fixture missing");
		const selected = manager.appendMessage({
			...entry.message,
			content: [{ type: "text", text: "selected-assistant-text" }, ...entry.message.content],
		});
		manager.appendCustomEntry("experimental_context_notes", { version: 1, text: "suffix-notebook-secret" });
		manager.appendMessage({ role: "user", content: "after-assistant", timestamp: 3 });
		const messages = manager.buildSessionContext().messages;
		expect(danglingCallIds(messages)).toEqual([]);
		expect(JSON.stringify(messages)).toContain("selected-assistant-text");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
			streamFn: createMockModel({ responses: [{ content: ["unused"] }] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
		});
		try {
			const sessionId = manager.getSessionId();
			await session.snapcompactFrom(selected);
			expect(manager.getSessionId()).toBe(sessionId);
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Session file missing");
			const reloaded = await SessionManager.open(file, tmp);
			try {
				const compacted = reloaded
					.getEntries()
					.filter(entry => entry.type === "compaction")
					.at(-1);
				if (!compacted) throw new Error("Compaction entry missing");
				const preserved = snapcompact.getPreservedArchive(compacted.preserveData);
				if (!preserved) throw new Error("Snapcompact archive missing");
				const archive = snapcompact.archiveSourceText(preserved);
				expect(archive).toContain("selected-assistant-text");
				expect(archive).toContain("after-assistant");
				expect(archive).not.toContain("suffix-notebook-secret");
				expect(archive).not.toContain("before-assistant-secret");
				expect(JSON.stringify(agent.state.messages)).not.toContain("before-assistant-secret");
				expect(JSON.stringify(reloaded.buildSessionContext().messages)).not.toContain("before-assistant-secret");
			} finally {
				await reloaded.close();
			}
		} finally {
			await session.dispose();
			auth.close();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it.each([
		["user", "compaction"],
		["assistant", "compaction"],
		["assistant-error", "compaction"],
		["user", "reset"],
		["assistant", "reset"],
		["assistant-error", "reset"],
	] as const)("starts at a %s message before a later %s boundary", async (role, boundary) => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snapcompact-boundary-"));
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model missing");
		const manager = SessionManager.create(tmp, tmp);
		manager.appendMessage({ role: "user", content: "before-selected-secret", timestamp: 1 });
		const assistant = assistantEntry(
			"assistant",
			null,
			role === "assistant-error" ? "error" : "stop",
			"selected-text",
			2,
		);
		if (assistant.type !== "message" || assistant.message.role !== "assistant")
			throw new Error("Assistant fixture missing");
		const selected =
			role === "user"
				? manager.appendMessage({ role: "user", content: "selected-text", timestamp: 2 })
				: manager.appendMessage(assistant.message);
		const kept = manager.appendMessage({ role: "user", content: "after-selected", timestamp: 3 });
		manager.appendMessage({
			...assistant.message,
			stopReason: "error",
			content: [{ type: "text", text: "later-error-text" }],
		});
		manager.appendMessage({
			...assistant.message,
			stopReason: "aborted",
			content: [{ type: "text", text: "later-aborted-text" }],
		});
		if (boundary === "compaction") {
			manager.appendCompaction("prior-summary-secret", undefined, kept, 1, {
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: [],
						textHead: "prior-archive-secret",
						textTail: "",
						totalChars: 20,
						truncatedChars: 0,
					},
				},
			});
		} else {
			manager.appendResetBoundary();
		}
		manager.appendMessage({ role: "user", content: "active-leaf", timestamp: 4 });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
			streamFn: createMockModel({ responses: [{ content: ["unused"] }] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
		});
		try {
			await manager.ensureOnDisk();
			const sessionId = manager.getSessionId();
			await session.snapcompactFrom(selected);
			expect(manager.getSessionId()).toBe(sessionId);
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Session file missing");
			const reloaded = await SessionManager.open(file, tmp);
			try {
				expect(reloaded.getSessionId()).toBe(sessionId);
				const compacted = reloaded
					.getEntries()
					.filter(entry => entry.type === "compaction")
					.at(-1);
				if (!compacted) throw new Error("Compaction entry missing");
				const preserved = snapcompact.getPreservedArchive(compacted.preserveData);
				if (!preserved) throw new Error("Snapcompact archive missing");
				const archive = snapcompact.archiveSourceText(preserved);
				expect(archive).toContain("selected-text");
				expect(archive).toContain("after-selected");
				expect(archive).toContain("later-error-text");
				expect(archive).toContain("later-aborted-text");
				expect(archive).toContain("active-leaf");
				for (const excluded of ["before-selected-secret", "prior-summary-secret", "prior-archive-secret"]) {
					expect(archive).not.toContain(excluded);
					expect(JSON.stringify(agent.state.messages)).not.toContain(excluded);
					expect(JSON.stringify(reloaded.buildSessionContext().messages)).not.toContain(excluded);
				}
			} finally {
				await reloaded.close();
			}
		} finally {
			await session.dispose();
			auth.close();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it.each(["user", "assistant"] as const)(
		"keeps the selected %s range in the archive and model context after reload",
		async role => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snapcompact-from-"));
			const auth = await AuthStorage.create(":memory:");
			auth.keys.setRuntime("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model missing");
			const manager = SessionManager.create(tmp, tmp);
			manager.appendMessage({ role: "user", content: "older-secret", timestamp: 1 });
			const kept = manager.appendMessage({ role: "user", content: "older-kept", timestamp: 1 });
			manager.appendCompaction("old-archive-secret", undefined, kept, 1, {
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: [],
						textHead: "old-archive-secret",
						textTail: "",
						totalChars: 18,
						truncatedChars: 0,
					},
				},
			});
			manager.appendCustomEntry("experimental_context_notes", { version: 1, text: "older-notebook-secret" });
			const assistant = assistantEntry("assistant", kept, "stop", "selected-assistant", 2);
			if (assistant.type !== "message" || assistant.message.role !== "assistant")
				throw new Error("Assistant fixture missing");
			const assistantId = manager.appendMessage(assistant.message);
			const userId = manager.appendMessage({ role: "user", content: "selected-prompt", timestamp: 2 });
			const selected = role === "assistant" ? assistantId : userId;
			const abandoned = manager.appendMessage({ role: "user", content: "off-branch-secret", timestamp: 3 });
			manager.branchWithSummary(userId, "active-branch-summary");
			manager.appendMessage({
				...assistant.message,
				content: [{ type: "text", text: "recovered-retry-secret" }],
				stopReason: "error",
				retryRecovery: {
					kind: "auto-retry",
					status: "recovered",
					attempt: 1,
					recoveredAt: timestamp,
					recovery: "plain",
					note: "recovered",
				},
			});
			manager.appendMessage({
				...assistant.message,
				content: [],
				stopReason: "error",
				errorMessage: "empty-error-secret",
			});
			manager.appendCustomMessageEntry(PREWALK_PLAN_MESSAGE_TYPE, "internal-plan-secret", true);
			const activeLeaf = manager.appendMessage({ role: "user", content: "active-leaf", timestamp: 4 });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
				streamFn: createMockModel({ responses: [{ content: ["unused"] }] }).stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
			});
			const notesTool = ContextNotesTool.createIf({
				cwd: tmp,
				hasUI: false,
				settings: Settings.isolated({ "compaction.experimentalContextManagement": true }),
				getSessionFile: () => manager.getSessionFile() ?? null,
				getSessionId: () => manager.getSessionId(),
				getSessionSpawns: () => null,
				sessionManager: manager,
			});
			if (!notesTool) throw new Error("Context notes tool missing");
			expect(JSON.stringify(await notesTool.execute("before", {}))).toContain("older-notebook-secret");
			expect(JSON.stringify(agent.state.messages)).toContain("older-notebook-secret");
			try {
				await expect(session.snapcompactFrom("missing-entry")).rejects.toThrow();
				await expect(session.snapcompactFrom(abandoned)).rejects.toThrow();
				const reached = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const compact = snapcompact.compact;
				const render = spyOn(snapcompact, "compact").mockImplementation(async (...args) => {
					reached.resolve();
					await release.promise;
					return compact(...args);
				});
				try {
					const pending = session.snapcompactFrom(selected);
					await reached.promise;
					const changedLeaf = manager.appendMessage({ role: "user", content: "racing-message", timestamp: 5 });
					const entriesAfterChange = manager.getEntries().length;
					release.resolve();
					await expect(pending).rejects.toThrow();
					expect(manager.getLeafId()).toBe(changedLeaf);
					expect(manager.getEntries()).toHaveLength(entriesAfterChange);
					manager.branch(activeLeaf);
				} finally {
					release.resolve();
					render.mockRestore();
				}
				const sessionId = manager.getSessionId();
				await session.snapcompactFrom(selected);
				expect(JSON.stringify(await notesTool.execute("after", {}))).not.toContain("older-notebook-secret");
				const liveContext = JSON.stringify(agent.state.messages);
				expect(liveContext).not.toContain("older-secret");
				expect(liveContext).not.toContain("old-archive-secret");
				expect(liveContext).not.toContain("older-notebook-secret");
				expect(liveContext).not.toContain("off-branch-secret");
				expect(manager.getSessionId()).toBe(sessionId);
				await manager.flush();
				const file = manager.getSessionFile();
				if (!file) throw new Error("Session file missing");
				const reloaded = await SessionManager.open(file, tmp);
				expect(reloaded.getSessionId()).toBe(sessionId);
				const compacted = reloaded
					.getEntries()
					.filter(entry => entry.type === "compaction")
					.at(-1);
				if (!compacted) throw new Error("Compaction entry missing");
				expect(compacted.firstKeptEntryId).toBe("");
				const preserved = snapcompact.getPreservedArchive(compacted.preserveData);
				if (!preserved) throw new Error("Snapcompact archive missing");
				const archive = snapcompact.archiveSourceText(preserved);
				expect(archive).toContain("selected-prompt");
				if (role === "assistant") expect(archive).toContain("selected-assistant");
				else expect(archive).not.toContain("selected-assistant");
				expect(archive).toContain("active-leaf");
				expect(archive).toContain("active-branch-summary");
				expect(archive).not.toContain("recovered-retry-secret");
				expect(archive).not.toContain("empty-error-secret");
				expect(archive).not.toContain("internal-plan-secret");
				expect(archive).not.toContain("older-secret");
				expect(archive).not.toContain("old-archive-secret");
				expect(archive).not.toContain("older-notebook-secret");
				expect(archive).not.toContain("off-branch-secret");
				const messages = reloaded.buildSessionContext().messages;
				expect(messages.some(message => message.role === "compactionSummary")).toBe(true);
				expect(messages.some(message => message.role === "user")).toBe(false);
				const context = JSON.stringify(messages);
				expect(context).not.toContain("older-secret");
				expect(context).not.toContain("old-archive-secret");
				expect(context).not.toContain("older-notebook-secret");
				expect(context).not.toContain("off-branch-secret");
				await reloaded.close();
			} finally {
				await session.dispose();
				auth.close();
				await fs.rm(tmp, { recursive: true, force: true });
			}
		},
	);
});

// A turn whose tool is still executing at rebuild time: the assistant message
// (with its toolCall) is persisted at message_end, the toolResult is not.
const danglingToolCallEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
	},
] satisfies SessionEntry[];

function danglingCallIds(messages: AgentMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.push(block.id);
		}
	}
	return ids;
}

describe("buildSessionContext dangling toolCalls", () => {
	it("strips a dangling toolCall from the transcript but keeps the turn with a stripped marker", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, { transcript: true });

		expect(danglingCallIds(context.messages)).toEqual([]);
		// The turn survives (even content-less) carrying the marker so the TUI
		// renders a placeholder row instead of silently erasing the activity.
		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toEqual([]);
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
	});

	it("keeps an in-flight toolCall in the transcript", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			transcript: true,
			inFlightToolCallIds: new Set(["call-1"]),
		});

		expect(danglingCallIds(context.messages)).toEqual(["call-1"]);
	});

	it("always strips dangling toolCalls from the LLM context and drops the emptied turn", () => {
		const context = buildSessionContext(danglingToolCallEntries);

		expect(danglingCallIds(context.messages)).toEqual([]);
		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
	});
});

const assistantUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userEntry(id: string, parentId: string | null, content: string, messageTimestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: messageTimestamp } as AgentMessage,
	};
}

function assistantEntry(
	id: string,
	parentId: string | null,
	stopReason: AssistantMessage["stopReason"],
	text: string,
	messageTimestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason,
			timestamp: messageTimestamp,
		} satisfies AssistantMessage,
	};
}

function toolCallAssistantEntry(
	id: string,
	parentId: string | null,
	stopReason: AssistantMessage["stopReason"],
	toolCallId: string,
	messageTimestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "write", arguments: { path: "plan.md", content: "x" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason,
			timestamp: messageTimestamp,
		} satisfies AssistantMessage,
	};
}

function syntheticToolResultEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	messageTimestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "write",
			content: [
				{ type: "text", text: "Tool call was not executed because the provider stream ended with an error." },
			],
			details: { __synthetic: true, source: "assistant_stop_error", executed: false },
			isError: true,
			timestamp: messageTimestamp,
		} as AgentMessage,
	};
}

function hiddenContinuityEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp,
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: "preserved interrupted thinking",
		display: false,
		attribution: "agent",
	};
}

function expectUserTail(messages: AgentMessage[], content: string): void {
	const tail = messages.at(-1);
	expect(tail?.role).toBe("user");
	if (tail?.role !== "user") {
		throw new Error(`Expected user tail, received ${tail?.role ?? "none"}`);
	}
	expect(tail.content).toBe(content);
}

describe("buildSessionContext failed replay tails", () => {
	it("terminates on cyclic parent links and includes each reachable message once", () => {
		const entries = [userEntry("A", "B", "from A", 1), userEntry("B", "A", "from B", 2)];

		const context = buildSessionContext(entries, "A");

		expect(context.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
			"from B",
			"from A",
		]);
	});

	it("omits a terminal aborted assistant from normal context", () => {
		const context = buildSessionContext([
			userEntry("user", null, "continue", 1),
			assistantEntry("assistant", "user", "aborted", "partial unsafe replay", 2),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "continue");
	});

	it("omits an earlier aborted assistant before a later user from normal context", () => {
		const context = buildSessionContext([
			userEntry("user-1", null, "first prompt", 1),
			assistantEntry("assistant", "user-1", "aborted", "partial unsafe replay", 2),
			userEntry("user-2", "assistant", "retry", 3),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "retry");
	});

	it("preserves a terminal aborted assistant in transcript mode", () => {
		const context = buildSessionContext(
			[
				userEntry("user", null, "continue", 1),
				assistantEntry("assistant", "user", "aborted", "visible transcript error", 2),
			],
			undefined,
			undefined,
			{ transcript: true },
		);

		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") {
			throw new Error(`Expected transcript assistant, received ${assistant?.role ?? "none"}`);
		}
		expect(assistant.stopReason).toBe("aborted");
		expect(assistant.content).toEqual([{ type: "text", text: "visible transcript error" }]);
	});

	it("omits a terminal error assistant from normal context", () => {
		const context = buildSessionContext([
			userEntry("user", null, "retry with smaller input", 1),
			assistantEntry("assistant", "user", "error", "provider rejected the request", 2),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "retry with smaller input");
	});

	it("keeps an aborted assistant when hidden interrupted-thinking continuity follows it", () => {
		const context = buildSessionContext([
			userEntry("user", null, "keep reasoning continuity", 1),
			assistantEntry("assistant", "user", "aborted", "partial answer before interrupt", 2),
			hiddenContinuityEntry("continuity", "assistant"),
		]);

		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") {
			throw new Error(`Expected assistant before continuity, received ${assistant?.role ?? "none"}`);
		}
		expect(assistant.stopReason).toBe("aborted");
		expect(context.messages.at(-1)?.role).toBe("custom");
	});

	it("drops synthetic tool results paired with a dropped failed tool-call turn", () => {
		const context = buildSessionContext([
			userEntry("user", null, "write the plan", 1),
			toolCallAssistantEntry("assistant", "user", "error", "call-1", 2),
			syntheticToolResultEntry("result", "assistant", "call-1", 3),
		]);

		expect(context.messages.map(message => message.role)).toEqual(["user"]);
		expectUserTail(context.messages, "write the plan");
	});

	it("keeps the failed tool-call turn and its result in transcript mode", () => {
		const context = buildSessionContext(
			[
				userEntry("user", null, "write the plan", 1),
				toolCallAssistantEntry("assistant", "user", "error", "call-1", 2),
				syntheticToolResultEntry("result", "assistant", "call-1", 3),
			],
			undefined,
			undefined,
			{ transcript: true },
		);

		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});
});
