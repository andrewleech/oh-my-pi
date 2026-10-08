import type { SessionEntry } from "@oh-my-pi/pi-wire";

/** User-authored text prompts in transcript order, without injected system prompts. */
export function transcriptPrompts(entries: readonly SessionEntry[]): string[] {
	const prompts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("");
		if (text.trim()) prompts.push(text);
	}
	return prompts;
}

export interface PromptHistoryCursor {
	/** -1 is the live draft; 0 is the newest transcript prompt. */
	index: number;
	draft: string;
}

export function navigatePromptHistory(
	cursor: PromptHistoryCursor,
	direction: "up" | "down",
	prompts: readonly string[],
	currentDraft: string,
): { cursor: PromptHistoryCursor; text: string } | null {
	if (prompts.length === 0) return null;
	const next = direction === "up" ? Math.min(cursor.index + 1, prompts.length - 1) : Math.max(cursor.index - 1, -1);
	if (next === cursor.index) return null;
	const draft = cursor.index === -1 ? currentDraft : cursor.draft;
	return {
		cursor: { index: next, draft },
		text: next === -1 ? draft : (prompts[prompts.length - 1 - next] ?? ""),
	};
}
