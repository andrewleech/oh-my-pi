/**
 * Contracts: history:// protocol handler (rework-contracts.md §6), resolved
 * through `InternalUrlRouter.instance().resolve(...)` like real callers.
 *
 * - Bare `history://` renders an index listing registered agent ids.
 * - `history://<id>` with a live ref renders the in-memory transcript.
 * - A parked ref (session null, sessionFile retained) renders read-only from
 *   the JSONL session file.
 * - An unknown id fails with an error listing the known ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { formatEntryWindow } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { getInternalUrlSuggestions } from "@oh-my-pi/pi-tui/prompt/internal-url-autocomplete";
import {
	formatCurrentBranchFullHistory,
	HistoryProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

import { cfgCompactionExperimentalContextManagement } from "@oh-my-pi/pi-coding-agent/session/context-settings";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function fakeLiveSession(messages: unknown[]): AgentSession {
	return { messages } as unknown as AgentSession;
}

function makeToolSession(
	cwd: string,
	sessionFile: string = path.join(cwd, "session.jsonl"),
	overrides: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async toolType => ({
			id: "history-read",
			path: path.join(cwd, "artifacts", `history-read.${toolType}.log`),
		}),
		settings: Settings.isolated(),
		...overrides,
	};
}

/** Minimal current-version session JSONL: header + a linear user/assistant chain. */
function sessionFixtureJsonl(userText = "parked hello", headerId = "fixture-session"): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: headerId,
		timestamp,
		cwd: "/tmp",
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: userText, timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "parked reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

