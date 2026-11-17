/**
 * Slash-command matching and autocomplete over the host's advertised
 * {@link CollabCommand} list. Pure functions; the composer owns all state.
 */

import type { CollabCommand } from "@oh-my-pi/pi-wire";

/** One autocomplete row: what to show, and the composer text that applying it produces. */
export interface CommandSuggestion {
	/** Stable per list, e.g. `compact` or `model list`. */
	key: string;
	/** Display label: `/compact` for a command, `list` for a subcommand. */
	label: string;
	/** Argument hint (command) or usage (subcommand). */
	hint?: string;
	description?: string;
	/** Full composer text after applying, always ending in a space. */
	replacement: string;
}

/**
 * The listed command named (or aliased) by the first whitespace-delimited token
 * after the leading `/`. Exact, case-sensitive match; `undefined` when the text
 * is not a listed command.
 *
 * Names may contain `:` (`/skill:review`) and match whole first. Failing that,
 * a token with `:` falls back to the builtin colon form the host's
 * `parseSlashCommand` accepts (`/compact:full`, `/model:gpt-5`): the part before
 * the first `:` is matched against builtin commands.
 */
export function matchCommand(commands: readonly CollabCommand[], text: string): CollabCommand | undefined {
	if (!text.startsWith("/")) return undefined;
	const token = /^\S*/.exec(text.slice(1))![0];
	if (!token) return undefined;
	const direct = commands.find(command => command.name === token || command.aliases?.includes(token));
	if (direct) return direct;
	const colon = token.indexOf(":");
	if (colon <= 0) return undefined;
	const head = token.slice(0, colon);
	return commands.find(
		command => command.source === "builtin" && (command.name === head || command.aliases?.includes(head)),
	);
}

/** 0 = exact, 1 = prefix, 2 = substring, undefined = no match; best over name and aliases. */
function rankNames(names: readonly string[], partial: string): number | undefined {
	let best: number | undefined;
	for (const raw of names) {
		const name = raw.toLowerCase();
		const rank = name === partial ? 0 : name.startsWith(partial) ? 1 : name.includes(partial) ? 2 : undefined;
		if (rank !== undefined && (best === undefined || rank < best)) best = rank;
	}
	return best;
}

/**
 * Autocomplete rows for the composer text.
 *
 * - `/partial` (no whitespace): commands whose name or alias matches `partial`
 *   case-insensitively; exact matches first, then prefix matches, then
 *   substring matches, host order within each group.
 * - `/name partial` (one space-separated argument, no further whitespace) for a
 *   listed command with subcommands: subcommands starting with `partial`.
 *
 * Anything else (plain text, a second argument, a command without subcommands)
 * yields no suggestions.
 */
export function commandSuggestions(commands: readonly CollabCommand[], text: string, limit = 8): CommandSuggestion[] {
	if (!text.startsWith("/")) return [];
	const body = text.slice(1);

	if (!/\s/.test(body)) {
		const partial = body.toLowerCase();
		const ranked: { rank: number; command: CollabCommand }[] = [];
		for (const command of commands) {
			const rank = rankNames([command.name, ...(command.aliases ?? [])], partial);
			if (rank !== undefined) ranked.push({ rank, command });
		}
		// Array#sort is stable, so host order holds within each rank.
		ranked.sort((a, b) => a.rank - b.rank);
		return ranked.slice(0, limit).map(({ command }) => ({
			key: command.name,
			label: `/${command.name}`,
			hint: command.hint,
			description: command.description,
			replacement: `/${command.name} `,
		}));
	}

	const args = /^(\S+)\s+(\S*)$/.exec(body);
	if (!args) return [];
	const [, token = "", partialArg = ""] = args;
	const command = commands.find(candidate => candidate.name === token || candidate.aliases?.includes(token));
	if (!command?.subcommands?.length) return [];
	const partial = partialArg.toLowerCase();
	return command.subcommands
		.filter(sub => sub.name.toLowerCase().startsWith(partial))
		.slice(0, limit)
		.map(sub => ({
			key: `${command.name} ${sub.name}`,
			label: sub.name,
			hint: sub.usage,
			description: sub.description,
			replacement: `/${command.name} ${sub.name} `,
		}));
}
