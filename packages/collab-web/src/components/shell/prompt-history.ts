import type { SessionEntry } from "@oh-my-pi/pi-wire";

export interface PromptHistoryItem {
	id: string;
	text: string;
	createdAt: number;
}

/** User-authored text prompts in transcript order, without injected system prompts. */
export function transcriptPrompts(entries: readonly SessionEntry[]): PromptHistoryItem[] {
	const prompts: PromptHistoryItem[] = [];
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
		if (text.trim()) {
			const timestamp = Date.parse(entry.timestamp);
			prompts.push({ id: entry.id, text, createdAt: Number.isFinite(timestamp) ? timestamp : 0 });
		}
	}
	return prompts;
}

/** Keeps submitted prompts missing from the active transcript, including prompts removed by rewind. */
export function mergePromptHistory(
	transcript: readonly PromptHistoryItem[],
	submitted: readonly PromptHistoryItem[],
): PromptHistoryItem[] {
	const unmatched = [...submitted];
	const merged: PromptHistoryItem[] = [];
	for (const prompt of transcript) {
		const match = unmatched.findIndex(sent => sent.text === prompt.text);
		merged.push(match === -1 ? prompt : unmatched.splice(match, 1)[0]!);
	}
	return [...merged, ...unmatched].sort((a, b) => a.createdAt - b.createdAt);
}

export function promptHistorySwipeDirection(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
): "up" | "down" | null {
	const dx = endX - startX;
	const dy = endY - startY;
	if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(dx) * 1.25) return null;
	return dy < 0 ? "up" : "down";
}

export interface PromptHistoryCursor {
	/** -1 is the live draft; 0 is the newest prompt. */
	index: number;
	draft: string;
}

export function navigatePromptHistory(
	cursor: PromptHistoryCursor,
	direction: "up" | "down",
	prompts: readonly PromptHistoryItem[],
	currentDraft: string,
): { cursor: PromptHistoryCursor; text: string } | null {
	if (prompts.length === 0) return null;
	const next = direction === "up" ? Math.min(cursor.index + 1, prompts.length - 1) : Math.max(cursor.index - 1, -1);
	if (next === cursor.index) return null;
	const draft = cursor.index === -1 ? currentDraft : cursor.draft;
	return {
		cursor: { index: next, draft },
		text: next === -1 ? draft : (prompts[prompts.length - 1 - next]?.text ?? ""),
	};
}
