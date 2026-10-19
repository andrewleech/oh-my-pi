import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { promptMenuTarget, rewindTargetId } from "../src/components/transcript/rewind-target";

const timestamp = "2026-07-09T00:00:00Z";

function user(id: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp, message: { role: "user", content: id, timestamp: 1 } };
}

function assistant(id: string, toolCallIds: string[] = []): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: id },
				...toolCallIds.map(callId => ({ type: "toolCall" as const, id: callId, name: "read", arguments: {} })),
			],
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

function toolResult(id: string, toolCallId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		},
	};
}

function marker(id: string): SessionEntry {
	return { type: "model_change", id, parentId: null, timestamp, model: "test/model" } as SessionEntry;
}

describe("rewindTargetId", () => {
	it("folds an assistant reply to its last consecutive tool result", () => {
		const reply = assistant("a1", ["c1", "c2"]);
		const entries = [user("u1"), reply, toolResult("r1", "c1"), toolResult("r2", "c2"), assistant("a2")];
		expect(rewindTargetId(entries, reply)).toBe("r2");
	});

	it("keeps an assistant reply without results and non-assistant entries as themselves", () => {
		const reply = assistant("a1");
		const prompt = user("u1");
		const entries = [prompt, reply, user("u2")];
		expect(rewindTargetId(entries, reply)).toBe("a1");
		expect(rewindTargetId(entries, prompt)).toBe("u1");
	});

	it("stops folding at a non-result entry", () => {
		const reply = assistant("a1", ["c1"]);
		const entries = [reply, toolResult("r1", "c1"), marker("m1"), toolResult("r2", "c2")];
		expect(rewindTargetId(entries, reply)).toBe("r1");
	});
});

describe("promptMenuTarget", () => {
	it("targets a user prompt for rewind and fork at the prompt itself, even at the leaf", () => {
		const entries = [user("u1")];
		expect(promptMenuTarget(entries, "u1")).toEqual({
			kind: "prompt",
			rewindId: "u1",
			forkId: "u1",
			canRewind: true,
		});
	});

	it("rewinds an assistant reply to its folded id and forks through the reply itself", () => {
		const entries = [user("u1"), assistant("a1", ["c1"]), toolResult("r1", "c1"), user("u2")];
		expect(promptMenuTarget(entries, "a1")).toEqual({
			kind: "reply",
			rewindId: "r1",
			forkId: "a1",
			canRewind: true,
		});
	});

	it("disables rewind when the folded id is the session leaf", () => {
		const entries = [user("u1"), assistant("a1", ["c1"]), toolResult("r1", "c1")];
		expect(promptMenuTarget(entries, "a1")?.canRewind).toBe(false);
		expect(promptMenuTarget([user("u1"), assistant("a1")], "a1")?.canRewind).toBe(false);
	});

	it("offers nothing for markers, dividers, non-user custom messages, tool results and unknown ids", () => {
		const entries: SessionEntry[] = [
			marker("m1"),
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp,
				summary: "s",
				firstKeptEntryId: "x",
				tokensBefore: 1,
			} as SessionEntry,
			{ type: "branch_summary", id: "b1", parentId: null, timestamp, fromId: "x", summary: "s" } as SessionEntry,
			{
				type: "custom_message",
				id: "cm1",
				parentId: null,
				timestamp,
				customType: "note",
				content: "c",
				display: true,
			} as SessionEntry,
			{
				type: "custom_message",
				id: "omitted",
				parentId: null,
				timestamp,
				customType: "collab-entry-too-large",
				content: "omitted",
				display: true,
			} as SessionEntry,
			toolResult("r1", "c1"),
		];
		for (const id of ["m1", "c1", "b1", "cm1", "omitted", "r1", "missing"]) {
			expect(promptMenuTarget(entries, id)).toBeNull();
		}
	});
});