function currentBranchFixture(): SessionEntry[] {
	const timestamp = new Date().toISOString();
	return [
		{
			type: "message",
			id: "before-first-compaction",
			parentId: null,
			timestamp,
			message: { role: "user", content: "oldest raw request survives", timestamp: 1 },
		},
		{
			type: "compaction",
			id: "first-compaction",
			parentId: "before-first-compaction",
			timestamp,
			summary: "first compacted window",
			firstKeptEntryId: "between-compactions",
			tokensBefore: 100,
		},
		{
			type: "message",
			id: "between-compactions",
			parentId: "first-compaction",
			timestamp,
			message: { role: "user", content: "middle raw request survives", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "second-compaction",
			parentId: "between-compactions",
			timestamp,
			summary: "second compacted window",
			firstKeptEntryId: "latest-entry",
			tokensBefore: 200,
		},
		{
			type: "reset_boundary",
			id: "window-reset",
			parentId: "second-compaction",
			timestamp,
		},
		{
			type: "message",
			id: "latest-entry",
			parentId: "window-reset",
			timestamp,
			message: { role: "user", content: "latest raw request survives", timestamp: 3 },
		},
	] as unknown as SessionEntry[];
}

/** Linear chain e1..e12 (e5 is a compaction), plus a sibling branch x1 <- e3 and x2 <- x1. */
function windowFixture(): { main: SessionEntry[]; side: SessionEntry[]; byId: Map<string, SessionEntry> } {
	const timestamp = new Date().toISOString();
	const message = (id: string, parentId: string | null, text: string) =>
		({
			type: "message",
			id,
			parentId,
			timestamp,
			message: { role: "user", content: text, timestamp: 1 },
		}) as unknown as SessionEntry;
	const main: SessionEntry[] = [];
	for (let i = 1; i <= 12; i++) {
		const parentId = i === 1 ? null : `e${i - 1}`;
		main.push(
			i === 5
				? ({
						type: "compaction",
						id: "e5",
						parentId,
						timestamp,
						summary: "window compacted",
						firstKeptEntryId: "e6",
						tokensBefore: 10,
					} as unknown as SessionEntry)
				: message(`e${i}`, parentId, `text of e${i}`),
		);
	}
	const side = [...main.slice(0, 3), message("x1", "e3", "side one"), message("x2", "x1", "side two")];
	const byId = new Map([...main, ...side].map(entry => [entry.id, entry]));
	return { main, side, byId };
}

function windowContext(sessionId = "sess-1", flag = false) {
	const { main, byId } = windowFixture();
	const pathTo = (leafId?: string): SessionEntry[] => {
		const path: SessionEntry[] = [];
		for (
			let cursor = byId.get(leafId ?? "e12");
			cursor;
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
		) {
			path.unshift(cursor);
		}
		return path;
	};
	return {
		main,
		context: {
			experimentalContextManagement: flag,
			sessionId,
			getSessionBranchTo: (leafId?: string) => {
				const path = pathTo(leafId);
				return path.length > 0 ? path : undefined;
			},
		},
	};
}

const entryUrl = (id: string, query = "") => `history://current/entry/${id}${query}`;

describe("history:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("bare history:// renders an index listing registered agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Agents");
		expect(resource.content).toContain("| HubAgent | idle | sub |");
	});

	it("history://<id> renders a live ref's in-memory transcript", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://HubAgent");

		expect(resource.content).toContain("# HubAgent (idle)");
		expect(resource.content).toContain("## user");
		expect(resource.content).toContain("hello from live");
		expect(resource.notes).toContain("Source: live session");
	});

	it("preserves the existing bare history://current named-agent route", async () => {
		AgentRegistry.global().register({
			id: "current",
			displayName: "named current",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "named current transcript", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://current");

		expect(resource.content).toContain("named current transcript");
	});

	it("renders full execution output and metadata in current-branch history", () => {
		const content = formatCurrentBranchFullHistory([
			{
				type: "message",
				id: "bash-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "bashExecution",
					command: "git status",
					output: "working tree clean",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "python-entry",
				parentId: "bash-entry",
				timestamp: new Date().toISOString(),
				message: {
					role: "pythonExecution",
					code: "print('ok')",
					output: "ok",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 2,
				},
			},
		] as unknown as SessionEntry[]);

		expect(content).toContain("working tree clean");
		expect(content).toContain('"truncated": false');
		expect(content).toContain("print('ok')");
		expect(content).toContain("Output:");
	});

	it("retains every assistant block variant in current-branch full history", () => {
		const longPayload = `research finding ${"x".repeat(5200)}`;
		const content = formatCurrentBranchFullHistory([
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "answer text" },
						{ type: "thinking", thinking: "visible reasoning" },
						{ type: "redactedThinking", data: "ENCRYPTED-BLOB" },
						{
							type: "anthropicServerTool",
							block: {
								type: "server_tool_use",
								id: "srvtoolu_1",
								name: "web_search",
								input: { query: "release migration guide" },
								caller: "assistant",
							},
						},
						{
							type: "anthropicServerTool",
							block: {
								type: "web_search_tool_result",
								tool_use_id: "srvtoolu_1",
								content: [
									{
										type: "web_search_result",
										url: "https://example.com",
										title: "result",
										encrypted_index: 0,
									},
								],
								result: longPayload,
							},
						},
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						{ type: "fallback", from: { model: "claude-primary" }, to: { model: "claude-backup" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					usage: {},
					stopReason: "stop",
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[]);

		expect(content).toContain("answer text");
		expect(content).toContain("visible reasoning");
		// Redacted reasoning stays opaque: the marker is present, the blob is not.
		expect(content).toContain("[redacted thinking:");
		expect(content).not.toContain("ENCRYPTED-BLOB");
		// The complete retained server block survives, including non-core
		// metadata like `caller`, with no truncation of long payloads.
		expect(content).toContain("#### server tool: server_tool_use");
		expect(content).toContain('"caller": "assistant"');
		expect(content).toContain("release migration guide");
		expect(content).toContain("#### server tool: web_search_tool_result");
		expect(content).toContain(longPayload);
		// Image blocks render as metadata without base64 bytes.
		expect(content).toContain("[image: image/png,");
		expect(content).not.toContain("aGVsbG8=");
		expect(content).toContain("[provider fallback: claude-primary to claude-backup]");
	});

	it("renders the caller-bound branch's full pre-compaction transcript without a disk source", async () => {
		const branch = currentBranchFixture();
		const siblingOnly = "sibling branch text must not leak";
		const resource = await InternalUrlRouter.instance().resolve("history://current/full", {
			experimentalContextManagement: true,
			getSessionBranch: () => branch,
		});

		expect(resource.content).toContain("oldest raw request survives");
		expect(resource.content).toContain("middle raw request survives");
		expect(resource.content).toContain("latest raw request survives");
		expect(resource.content).toContain("Entry first-compaction · compaction");
		expect(resource.content).toContain("Entry window-reset · reset_boundary");
		expect(resource.content).not.toContain(siblingOnly);
		expect(resource.sourcePath).toBeUndefined();
	});

	it("rejects current/full when disabled or without a caller-bound branch", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("history://current/full", {
				experimentalContextManagement: false,
				getSessionBranch: currentBranchFixture,
			}),
		).rejects.toThrow("experimentalContextManagement");
		await expect(
			InternalUrlRouter.instance().resolve("history://current/full", {
				experimentalContextManagement: true,
			}),
		).rejects.toThrow("bound live session branch");
	});

	it("rejects malformed current history routes without consulting agent history", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("history://current/full?unexpected=true", {
				experimentalContextManagement: true,
				getSessionBranch: currentBranchFixture,
			}),
		).rejects.toThrow("Invalid history://current route");
		await expect(
			InternalUrlRouter.instance().resolve("history://current/extra", {
				experimentalContextManagement: true,
				getSessionBranch: currentBranchFixture,
			}),
		).rejects.toThrow("Invalid history://current route");
	});

	it("read applies selectors to caller-bound full history", async () => {
		const settings = Settings.isolated();
		cfgCompactionExperimentalContextManagement.set(settings, true);
		const branch = currentBranchFixture();
		const manager = {
			getBranch: () => branch,
			getSessionId: () => "current-session",
		} as unknown as NonNullable<ToolSession["sessionManager"]>;
		const tool = new ReadTool(
			makeToolSession(os.tmpdir(), undefined, {
				settings,
				getSessionId: () => "current-session",
				sessionManager: manager,
			}),
		);

		const result = await tool.execute("current-history-range", { path: "history://current/full:1-1" });
		const output = result.content.find(content => content.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("# Current branch — full history");
		expect(output.text).not.toContain("oldest raw request survives");
	});

	describe("history://current/entry/<id>", () => {
		it("windows around a middle entry with defaults, target marker, and navigation", async () => {
			const { context } = windowContext();
			const resource = await InternalUrlRouter.instance().resolve(entryUrl("e8"), context);
			const text = resource.content;

			expect(resource.contentType).toBe("text/markdown");
			expect(resource.sourcePath).toBeUndefined();
			expect(text).toContain("Session: sess-1");
			expect(text).toContain("Leaf: e12");
			expect(text).toContain("Target: e8");
			expect(text).toContain("Window: entries 2-12 of 12");
			expect(text).toContain("First entry: e2");
			expect(text).toContain("Last entry: e12");
			expect(text).toContain("hasEarlier: true");
			expect(text).toContain("hasLater: false");
			expect(text).toContain("## Entry e8 · message  <-- referenced");
			expect(text).not.toContain("## Entry e7 · message  <-- referenced");
			expect(text).toContain("text of e2");
			expect(text).not.toContain("text of e1\n");
			expect(text).toContain("Earlier: history://current/entry/e1?session=sess-1&leaf=e12&before=6&after=0");
			expect(text).not.toMatch(/^Later:/m);
		});

		it("computes the window at the start, middle, and end of a branch", () => {
			const { main } = windowFixture();
			const opts = { sessionId: "s", leafId: "e12" };

			const start = formatEntryWindow(main, { ...opts, targetId: "e1", before: 2, after: 2 });
			expect(start).toContain("Window: entries 1-3 of 12");
			expect(start).toContain("hasEarlier: false");
			expect(start).toContain("hasLater: true");
			expect(start).not.toMatch(/^Earlier:/m);
			expect(start).toContain("Later: history://current/entry/e4?session=s&leaf=e12&before=0&after=2");

			const middle = formatEntryWindow(main, { ...opts, targetId: "e6", before: 2, after: 3 });
			expect(middle).toContain("Window: entries 4-9 of 12");
			expect(middle).toContain("First entry: e4");
			expect(middle).toContain("Last entry: e9");
			expect(middle).toContain("Earlier: history://current/entry/e3?session=s&leaf=e12&before=2&after=0");
			expect(middle).toContain("Later: history://current/entry/e10?session=s&leaf=e12&before=0&after=3");

			const end = formatEntryWindow(main, { ...opts, targetId: "e12", before: 1, after: 5 });
			expect(end).toContain("Window: entries 11-12 of 12");
			expect(end).toContain("hasEarlier: true");
			expect(end).toContain("hasLater: false");
			expect(end).not.toMatch(/^Later:/m);
		});

		it("clamps before/after to 0..50 and honours explicit sizes and zero", async () => {
			const { context } = windowContext();
			const router = InternalUrlRouter.instance();

			const zero = (await router.resolve(entryUrl("e6", "?before=0&after=0"), context)).content;
			expect(zero).toContain("Window: entries 6-6 of 12");
			expect(zero).toContain("Earlier: history://current/entry/e5?session=sess-1&leaf=e12&before=0&after=0");
			expect(zero).toContain("Later: history://current/entry/e7?session=sess-1&leaf=e12&before=0&after=0");

			const huge = (await router.resolve(entryUrl("e6", "?before=999&after=999"), context)).content;
			expect(huge).toContain("Window: entries 1-12 of 12");

			const { main } = windowFixture();
			const many: SessionEntry[] = Array.from(
				{ length: 200 },
				(_, i) => ({ ...main[0], id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}` }) as SessionEntry,
			);
			const clamped = formatEntryWindow(many, { targetId: "m100", before: 999, after: 999, leafId: "m199" });
			expect(clamped).toContain("Window: entries 51-151 of 200");
			expect(clamped).toContain("Earlier: history://current/entry/m49?leaf=m199&before=50&after=0");
			expect(clamped).toContain("Later: history://current/entry/m151?leaf=m199&before=0&after=50");
			expect(clamped).not.toContain("Session:");
			expect(clamped).not.toContain("session=");
			expect(formatEntryWindow(many, { targetId: "m100", before: -5, after: 0, leafId: "m199" })).toContain(
				"Window: entries 101-101 of 200",
			);
		});

		it("rejects malformed before/after and unknown query parameters", async () => {
			const { context } = windowContext();
			const router = InternalUrlRouter.instance();
			await expect(router.resolve(entryUrl("e3", "?before=abc"), context)).rejects.toThrow("before=abc");
			await expect(router.resolve(entryUrl("e3", "?after=-1"), context)).rejects.toThrow("after=-1");
			await expect(router.resolve(entryUrl("e3", "?bogus=1"), context)).rejects.toThrow("query parameter 'bogus'");
			await expect(router.resolve(entryUrl("e3", "#frag"), context)).rejects.toThrow(
				"Invalid history://current route",
			);
			await expect(router.resolve("history://current/entry/", context)).rejects.toThrow(
				"Invalid history://current route",
			);
			await expect(router.resolve("history://current/entry/a/b", context)).rejects.toThrow(
				"Invalid history://current route",
			);
		});

		it("shows a compaction boundary inside a window", async () => {
			const { context } = windowContext();
			const text = (await InternalUrlRouter.instance().resolve(entryUrl("e6", "?before=2&after=1"), context))
				.content;
			expect(text).toContain("## Entry e5 · compaction");
			expect(text).toContain("> Context window boundary: compaction");
			expect(text).toContain("First kept entry: e6");
			expect(text).toContain("window compacted");
			expect(text).toContain("## Entry e6 · message  <-- referenced");
		});

		it("accepts a matching session and rejects a different one", async () => {
			const { context } = windowContext("sess-1");
			const router = InternalUrlRouter.instance();
			const ok = await router.resolve(entryUrl("e3", "?session=sess-1&before=1&after=1"), context);
			expect(ok.content).toContain("Window: entries 2-4 of 12");
			await expect(router.resolve(entryUrl("e3", "?session=other"), context)).rejects.toThrow(
				"reference belongs to a different session (other), this session is sess-1",
			);
			const { context: noId } = windowContext();
			await expect(
				router.resolve(entryUrl("e3", "?session=other"), { ...noId, sessionId: undefined }),
			).rejects.toThrow("this session is unknown");
		});

		it("reads the branch named by leaf and carries it in navigation", async () => {
			const { context } = windowContext();
			const router = InternalUrlRouter.instance();
			const text = (await router.resolve(entryUrl("x1", "?leaf=x2&before=1&after=1"), context)).content;
			expect(text).toContain("Leaf: x2");
			expect(text).toContain("Window: entries 3-5 of 5");
			expect(text).toContain("side one");
			expect(text).toContain("side two");
			expect(text).not.toContain("text of e4");
			expect(text).toContain("Earlier: history://current/entry/e2?session=sess-1&leaf=x2&before=1&after=0");

			// The same entry is absent from the default branch only when it is off that path.
			await expect(router.resolve(entryUrl("x1"), context)).rejects.toThrow(
				"Entry x1 is not on the branch ending at e12",
			);
			await expect(router.resolve(entryUrl("e9", "?leaf=x2"), context)).rejects.toThrow("may be on another branch");
		});

		it("errors for an unknown entry, an unknown leaf, and an unbound session", async () => {
			const { context } = windowContext();
			const router = InternalUrlRouter.instance();
			await expect(router.resolve(entryUrl("nope"), context)).rejects.toThrow(
				"Entry nope is not on the branch ending at e12; it may be on another branch",
			);
			await expect(router.resolve(entryUrl("e3", "?leaf=missing"), context)).rejects.toThrow("Unknown leaf missing");
			await expect(router.resolve(entryUrl("e3"), { sessionId: "sess-1" })).rejects.toThrow("bound live session");
			await expect(
				router.resolve(entryUrl("e3", "?leaf=e4"), { sessionId: "sess-1", getSessionBranchTo: () => undefined }),
			).rejects.toThrow("Unknown leaf e4");
		});

		it("works regardless of experimentalContextManagement and never uses getSessionBranch", async () => {
			const router = InternalUrlRouter.instance();
			for (const flag of [false, true, undefined]) {
				const { context } = windowContext("sess-1", flag as boolean);
				const text = (
					await router.resolve(entryUrl("e4"), {
						...context,
						experimentalContextManagement: flag,
						getSessionBranch: () => {
							throw new Error("getSessionBranch must not be used");
						},
					})
				).content;
				expect(text).toContain("## Entry e4 · message  <-- referenced");
			}
		});

		it("is not located to a file and does not disturb the full route's validation", async () => {
			const { context } = windowContext();
			const router = InternalUrlRouter.instance();
			expect(await router.locate(entryUrl("e3"), context)).toBeNull();
			await expect(router.resolve("history://current/entry", context)).rejects.toThrow(
				"Invalid history://current route",
			);
			await expect(router.resolve("history://current/entry/e3/", context)).rejects.toThrow(
				"Invalid history://current route",
			);
		});

		it("read keeps the query string and still applies selectors", async () => {
			const { context } = windowContext();
			const branchTo = context.getSessionBranchTo;
			const manager = {
				getBranch: (leafId?: string) => branchTo(leafId) ?? [],
				getSessionId: () => "sess-1",
			} as unknown as NonNullable<ToolSession["sessionManager"]>;
			const tool = new ReadTool(
				makeToolSession(os.tmpdir(), undefined, { getSessionId: () => "sess-1", sessionManager: manager }),
			);
			const read = async (readPath: string) => {
				const result = await tool.execute("entry-read", { path: readPath });
				const output = result.content.find(content => content.type === "text");
				if (output?.type !== "text") throw new Error("Expected text output");
				return output.text;
			};

			const full = await read(entryUrl("e8", "?session=sess-1&leaf=e12&before=1&after=1"));
			expect(full).toContain("Window: entries 7-9 of 12");
			expect(full).toContain("Leaf: e12");
			expect(full).toContain("## Entry e8 · message  <-- referenced");
			expect(full).toContain("text of e7");
			expect(full).not.toContain("text of e6");

			const side = await read(entryUrl("x1", "?leaf=x2&before=0&after=0"));
			expect(side).toContain("Leaf: x2");
			expect(side).toContain("side one");

			const ranged = await read(`${entryUrl("e8", "?session=sess-1&before=1&after=1")}:1-1`);
			expect(ranged).toContain("# History entry window");
			expect(ranged).not.toContain("Window: entries");

			await expect(read(entryUrl("e8", "?session=other"))).rejects.toThrow("different session");
			await expect(read(entryUrl("e8", "?leaf=missing"))).rejects.toThrow("Unknown leaf missing");
		});
	});

	it("read applies line selectors to history transcripts", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});
		const tool = new ReadTool(makeToolSession(os.tmpdir()));

		const result = await tool.execute("history-range", { path: "history://HubAgent:1-1" });
		const output = result.content.find(content => content.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("# HubAgent (idle)");
		expect(output.text).not.toContain("hello from live");
	});

	it("reads a closed raw history range without appending paging text", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});
		const resource = await InternalUrlRouter.instance().resolve("history://HubAgent");
		const result = await new ReadTool(makeToolSession(os.tmpdir())).execute("history-raw-range", {
			path: "history://HubAgent:raw:1-2",
		});
		const output = result.content.find(content => content.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toBe(resource.content.split("\n").slice(0, 2).join("\n"));
	});

	it("resolves agent ids case-insensitively", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://hubagent");
		expect(resource.content).toContain("# HubAgent (idle)");
	});

	it("history://<id> renders a parked ref read-only from its session file", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "parked.jsonl");
			await Bun.write(sessionFile, sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Sleeper",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sleeper");

			expect(resource.content).toContain("# Sleeper (parked)");
			expect(resource.content).toContain("parked hello");
			expect(resource.content).toContain("parked reply");
			expect(resource.sourcePath).toBe(sessionFile);
			expect(resource.notes?.join("\n")).toContain("read-only");
		});
	});

	it("rejects an unknown id with the list of known agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Nope")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent: Nope");
		expect(error?.message).toContain("HubAgent");
	});

	it("rejects a ref with neither session nor session file", async () => {
		AgentRegistry.global().register({
			id: "Husk",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Husk")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error?.message).toContain("no transcript");
	});

	it("history://<id> reports a just-registered running worker instead of erroring", async () => {
		AgentRegistry.global().register({
			id: "FreshWorker",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "running",
			createdAt: Date.now() - 5_000,
		});

		const resource = await InternalUrlRouter.instance().resolve("history://FreshWorker");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# FreshWorker (running)");
		expect(resource.content).toContain("No transcript has been written yet.");
		expect(resource.content).toMatch(/Started \d+s ago\./);
		expect(resource.notes).toContain("Source: agent registry (no transcript yet)");
	});

	it("hides advisor transcripts from the index and direct lookup", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});

		// Index lists the subagent but never the advisor.
		const index = await InternalUrlRouter.instance().resolve("history://");
		expect(index.content).toContain("HubAgent");
		expect(index.content).not.toContain("advisor");

		// Direct lookup of an advisor-kind ref is reported as unknown — the driving
		// agent must not be able to read it via history://.
		const error = await InternalUrlRouter.instance()
			.resolve("history://AdvisorProbe")
			.then(
				() => null,
				err => err as Error,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent");
	});

	it("omits advisor refs from history:// completions", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: "/tmp/x/__advisor.jsonl",
			status: "parked",
		});

		const completions = await new HistoryProtocolHandler().complete();
		const values = completions.map(c => c.value);
		expect(values).toContain("HubAgent");
		expect(values).not.toContain("AdvisorProbe");
	});

	it("history://<id> serves an unregistered subagent's transcript from disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			// Only Main is registered; Sub1 exists solely on disk.
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sub1");
			expect(resource.content).toContain("# Sub1 (on disk)");
			expect(resource.content).toContain("parked hello");
			expect(resource.sourcePath).toBe(path.join(artifactsDir, "Sub1.jsonl"));
			expect(resource.notes?.join("\n")).toContain("unregistered");
		});
	});

	it("resolves an on-disk-only transcript case-insensitively", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "AuthLoader.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://authloader");
			expect(resource.content).toContain("# AuthLoader (on disk)");
		});
	});

	it("bare history:// and completions include on-disk agents but never advisor transcripts", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			await Bun.write(path.join(artifactsDir, "__advisor.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("| Sub1 | on disk |");
			expect(index.content).not.toContain("__advisor");

			const completions = await new HistoryProtocolHandler().complete();
			const values = completions.map(c => c.value);
			expect(values).toContain("Sub1");
			expect(values).not.toContain("__advisor");
		});
	});

	it("resolves a nested child transcript one level deeper on disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			const childDir = path.join(artifactsDir, "Parent");
			await fs.mkdir(childDir, { recursive: true });
			await Bun.write(path.join(childDir, "Parent.Child.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Parent.Child");
			expect(resource.content).toContain("# Parent.Child (on disk)");
		});
	});

	it("serves a seance only the consulted source's transcript tree, read in place", async () => {
		using tempDir = TempDir.createSync("@omp-history-seance-");
		const dir = tempDir.path();
		const cwd = path.join(dir, "project");
		const sourceArtifacts = path.join(dir, "source", "source");
		const childFile = path.join(sourceArtifacts, "Sub1.jsonl");
		const grandchildFile = path.join(sourceArtifacts, "Sub1", "Sub1.Grandchild.jsonl");
		await Bun.write(childFile, sessionFixtureJsonl("source child history"));
		await Bun.write(grandchildFile, sessionFixtureJsonl("source grandchild history", "grandchild"));
		const externalArtifacts = path.join(dir, "external-artifacts");
		await Bun.write(path.join(externalArtifacts, "ExternalOnly.jsonl"), sessionFixtureJsonl("external transcript"));
		registerArtifactsDir(externalArtifacts);
		AgentRegistry.global().register({
			id: "ForeignOnly",
			displayName: "foreign only",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "outside the source", timestamp: 1 }]),
			status: "running",
		});
		const forkFile = path.join(dir, "forks", "Seance.jsonl");
		const context = {
			session: makeToolSession(cwd, forkFile, { seanceSourceArtifactsDir: sourceArtifacts }),
			sessionFile: forkFile,
		};
		const router = InternalUrlRouter.instance();

		const child = await router.resolve("history://Sub1", context);
		expect(child.content).toContain("source child history");
		expect(child.sourcePath).toBe(childFile);
		expect(await router.locate("history://Sub1.Grandchild", context)).toBe(grandchildFile);
		const index = await router.resolve("history://", context);
		expect(index.content).toContain("| Sub1 | on disk |");
		expect(index.content).toContain("| Sub1.Grandchild | on disk |");
		expect(index.content).not.toContain("ForeignOnly");
		expect(index.content).not.toContain("ExternalOnly");
		await expect(router.resolve("history://ForeignOnly", context)).rejects.toThrow("Unknown agent: ForeignOnly");
		await expect(router.resolve("history://ExternalOnly", context)).rejects.toThrow("Unknown agent: ExternalOnly");

		// The editor binds the seance scope as a scalar, without a tool session.
		const seanceSuggestions = await getInternalUrlSuggestions("history://", cwd, undefined, () => ({
			cwd,
			sessionFile: forkFile,
			seanceSourceArtifactsDir: sourceArtifacts,
		}));
		expect(seanceSuggestions?.items.map(item => item.value).toSorted()).toEqual([
			"history://Sub1",
			"history://Sub1.Grandchild",
		]);
		const ordinarySuggestions = await getInternalUrlSuggestions("history://", cwd, undefined, () => ({ cwd }));
		const ordinaryValues = ordinarySuggestions?.items.map(item => item.value) ?? [];
		expect(ordinaryValues).toContain("history://ForeignOnly");
		expect(ordinaryValues).toContain("history://ExternalOnly");
	});

	it("keeps a seance fork's foreign source children out of the parent's history", async () => {
		using tempDir = TempDir.createSync("@omp-history-seance-parent-");
		const dir = tempDir.path();
		const cwd = path.join(dir, "project");
		const foreignSource = path.join(dir, "foreign", "source.jsonl");
		await Bun.write(foreignSource, sessionFixtureJsonl("foreign root history", "foreign-root"));
		await Bun.write(
			path.join(dir, "foreign", "source", "ForeignChild.jsonl"),
			sessionFixtureJsonl("foreign child history"),
		);
		const parentFile = path.join(dir, "parent", "main.jsonl");
		await Bun.write(parentFile, sessionFixtureJsonl("parent history", "parent-root"));
		const seance = await SessionManager.forkFrom(foreignSource, cwd, undefined, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: path.join(dir, "parent", "main", "Seance.jsonl"),
		});
		await seance.close();

		const context = { session: makeToolSession(cwd, parentFile), sessionFile: parentFile };
		const router = InternalUrlRouter.instance();
		const index = await router.resolve("history://", context);
		expect(index.content).toMatch(/\| Seance \| parked \|/);
		expect(index.content).not.toContain("ForeignChild");
		await expect(router.resolve("history://ForeignChild", context)).rejects.toThrow("Unknown agent: ForeignChild");
	});

	it("does not infer seance scope from a custom agent name", async () => {
		await withTempDir(async dir => {
			const cwd = path.join(dir, "project");
			await fs.mkdir(cwd, { recursive: true });
			const rootFile = path.join(dir, "ordinary-root.jsonl");
			await Bun.write(rootFile, sessionFixtureJsonl("ordinary root history", "ordinary-root"));
			AgentRegistry.global().register({
				id: "ForeignOnly",
				displayName: "foreign",
				kind: "sub",
				session: fakeLiveSession([{ role: "user", content: "outside the fork", timestamp: 1 }]),
				status: "running",
			});

			const session = Object.assign(makeToolSession(cwd, rootFile), {
				agentName: "seance",
				restrictToolNames: true,
			});
			const context = { session, sessionFile: rootFile };
			const index = await InternalUrlRouter.instance().resolve("history://", context);
			expect(index.content).toContain("| ForeignOnly | running");
			const transcript = await InternalUrlRouter.instance().resolve("history://ForeignOnly", context);
			expect(transcript.content).toContain("outside the fork");
			const completions = await new HistoryProtocolHandler().complete(undefined, context);
			expect(completions.map(completion => completion.value)).toContain("ForeignOnly");
		});
	});

	it("skips a registered artifact candidate that is a file", async () => {
		await withTempDir(async dir => {
			const candidate = path.join(dir, "not-a-directory");
			await Bun.write(candidate, "not a directory");
			registerArtifactsDir(candidate);

			await expect(new HistoryProtocolHandler().complete()).resolves.toEqual([]);
		});
	});

	it("read history:// refreshes the caller root before resolving a shared parked id", async () => {
		await withTempDir(async dir => {
			const rootA = path.join(dir, "a", "main.jsonl");
			const rootB = path.join(dir, "b", "main.jsonl");
			const childA = path.join(dir, "a", "main", "Worker.jsonl");
			const childB = path.join(dir, "b", "main", "Worker.jsonl");
			const header = (id: string) =>
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id,
					timestamp: new Date().toISOString(),
					cwd: "/tmp",
				});
			const transcript = (secret: string) =>
				`${header(`fixture-${secret}`)}\n${JSON.stringify({
					type: "message",
					id: `m-${secret}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: `hello from root ${secret}`, timestamp: 1 },
				})}\n`;
			await Bun.write(rootA, `${header("a")}\n`);
			await Bun.write(rootB, `${header("b")}\n`);
			await Bun.write(childA, transcript("A"));
			await Bun.write(childB, transcript("B"));
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: null,
				sessionFile: rootA,
				status: "running",
			});
			// B's scan ran first: the process-global Worker ref targets B's file.
			AgentRegistry.global().register({
				id: "Worker",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile: childB,
				status: "parked",
			});

			// The read threads the caller session file into the resolver, which
			// refreshes the caller root and replaces the stale parked ref.
			const tool = new ReadTool(makeToolSession(dir, rootA));
			const result = await tool.execute("history-root-a", { path: "history://Worker" });
			const output = result.content.find(part => part.type === "text");
			expect(output?.type).toBe("text");
			if (output?.type !== "text") throw new Error("Expected text output");
			expect(output.text).toContain("hello from root A");
			expect(output.text).not.toContain("hello from root B");
			expect(AgentRegistry.global().get("Worker")?.sessionFile).toBe(childA);
		});
	});

	it("bare read history:// lists the caller root's persisted agents like history://<id> finds them", async () => {
		await withTempDir(async dir => {
			const rootA = path.join(dir, "a", "main.jsonl");
			const rootB = path.join(dir, "b", "main.jsonl");
			const header = JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "fixture",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
			});
			await Bun.write(rootA, `${header}\n`);
			await Bun.write(rootB, `${header}\n`);
			await Bun.write(path.join(dir, "a", "main", "Scanner.jsonl"), sessionFixtureJsonl());
			// The process-global Main ref belongs to another root; the caller is root A.
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: null,
				sessionFile: rootB,
				status: "running",
			});

			const tool = new ReadTool(makeToolSession(dir, rootA));
			const result = await tool.execute("history-index-a", { path: "history://" });
			const output = result.content.find(part => part.type === "text");
			if (output?.type !== "text") throw new Error("Expected text output");
			expect(output.text).toMatch(/\| Scanner \| parked \|/);
		});
	});
});
