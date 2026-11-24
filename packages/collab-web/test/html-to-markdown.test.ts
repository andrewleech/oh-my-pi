import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { htmlClipboardToMarkdown } from "../src/components/shell/html-to-markdown";

let originalParser: PropertyDescriptor | undefined;

beforeAll(() => {
	originalParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
	Object.defineProperty(globalThis, "DOMParser", {
		configurable: true,
		writable: true,
		value: new Window().DOMParser,
	});
});

afterAll(() => {
	if (originalParser) Object.defineProperty(globalThis, "DOMParser", originalParser);
	else Reflect.deleteProperty(globalThis, "DOMParser");
});

function convert(html: string, plain = "", types: readonly string[] = ["text/html", "text/plain"]): string | null {
	return htmlClipboardToMarkdown({ html, plain, types });
}

describe("htmlClipboardToMarkdown", () => {
	it("converts a web page article fragment", () => {
		const html = `<html><body><!--StartFragment--><h1>Release notes</h1><p>Read the <a href="https://example.test/docs">docs</a> and <strong>upgrade</strong> soon.</p><h2>Changes</h2><ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol><hr><blockquote>quoted</blockquote><!--EndFragment--></body></html>`;

		expect(convert(html, "Release notes\nRead the docs and upgrade soon.")).toBe(
			[
				"# Release notes",
				"",
				"Read the [docs](https://example.test/docs) and **upgrade** soon.",
				"",
				"## Changes",
				"",
				"- first",
				"- second",
				"  - nested",
				"",
				"3. three",
				"4. four",
				"",
				"---",
				"",
				"> quoted",
			].join("\n"),
		);
	});

	it("converts Google Docs span styles and unwraps the normal-weight <b> wrapper", () => {
		const html = `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38"><span style="font-size:11pt;font-weight:700">Bold</span><span style="font-size:11pt;font-style:italic"> italic</span><span style="text-decoration:line-through"> gone</span><span> plain</span></p><ul><li dir="ltr"><p dir="ltr"><span>a</span></p></li><ul><li dir="ltr"><p dir="ltr"><span>b</span></p></li></ul><li dir="ltr"><p dir="ltr"><span>c</span></p></li></ul></b>`;

		expect(convert(html, "Bold italic gone plain\na\nb\nc")).toBe(
			["**Bold** _italic_ ~~gone~~ plain", "", "- a", "  - b", "- c"].join("\n"),
		);
	});

	it("does not treat a normal-weight <b> wrapper as emphasis", () => {
		const html = `<b style="font-weight:normal;"><p><span>just text</span></p></b>`;

		expect(convert(html, "just text")).toBeNull();
	});

	it("converts Word fragments: conditional comments, mso classes and mso lists", () => {
		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><style>p.MsoNormal{margin:0}</style></head><body><!--StartFragment--><p class=MsoNormal><b>Heading</b> text<o:p></o:p></p><p class=MsoListParagraphCxSpFirst style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;</span></span><![endif]>First<o:p></o:p></p><p class=MsoListParagraphCxSpMiddle style='margin-left:72.0pt;text-indent:-18.0pt;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>o<span>&nbsp;&nbsp;</span></span><![endif]>Second<o:p></o:p></p><p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>·</span><![endif]>Third</p><p class=MsoNormal>1. not a list</p><!--EndFragment--></body></html>`;

		const markdown = convert(html, "Heading text\n·  First\no  Second\n·  Third\n1. not a list");

		expect(markdown).toBe(
			["**Heading** text", "", "- First", "  - Second", "- Third", "", "1\\. not a list"].join("\n"),
		);
		expect(markdown).not.toContain("mso");
		expect(markdown).not.toContain("OfficeDocumentSettings");
	});

	it("converts a Sheets/Excel table to a GFM table and escapes pipes", () => {
		const html = `<google-sheets-html-origin><table xmlns="http://www.w3.org/1999/xhtml"><colgroup><col width="100"><col width="100"></colgroup><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr><tr><td>a|b</td><td>4</td></tr></tbody></table></google-sheets-html-origin>`;

		expect(convert(html, "Name\tQty\nApple\t3\na|b\t4")).toBe(
			["| Name | Qty |", "| --- | --- |", "| Apple | 3 |", "| a\\|b | 4 |"].join("\n"),
		);
	});

	it("keeps an explicit header row", () => {
		const html = `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`;

		expect(convert(html, "A\tB\n1\t2")).toBe(["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
	});

	it("converts task lists, strikethrough, inline code and fenced code", () => {
		const html = `<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox" disabled> todo</li></ul><p><del>old</del> and <code>x</code></p><pre><code class="language-ts"><span>const</span> a = 1;<br>const b = 2;</code></pre>`;

		expect(convert(html, "")).toBe(
			["- [x] done", "- [ ] todo", "", "~~old~~ and `x`", "", "```ts", "const a = 1;", "const b = 2;", "```"].join(
				"\n",
			),
		);
	});

	it("fences a <pre> without <code>", () => {
		expect(convert("<pre>a\n  b</pre><p>tail <b>x</b></p>", "")).toBe(
			["```", "a", "  b", "```", "", "tail **x**"].join("\n"),
		);
	});

	it("keeps http image links with text and drops other images", () => {
		const html = `<p>see <img alt="pic" src="https://example.test/a.png"> and <img alt="inline" src="data:image/png;base64,AAAA"></p>`;

		expect(convert(html, "see and")).toBe("see ![pic](https://example.test/a.png) and");
	});

	it("returns null for VS Code editor copies", () => {
		const html = `<meta charset='utf-8'><div style="color:#ccc"><div><span style="color:#569cd6">const</span><span> a = </span><b>1</b></div></div>`;

		expect(convert(html, "const a = 1", ["text/plain", "text/html", "vscode-editor-data"])).toBeNull();
	});

	it("returns null for span-only terminal copies", () => {
		const html = `<meta charset='utf-8'><div style="font-family:monospace"><span style="color:red">error:</span><span> failed</span><br><span>second line</span></div>`;

		expect(convert(html, "error: failed\nsecond line")).toBeNull();
	});

	it("returns null for plain div, p and br markup", () => {
		expect(convert("<div>a</div><p>b</p><br><div>c</div>", "a\nb\nc")).toBeNull();
	});

	it("strips hidden and non-content elements", () => {
		const html = `<head><title>Page</title><style>.x{}</style></head><body><p>visible</p><p style="display: none">secret one</p><p style="color:red;visibility:hidden">secret two</p><div hidden>secret three</div><span aria-hidden="true">secret four</span><script>alert(1)</script><noscript>secret five</noscript><template><p>secret six</p></template><p><b>bold</b></p></body>`;

		const markdown = convert(html, "visible\nbold");

		expect(markdown).toBe("visible\n\n**bold**");
	});

	it("drops javascript: and data: links but keeps their text; keeps http(s) and mailto", () => {
		const html = `<p><a href="javascript:alert(1)">js</a> <a href=" JaVaScRiPt:alert(1)">js2</a> <a href="java&#9;script:alert(1)">js3</a> <a href="data:text/html,x">data</a> <a href="/relative">rel</a> <a href="https://example.test/a">web</a> <a href="http://example.test/b">plain</a> <a href="mailto:a@example.test">mail</a></p>`;

		const markdown = convert(html, "");

		expect(markdown).toBe(
			"js js2 js3 data rel [web](https://example.test/a) [plain](http://example.test/b) [mail](mailto:a@example.test)",
		);
	});

	it("returns null for an image-only fragment", () => {
		expect(convert(`<img src="https://example.test/a.png">`, "")).toBeNull();
	});

	it("returns null for empty and oversized html", () => {
		expect(convert("", "x")).toBeNull();
		const big = `<p><b>${"a".repeat(1_000_000)}</b></p>`;
		expect(convert(big, "x")).toBeNull();
	});

	it("returns null when the result is empty", () => {
		expect(convert("<p><b> </b></p>", "")).toBeNull();
		expect(convert(`<div hidden><b>x</b></div>`, "")).toBeNull();
	});

	it("returns null when the markdown equals the plain text after whitespace normalisation", () => {
		expect(convert("<p><b>hello world</b></p>", "  **hello\n world**  ")).toBeNull();
		expect(convert("<p><b>hello world</b></p>", "hello world")).toBe("**hello world**");
	});
});
