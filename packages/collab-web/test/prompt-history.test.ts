import { describe, expect, it } from "bun:test";
import type { SessionEntry, UserMessage } from "@oh-my-pi/pi-wire";
import { navigatePromptHistory, transcriptPrompts } from "../src/components/shell/prompt-history";

function userEntry(id: string, content: UserMessage["content"], synthetic = false): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role: "user", content, timestamp: 0, synthetic },
	};
}

describe("transcript prompt history", () => {
	it("keeps user text in transcript order and excludes synthetic and empty prompts", () => {
		const entries: SessionEntry[] = [
			userEntry("first", "  first prompt  "),
			userEntry("auto", "automatic continuation", true),
			userEntry("mixed", [
				{ type: "image", data: "AA==", mimeType: "image/png" },
				{ type: "text", text: "second prompt" },
			]),
			userEntry("empty", "  "),
		];

		expect(transcriptPrompts(entries)).toEqual(["  first prompt  ", "second prompt"]);
	});

	it("walks newest to oldest and returns to the saved unsent draft", () => {
		const prompts = ["old prompt", "new prompt"];
		let cursor = { index: -1, draft: "" };
		let step = navigatePromptHistory(cursor, "up", prompts, "unfinished message");
		expect(step?.text).toBe("new prompt");
		cursor = step!.cursor;

		step = navigatePromptHistory(cursor, "up", prompts, "new prompt");
		expect(step?.text).toBe("old prompt");
		cursor = step!.cursor;

		step = navigatePromptHistory(cursor, "down", prompts, "old prompt");
		expect(step?.text).toBe("new prompt");
		cursor = step!.cursor;

		step = navigatePromptHistory(cursor, "down", prompts, "new prompt");
		expect(step?.text).toBe("unfinished message");
		expect(step?.cursor.index).toBe(-1);
	});

	it("stays at either end of history and does nothing when history is empty", () => {
		const oldest = { index: 1, draft: "draft" };
		expect(navigatePromptHistory(oldest, "up", ["old", "new"], "old")).toBeNull();
		expect(navigatePromptHistory({ index: -1, draft: "" }, "down", ["old"], "draft")).toBeNull();
		expect(navigatePromptHistory({ index: -1, draft: "" }, "up", [], "draft")).toBeNull();
	});
});
