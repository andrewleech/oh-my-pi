import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollabCommand } from "@oh-my-pi/pi-wire";
import type { CommandRun, GuestSnapshot } from "../src/lib/client";
import { GuestClient } from "../src/lib/client";
import { Composer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function snapshot(uiRequest: GuestSnapshot["uiRequest"], overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly: false,
		uiRequest,
		notices: [],
		loading: null,
		commands: null,
		command: null,
		...overrides,
	};
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

describe("Composer slash commands", () => {
	const COMMANDS: CollabCommand[] = [{ name: "compact", source: "builtin" }];

	function placeholder(snap: GuestSnapshot): string | undefined {
		let value: string | undefined;
		new HTMLRewriter()
			.on("textarea", {
				element(el) {
					value = el.getAttribute("placeholder") ?? undefined;
				},
			})
			.transform(renderToStaticMarkup(<Composer client={client} snapshot={snap} />));
		return value;
	}

	function resultPanel(command: CommandRun): { status: string; output: string | null; dismissable: boolean } {
		const html = renderToStaticMarkup(<Composer client={client} snapshot={snapshot(null, { command })} />);
		const panel = { status: "", output: null as string | null, dismissable: false };
		new HTMLRewriter()
			.on(".sh-cmd-result-status", {
				text(chunk) {
					panel.status += chunk.text;
				},
			})
			.on(".sh-cmd-result-output", {
				text(chunk) {
					panel.output = (panel.output ?? "") + chunk.text;
				},
			})
			.on('button[aria-label="Dismiss command result"]', {
				element() {
					panel.dismissable = true;
				},
			})
			.transform(html);
		return panel;
	}

	it("mentions / in the placeholder only when the host runs commands", () => {
		expect(placeholder(snapshot(null, { commands: COMMANDS }))).toContain("/ for commands");
		expect(placeholder(snapshot(null))).not.toContain("/");
	});

	it("shows a running command without output or dismiss", () => {
		expect(resultPanel({ reqId: 1, text: "/compact", status: "running", output: "" })).toEqual({
			status: "running…",
			output: null,
			dismissable: false,
		});
	});

	it("shows a finished command's output with a dismiss button", () => {
		expect(resultPanel({ reqId: 1, text: "/session", status: "done", output: "id: s1\ncwd: /work" })).toEqual({
			status: "done",
			output: "id: s1\ncwd: /work",
			dismissable: true,
		});
	});

	it("shows a finished command with no output as a bare done header", () => {
		expect(resultPanel({ reqId: 1, text: "/skill:review", status: "done", output: "" })).toEqual({
			status: "done",
			output: null,
			dismissable: true,
		});
	});

	it("shows a failed command's error", () => {
		expect(resultPanel({ reqId: 1, text: "/compact", status: "error", output: "unknown command" })).toEqual({
			status: "failed",
			output: "unknown command",
			dismissable: true,
		});
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});
