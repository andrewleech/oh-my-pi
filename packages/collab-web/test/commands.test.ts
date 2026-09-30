import { describe, expect, it } from "bun:test";
import type { CollabCommand } from "@oh-my-pi/pi-wire";
import { commandSuggestions, matchCommand } from "../src/lib/commands";

const COMMANDS: CollabCommand[] = [
	{ name: "compact", description: "Compact the context", hint: "[focus]", source: "builtin" },
	{ name: "session", aliases: ["info"], description: "Show session info", source: "builtin" },
	{
		name: "model",
		aliases: ["models"],
		hint: "[model]",
		subcommands: [
			{ name: "list", description: "List models", usage: "[filter]" },
			{ name: "local", description: "Local models" },
			{ name: "set", description: "Set the model" },
		],
		source: "builtin",
	},
	{ name: "skill:review", description: "Review code", source: "skill" },
	{ name: "import-commit", source: "custom" },
];

const labels = (text: string, limit?: number): string[] =>
	commandSuggestions(COMMANDS, text, limit).map(suggestion => suggestion.label);

describe("matchCommand", () => {
	it("matches the first token by name or alias, ignoring arguments", () => {
		expect(matchCommand(COMMANDS, "/compact")?.name).toBe("compact");
		expect(matchCommand(COMMANDS, "/compact keep the API notes")?.name).toBe("compact");
		expect(matchCommand(COMMANDS, "/info")?.name).toBe("session");
		expect(matchCommand(COMMANDS, "/model\tlist")?.name).toBe("model");
	});

	it("matches names containing a colon", () => {
		expect(matchCommand(COMMANDS, "/skill:review src/lib")?.name).toBe("skill:review");
		expect(matchCommand(COMMANDS, "/skill")).toBeUndefined();
	});

	it("accepts the builtin colon form for builtins only", () => {
		expect(matchCommand(COMMANDS, "/compact:full")?.name).toBe("compact");
		expect(matchCommand(COMMANDS, "/models:gpt-5")?.name).toBe("model");
		expect(matchCommand(COMMANDS, "/info:verbose extra")?.name).toBe("session");
		// import-commit is not a builtin, so its colon form stays a prompt.
		expect(matchCommand(COMMANDS, "/import-commit:abc")).toBeUndefined();
		expect(matchCommand(COMMANDS, "/:compact")).toBeUndefined();
	});

	it("prefers a listed colon name over a builtin sharing its prefix", () => {
		const withSkillBuiltin: CollabCommand[] = [{ name: "skill", source: "builtin" }, ...COMMANDS];
		expect(matchCommand(withSkillBuiltin, "/skill:review")?.name).toBe("skill:review");
		expect(matchCommand(withSkillBuiltin, "/skill:other")?.name).toBe("skill");
		expect(matchCommand(COMMANDS, "/skill:other")).toBeUndefined();
	});

	it("rejects prefixes, unknown commands, and non-command text", () => {
		expect(matchCommand(COMMANDS, "/comp")).toBeUndefined();
		expect(matchCommand(COMMANDS, "/foo bar")).toBeUndefined();
		expect(matchCommand(COMMANDS, "/")).toBeUndefined();
		expect(matchCommand(COMMANDS, "/ compact")).toBeUndefined();
		expect(matchCommand(COMMANDS, "compact")).toBeUndefined();
		expect(matchCommand(COMMANDS, "/Compact")).toBeUndefined();
	});
});

describe("commandSuggestions", () => {
	it("lists every command in host order for a bare slash, up to the limit", () => {
		expect(labels("/")).toEqual(["/compact", "/session", "/model", "/skill:review", "/import-commit"]);
		expect(labels("/", 2)).toEqual(["/compact", "/session"]);
	});

	it("ranks prefix matches before substring matches, case-insensitively", () => {
		// "co": prefix of compact; substring of import-commit.
		expect(labels("/CO")).toEqual(["/compact", "/import-commit"]);
		// "m": prefix of model; substring of compact, import-commit.
		expect(labels("/m")).toEqual(["/model", "/compact", "/import-commit"]);
	});

	it("ranks an exact name first and matches aliases", () => {
		expect(labels("/model")).toEqual(["/model"]);
		expect(labels("/inf")).toEqual(["/session"]);
	});

	it("completes colon names", () => {
		expect(labels("/skill:")).toEqual(["/skill:review"]);
	});

	it("replaces with the canonical name and a trailing space", () => {
		const [suggestion] = commandSuggestions(COMMANDS, "/inf");
		expect(suggestion).toMatchObject({
			label: "/session",
			description: "Show session info",
			replacement: "/session ",
		});
		expect(commandSuggestions(COMMANDS, "/comp")[0]).toMatchObject({ hint: "[focus]", replacement: "/compact " });
	});

	it("suggests subcommands of a listed command by prefix", () => {
		expect(labels("/model ")).toEqual(["list", "local", "set"]);
		expect(labels("/models lo")).toEqual(["local"]);
		expect(commandSuggestions(COMMANDS, "/model LI")[0]).toMatchObject({
			hint: "[filter]",
			description: "List models",
			replacement: "/model list ",
		});
	});

	it("stops suggesting past the first argument or for commands without subcommands", () => {
		expect(labels("/model list ")).toEqual([]);
		expect(labels("/model list gpt")).toEqual([]);
		expect(labels("/compact now")).toEqual([]);
		expect(labels("/nope ")).toEqual([]);
		expect(labels("/zzz")).toEqual([]);
		expect(labels("hello /model")).toEqual([]);
	});
});
