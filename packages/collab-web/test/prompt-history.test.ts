import { describe, expect, it } from "bun:test";
import type { SessionEntry, UserMessage } from "@oh-my-pi/pi-wire";
import {
	mergePromptHistory,
	navigatePromptHistory,
	promptHistorySwipeDirection,
	transcriptPrompts,
	type PromptHistoryItem,
} from "../src/components/shell/prompt-history";

function userEntry(id: string, content: UserMessage["content"], synthetic = false): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role: "user", content, timestamp: 0, synthetic },
	};
}

function prompt(id: string, text: string, createdAt: number): PromptHistoryItem {
	return { id, text, createdAt };
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

		expect(transcriptPrompts(entries)).toEqual([
			prompt("first", "  first prompt  ", Date.parse("2026-01-01T00:00:00.000Z")),
			prompt("mixed", "second prompt", Date.parse("2026-01-01T00:00:00.000Z")),
		]);
	});

	it("retains submitted prompts missing from the transcript without duplicating delivered prompts", () => {
		const transcript = [prompt("host-1", "same prompt", 200), prompt("host-2", "delivered", 300)];
		const submitted = [
			prompt("local-1", "same prompt", 100),
			prompt("local-2", "same prompt", 250),
			prompt("local-3", "lost prompt", 400),
		];

		expect(mergePromptHistory(transcript, submitted)).toEqual([
			submitted[0],
			submitted[1],
			transcript[1],
			submitted[2],
		]);
	});

	it("walks newest to oldest and returns to the saved unsent draft", () => {
		const prompts = [prompt("old", "old prompt", 1), prompt("new", "new prompt", 2)];
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
		const prompts = [prompt("old", "old", 1), prompt("new", "new", 2)];
		const oldest = { index: 1, draft: "draft" };
		expect(navigatePromptHistory(oldest, "up", prompts, "old")).toBeNull();
		expect(navigatePromptHistory({ index: -1, draft: "" }, "down", [prompts[1]!], "draft")).toBeNull();
		expect(navigatePromptHistory({ index: -1, draft: "" }, "up", [], "draft")).toBeNull();
	});

	it("recognises vertical swipes after the gesture threshold", () => {
		expect(promptHistorySwipeDirection(0, 100, 0, 52)).toBe("up");
		expect(promptHistorySwipeDirection(0, 100, 0, 53)).toBeNull();
		expect(promptHistorySwipeDirection(0, 100, 0, 148)).toBe("down");
		expect(promptHistorySwipeDirection(0, 100, 40, 148)).toBeNull();
		expect(promptHistorySwipeDirection(0, 100, 0, 147)).toBeNull();
	});
});
