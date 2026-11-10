import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { InteractiveModeContext } from "./types";
import { isTranscriptEntry } from "../session/session-context";

export interface RewindResult {
	draft?: string;
	images?: ImageContent[];
	replaceDraft: boolean;
}

/** Move the active session to a transcript entry using the same semantics as the TUI rewind selector. */
export async function rewindToTranscriptEntry(ctx: InteractiveModeContext, entryId: string): Promise<RewindResult> {
	const entry = ctx.sessionManager.getEntry(entryId);
	if (!entry || !isTranscriptEntry(entry)) throw new Error("The selected prompt is no longer available");
	if (!ctx.sessionManager.getBranch().some(candidate => candidate.id === entryId))
		throw new Error("The selected prompt is no longer on the active branch");

	const isUserTarget = isUserRequestEntry(entry);
	if (entryId === ctx.sessionManager.getLeafId() && !isUserTarget) throw new Error("Already at this point");

	const replaceDraft = isUserTarget || !ctx.editor.getText().trim();
	const result = await ctx.session.navigateTree(entryId, { summarize: false });
	if (result.cancelled) throw new Error("Navigation cancelled");
	await ctx.renderInitialMessages({ clearTerminalHistory: true });
	await ctx.reloadTodos();
	return { draft: result.editorText, images: result.editorImages, replaceDraft };
}
