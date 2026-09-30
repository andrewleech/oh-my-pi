/**
 * Slash commands a collab host runs on behalf of writable guests.
 *
 * The advertised set is the text-mode command list ACP and RPC clients get:
 * builtins with a `handle` (no pickers or dashboards), skills, extension,
 * custom, MCP prompt and file commands, minus {@link GUEST_DENIED_BUILTINS}.
 * Dispatch follows the same order as those modes: skill, then builtin, then
 * `session.prompt()` for everything that expands or runs inside the session.
 */

import { formatNumber, logger, truncate } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import { buildSkillCommandPrompt } from "../modes/skill-command";
import type { AgentSession } from "../session/agent-session";
import { parseCompactArgs } from "../session/compact-modes";
import type { CompactionEntry } from "../session/session-entries";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { parseShakeMode } from "../slash-commands/builtin-lifecycle";
import { reloadTuiPluginState } from "../slash-commands/builtin-marketplace";
import { errorMessage, parseSlashCommand, parseSubcommand } from "../slash-commands/helpers/parse";
import type { CollabCommand } from "./protocol";

const DESCRIPTION_MAX_CHARS = 200;
/** Byte cap on the joined output returned in one `command-result`. */
export const COMMAND_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * Builtins guests may not run: `true` withholds the whole command, a verb
 * table withholds only those subcommands. Each has a text-mode `handle`, but
 * running it on an interactive host at a remote guest's request is wrong.
 */
const GUEST_DENIED_BUILTINS: Record<string, true | Record<string, true>> = {
	// Relocate through the headless path: it skips the interactive gates and the
	// cwd/status-line/title refresh, and a failed rollback disposes the live session.
	move: true,
	wt: true,
	// Starts a dashboard server on the host (`--host` can bind any interface) and
	// opens the host's browser.
	stats: true,
	// Starts the stats server and returns a 127.0.0.1 URL only the host can open.
	trace: true,
	// Switches the host's browser between headless and a visible window on the
	// host's desktop, and persists that as a global setting.
	browser: true,
	// Gives the agent control of the host's desktop; only someone at that desktop
	// should turn it on.
	computer: true,
	// `delete` removes the live session file and points the caller at ACP
	// `session/load`; the host would keep running on a deleted session.
	session: { delete: true },
};

/**
 * Builtins whose text-mode `handle` misses interactive-mode work the host
 * needs (transcript rebuild with a scrollback clear, flushing input queued
 * during compaction, HUD and todo reloads), so a guest runs the TUI controller
 * path instead. Each gets the command's argument text and returns usage text
 * for arguments it rejects. Their `handleTui` is not used because it clears
 * the host's editor draft.
 */
const TUI_ROUTED_BUILTINS: Record<string, (ctx: InteractiveModeContext, args: string) => Promise<string | undefined>> =
	{
		compact: async (ctx, args) => {
			const parsed = parseCompactArgs(args);
			if ("error" in parsed) return parsed.error;
			const before = lastCompaction(ctx);
			await ctx.handleCompactCommand(parsed.instructions, parsed.mode);
			// The TUI reports success by redrawing the transcript, not with a status line.
			const after = lastCompaction(ctx);
			if (!after || after === before) return;
			const tokens =
				after.tokensAfter === undefined
					? formatNumber(after.tokensBefore)
					: `${formatNumber(after.tokensBefore)} → ${formatNumber(after.tokensAfter)}`;
			return `Compacted${after.method ? ` (${after.method})` : ""}: ${tokens} tokens`;
		},
		shake: async (ctx, args) => {
			const mode = parseShakeMode(args);
			if (typeof mode !== "string") return mode.error;
			await ctx.handleShakeCommand(mode);
		},
		handoff: async (ctx, args) => {
			await ctx.handleHandoffCommand(args || undefined);
		},
	};

function lastCompaction(ctx: InteractiveModeContext): CompactionEntry | undefined {
	return ctx.sessionManager.getBranch().findLast((entry): entry is CompactionEntry => entry.type === "compaction");
}

/** Outcome of {@link runCollabCommand}; exactly one of the two is sent back to the guest. */
export type CollabCommandOutcome = { output: string } | { error: string };

