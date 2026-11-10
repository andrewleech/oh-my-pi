import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { buildMessageReference, sessionLabelFromUrl } from "../src/components/transcript/message-reference";

const base = { parentId: null, timestamp: "2026-07-09T00:00:00Z" } as const;

function user(id: string, content: string): SessionEntry {
	return { ...base, type: "message", id, message: { role: "user", content, timestamp: 1 } };
}

function assistant(id: string, text: string): SessionEntry {
	return {
		...base,
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text },
			],
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		},
	} as SessionEntry;
}

describe("buildMessageReference", () => {
	it("references a user prompt with label", () => {
		expect(
			buildMessageReference({ sessionId: "s-1", leafId: "leaf-9", entry: user("e1", "hello"), label: "dash" }),
		).toBe(
			[
				"omp message reference",
				"session: dash",
				"role: user",
				"preview: hello",
				"read: history://current/entry/e1?session=s-1&leaf=leaf-9",
			].join("\n"),
		);
	});

	it("references an assistant reply using its first text block, without a label", () => {
		const text = buildMessageReference({
			sessionId: "s",
			leafId: "l",
			entry: assistant("a1", "answer"),
			label: null,
		});
		expect(text).toBe(
			[
				"omp message reference",
				"role: assistant",
				"preview: answer",
				"read: history://current/entry/a1?session=s&leaf=l",
			].join("\n"),
		);
	});

	it("references a custom user prompt", () => {
		const entry = {
			...base,
			type: "custom_message",
			id: "c1",
			customType: "skill-prompt",
			content: [{ type: "text", text: "skill:review" }],
			display: true,
			attribution: "user",
		} as SessionEntry;
		const text = buildMessageReference({ sessionId: "s", leafId: "l", entry });
		expect(text).toContain("role: user\npreview: skill:review\n");
	});

	it("collapses whitespace and truncates long previews", () => {
		const long = `first line\n\n   second\tline ${"x".repeat(200)}`;
		const line = buildMessageReference({ sessionId: "s", leafId: "l", entry: user("e", long) })
			.split("\n")
			.find(l => l.startsWith("preview: "));
		expect(line).toBeDefined();
		const body = (line as string).slice("preview: ".length);
		expect(body.startsWith("first line second line xxx")).toBe(true);
		expect(body.endsWith("…")).toBe(true);
		expect(Array.from(body).length).toBe(101);
	});

	it("omits the preview line when there is no text", () => {
		const entry = assistant("a", "  ");
		expect(buildMessageReference({ sessionId: "s", leafId: "l", entry })).not.toContain("preview:");
	});

	it("encodes ids", () => {
		const text = buildMessageReference({ sessionId: "s/1", leafId: "l&2", entry: user("e 1", "x") });
		expect(text).toContain("read: history://current/entry/e%201?session=s%2F1&leaf=l%262");
	});
});

describe("sessionLabelFromUrl", () => {
	it("reads, trims and caps the label", () => {
		expect(sessionLabelFromUrl("https://h/guest?label=%20my%20session%20#link")).toBe("my session");
		expect(sessionLabelFromUrl(`https://h/g?label=${"a".repeat(100)}`)).toBe("a".repeat(64));
	});

	it("ignores missing or empty labels", () => {
		expect(sessionLabelFromUrl("https://h/g")).toBeNull();
		expect(sessionLabelFromUrl("https://h/g?label=%20%20")).toBeNull();
		expect(sessionLabelFromUrl("not a url")).toBeNull();
	});
});
