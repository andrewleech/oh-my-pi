import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";

/** `prompt`: a user request, rewound to before it. `reply`: an assistant message, rewound to after it. */
export type PromptMenuKind = "prompt" | "reply";

export interface PromptMenuTarget {
	kind: PromptMenuKind;
	/** Entry the host rewinds to. */
	rewindId: string;
	/** Entry the host forks through; the host extends it over the tool results of its batch. */
	forkId: string;
	/** False when rewinding would land on the entry the session is already at. */
	canRewind: boolean;
}

export function isUserPromptTarget(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user";
	return (
		entry.type === "custom_message" &&
		entry.attribution === "user" &&
		(entry.customType === "skill-prompt" || entry.customType === COLLAB_PROMPT_MESSAGE_TYPE)
	);
}

export function isAssistantReplyTarget(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

/** Rows that open the rewind and fork menu. */
export function isPromptMenuTarget(entry: SessionEntry): boolean {
	return isUserPromptTarget(entry) || isAssistantReplyTarget(entry);
}

/**
 * The entry a rewind to `entry` lands on. An assistant reply is shown together with the
 * tool results that follow it, so it folds to the last consecutive tool result; any other
 * entry stands for itself.
 */
export function rewindTargetId(entries: readonly SessionEntry[], entry: SessionEntry): string {
	if (!isAssistantReplyTarget(entry)) return entry.id;
	const index = entries.indexOf(entry);
	if (index < 0) return entry.id;
	let last = entry.id;
	for (let next = index + 1; next < entries.length; next++) {
		const candidate = entries[next];
		if (candidate.type !== "message" || candidate.message.role !== "toolResult") break;
		last = candidate.id;
	}
	return last;
}

/** Menu actions for a row, or null when the row offers none. The session leaf is the last snapshot entry. */
export function promptMenuTarget(entries: readonly SessionEntry[], entryId: string): PromptMenuTarget | null {
	const entry = entries.find(candidate => candidate.id === entryId);
	if (entry === undefined) return null;
	if (isUserPromptTarget(entry)) return { kind: "prompt", rewindId: entry.id, forkId: entry.id, canRewind: true };
	if (!isAssistantReplyTarget(entry)) return null;
	const rewindId = rewindTargetId(entries, entry);
	return { kind: "reply", rewindId, forkId: entry.id, canRewind: rewindId !== entries.at(-1)?.id };
}