/** Build the guest-runnable command list for `session`. */
export async function buildCollabCommands(session: AgentSession): Promise<CollabCommand[]> {
	const available = await buildAvailableSlashCommands(session);
	const commands: CollabCommand[] = [];
	for (const command of available) {
		const denied = command.source === "builtin" ? GUEST_DENIED_BUILTINS[command.name] : undefined;
		if (denied === true) continue;
		const subcommands = denied
			? command.subcommands?.filter(subcommand => !Object.hasOwn(denied, subcommand.name))
			: command.subcommands;
		commands.push({
			name: command.name,
			aliases: command.aliases && command.aliases.length > 0 ? command.aliases : undefined,
			description: command.description ? truncate(command.description, DESCRIPTION_MAX_CHARS) : undefined,
			hint: command.input?.hint,
			subcommands: subcommands && subcommands.length > 0 ? subcommands : undefined,
			source: command.source,
		});
	}
	return commands;
}

/**
 * Resolve `text` against the advertised commands. The first token names the
 * command directly (`/skill:review`, `/compact`, or an alias); a builtin also
 * matches through its `/name:args` colon form, the way the builtin dispatcher
 * parses it. Anything not advertised, and a withheld builtin subcommand, is an error.
 */
export function resolveCollabCommand(
	text: string,
	commands: readonly CollabCommand[],
): { command: CollabCommand } | { error: string } {
	const unknown = { error: `unknown command ${text.split(/\s/, 1)[0]}` };
	const token = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : undefined;
	if (!token) return unknown;
	const parsed = parseSlashCommand(text);
	const command =
		commands.find(candidate => candidate.name === token || candidate.aliases?.includes(token)) ??
		(parsed
			? commands.find(
					candidate =>
						candidate.source === "builtin" &&
						(candidate.name === parsed.name || candidate.aliases?.includes(parsed.name)),
				)
			: undefined);
	if (!command) return unknown;
	const denied = command.source === "builtin" ? GUEST_DENIED_BUILTINS[command.name] : undefined;
	if (denied && denied !== true && parsed) {
		const { verb } = parseSubcommand(parsed.args);
		if (Object.hasOwn(denied, verb)) return { error: `/${command.name} ${verb} is not available to collab guests` };
	}
	return { command };
}

/** Host hooks the runner needs beyond the interactive context. */
export interface RunCollabCommandOptions {
	/** The advertised set may have changed (commands refreshed or plugins reloaded). */
	onCommandsChanged: () => void;
}

/**
 * Run a guest slash command that {@link resolveCollabCommand} resolved to
 * `command`. Output the command writes is stripped of ANSI escapes, joined
 * with newlines and capped at {@link COMMAND_OUTPUT_MAX_BYTES}; for
 * {@link TUI_ROUTED_BUILTINS} that is what they report through the host's
 * status, warning and error lines. A command that sends a prompt resolves
 * once the prompt is dispatched, not when the agent turn it starts ends.
 */
export async function runCollabCommand(
	ctx: InteractiveModeContext,
	text: string,
	command: CollabCommand,
	options: RunCollabCommandOptions,
): Promise<CollabCommandOutcome> {
	const output: string[] = [];
	try {
		if (command.source === "skill") {
			const built = await buildSkillCommandPrompt(ctx, text, "steer");
			if (!built) return { error: `unknown command /${command.name}` };
			const dispatched = await dispatchPrompt(ctx.session, () =>
				ctx.session.promptCustomMessage(built.message, built.options),
			);
			if (!dispatched) return { error: "Prompt was not submitted. Please resend it when the host is ready." };
		} else if (command.source === "builtin") {
			const route = TUI_ROUTED_BUILTINS[command.name];
			if (route) {
				const release = captureUiMessages(ctx, message => output.push(message));
				try {
					const usageText = await route(ctx, parseSlashCommand(text)?.args ?? "");
					if (usageText) output.push(usageText);
				} finally {
					release();
				}
			} else {
				const result = await executeAcpBuiltinSlashCommand(text, {
					session: ctx.session,
					sessionManager: ctx.sessionManager,
					settings: ctx.settings,
					cwd: ctx.sessionManager.getCwd(),
					output: chunk => {
						output.push(chunk);
					},
					refreshCommands: async () => {
						await ctx.refreshSlashCommandState();
						options.onCommandsChanged();
					},
					reloadPlugins: async () => {
						await reloadTuiPluginState(ctx);
						options.onCommandsChanged();
					},
					notifyTitleChanged: () => refreshHostUi(ctx),
					notifyConfigChanged: () => refreshHostUi(ctx),
				});
				if (result === false) return { error: `unknown command /${command.name}` };
				// The text-mode todo verbs update session state only; the host HUD reads it back.
				if (command.name === "todo") await ctx.reloadTodos();
				if ("prompt" in result) {
					const residual = result.prompt;
					await dispatchPrompt(ctx.session, () => ctx.session.prompt(residual, { streamingBehavior: "steer" }));
				}
			}
		} else {
			await dispatchPrompt(ctx.session, () => ctx.session.prompt(text, { streamingBehavior: "steer" }));
		}
	} catch (err) {
		return { error: errorMessage(err) };
	} finally {
		refreshHostUi(ctx);
	}
	return { output: capCommandOutput(Bun.stripANSI(output.join("\n"))) };
}

function refreshHostUi(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

type UiMessageMethod = "showStatus" | "showWarning" | "showError";
const UI_MESSAGE_METHODS: readonly UiMessageMethod[] = ["showStatus", "showWarning", "showError"];

/** How the interactive host renders a session notice with source `collab`. */
const COLLAB_NOTICE_PREFIX = "collab: ";

interface UiMessageCapture {
	sinks: Set<(message: string) => void>;
	restore(): void;
}

/** One wrapper per context, shared by every guest command capturing at the same time. */
const uiMessageCaptures = new WeakMap<InteractiveModeContext, UiMessageCapture>();

/**
 * Tee what `ctx` shows on its status, warning and error lines into `sink`
 * until the returned release runs; the host still sees every message.
 * Overlapping captures on one context share a single wrapper that fans out
 * to every active sink, and the originals come back when the last releases.
 */
function captureUiMessages(ctx: InteractiveModeContext, sink: (message: string) => void): () => void {
	let capture = uiMessageCaptures.get(ctx);
	if (!capture) {
		const sinks = new Set<(message: string) => void>();
		const restorers = UI_MESSAGE_METHODS.map(method => teeUiMessages(ctx, method, sinks));
		const created: UiMessageCapture = {
			sinks,
			restore: () => {
				for (const restore of restorers) restore();
				uiMessageCaptures.delete(ctx);
			},
		};
		uiMessageCaptures.set(ctx, created);
		capture = created;
	}
	const active = capture;
	active.sinks.add(sink);
	return () => {
		if (!active.sinks.delete(sink)) return;
		if (active.sinks.size === 0) active.restore();
	};
}

function teeUiMessages<K extends UiMessageMethod>(
	ctx: InteractiveModeContext,
	method: K,
	sinks: ReadonlySet<(message: string) => void>,
): () => void {
	const ownProperty = Object.hasOwn(ctx, method);
	const original = ctx[method];
	const show = original as unknown as (this: InteractiveModeContext, message: string, ...rest: unknown[]) => void;
	const tee = (message: string, ...rest: unknown[]): void => {
		// Collab's own session notices (e.g. "<peer> ran /<name>") describe the
		// room, not the command; they reach guests as notices already.
		if (!message.startsWith(COLLAB_NOTICE_PREFIX)) for (const sink of sinks) sink(message);
		show.call(ctx, message, ...rest);
	};
	ctx[method] = tee as unknown as InteractiveModeContext[K];
	return () => {
		if (ownProperty) ctx[method] = original;
		else Reflect.deleteProperty(ctx, method);
	};
}

/**
 * Start a prompt and resolve once it is dispatched: when `start` settles
 * (extension command handled locally, message queued as a steer, or rejected
 * before any turn) or when the agent turn it starts begins, whichever comes
 * first. `session.prompt()` on an idle session only settles when that turn
 * ends, which is not what a guest waiting on its command should wait for.
 * Resolves to `start`'s result, or `true` once the turn began.
 */
async function dispatchPrompt(session: AgentSession, start: () => Promise<boolean>): Promise<boolean> {
	const { promise: turnStarted, resolve: onTurnStarted } = Promise.withResolvers<true>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") onTurnStarted(true);
	});
	let answered = false;
	try {
		const run = start();
		// A failure after the turn began has no guest request left to answer;
		// one before it rejects the race below instead.
		run.catch(err => {
			if (answered) logger.warn("collab guest command prompt failed", { error: String(err) });
		});
		return await Promise.race([run, turnStarted]);
	} finally {
		answered = true;
		unsubscribe();
	}
}

/**
 * Cap `text` at {@link COMMAND_OUTPUT_MAX_BYTES} of UTF-8, cutting on a
 * character boundary and appending a line that says it was truncated.
 */
export function capCommandOutput(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= COMMAND_OUTPUT_MAX_BYTES) return text;
	let end = COMMAND_OUTPUT_MAX_BYTES;
	// Back off UTF-8 continuation bytes so the cut never splits a character.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n[output truncated: ${bytes.byteLength} bytes total, showing the first ${end}]`;
}
