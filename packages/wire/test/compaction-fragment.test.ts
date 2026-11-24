import { describe, expect, it } from "bun:test";
import { CompactionFragmentAssembler, type HostFrame, type SessionEntry } from "../src/index";

type Fragment = Extract<HostFrame, { t: "compaction-fragment" }>;

function fragments(entry: SessionEntry, scope: "snapshot" | "live" = "snapshot"): Fragment[] {
	const json = JSON.stringify(entry);
	const parts = Math.ceil(json.length / (64 * 1024));
	return Array.from({ length: parts }, (_, part) => ({
		t: "compaction-fragment",
		transferId: "transfer-1",
		scope,
		entryId: entry.id,
		part,
		parts,
		byteLength: new TextEncoder().encode(json).length,
		data: json.slice(part * 64 * 1024, (part + 1) * 64 * 1024),
	}));
}

const entry = {
	type: "compaction",
	id: "compact-1",
	parentId: "before",
	timestamp: "2026-01-01T00:00:00Z",
	summary: `${"a".repeat(65500)}😀"\\\n漢${"z".repeat(140000)}`,
	firstKeptEntryId: "before",
	tokensBefore: 100,
	preserveData: { snapcompact: { text: "full archive", frames: [{ data: "aGVsbG8=", mimeType: "image/png" }] } },
} as SessionEntry;

describe("CompactionFragmentAssembler", () => {
	for (const scope of ["snapshot", "live"] as const) {
		it(`reconstructs ${scope} JSON including unicode exactly`, () => {
			const assembler = new CompactionFragmentAssembler();
			const frames = fragments(entry, scope);
			expect(assembler.pending).toBe(false);
			for (const frame of frames.slice(0, -1)) {
				expect(assembler.accept(frame)).toBeUndefined();
				expect(assembler.pending).toBe(true);
			}
			expect(assembler.accept(frames[frames.length - 1]!)).toEqual(entry);
			expect(assembler.pending).toBe(false);
		});
	}

	it("reassembles interleaved transfers independently across scopes", () => {
		const other = { ...entry, id: "compact-2", summary: "second 😀".repeat(12_000) } as SessionEntry;
		const first = fragments(entry);
		const second = fragments(other, "live").map(frame => ({ ...frame, transferId: "transfer-2" }));
		const assembler = new CompactionFragmentAssembler();
		expect(assembler.accept(first[0]!)).toBeUndefined();
		expect(assembler.accept(second[0]!)).toBeUndefined();
		for (const frame of second.slice(1, -1)) expect(assembler.accept(frame)).toBeUndefined();
		expect(assembler.accept(second[second.length - 1]!)).toEqual(other);
		expect(assembler.pending).toBe(true);
		for (const frame of first.slice(1, -1)) expect(assembler.accept(frame)).toBeUndefined();
		expect(assembler.accept(first[first.length - 1]!)).toEqual(entry);
		expect(assembler.pending).toBe(false);
	});

	it("discards every pending transfer after an invalid interleaved fragment", () => {
		const first = fragments(entry);
		const other = { ...entry, id: "compact-2" } as SessionEntry;
		const second = fragments(other).map(frame => ({ ...frame, transferId: "transfer-2" }));
		const assembler = new CompactionFragmentAssembler();
		assembler.accept(first[0]!);
		assembler.accept(second[0]!);
		expect(() => assembler.accept({ ...second[1]!, part: 2 })).toThrow();
		expect(assembler.pending).toBe(false);
		expect(() => assembler.accept(first[1]!)).toThrow();
	});

	it("bounds simultaneous transfers and releases them on reset", () => {
		const first = fragments(entry)[0]!;
		const assembler = new CompactionFragmentAssembler();
		for (let index = 0; index < 128; index++) {
			expect(assembler.accept({ ...first, transferId: `transfer-${index}` })).toBeUndefined();
		}
		expect(() => assembler.accept({ ...first, transferId: "transfer-over-limit" })).toThrow();
		expect(assembler.pending).toBe(false);
		expect(assembler.accept({ ...first, transferId: "transfer-after-reset" })).toBeUndefined();
		assembler.reset();
		expect(assembler.pending).toBe(false);
	});

	it("joins a surrogate pair split across fragments before parsing", () => {
		const candidate = { ...entry, summary: "😀" } as SessionEntry;
		const prefixLength = JSON.stringify(candidate).indexOf("😀");
		const splitEntry = { ...candidate, summary: `${"x".repeat(65535 - prefixLength)}😀` } as SessionEntry;
		const frames = fragments(splitEntry);
		expect(frames[0]!.data.charCodeAt(65535)).toBe(0xd83d);
		expect(frames[1]!.data.charCodeAt(0)).toBe(0xde00);
		const assembler = new CompactionFragmentAssembler();
		expect(assembler.accept(frames[0]!)).toBeUndefined();
		expect(assembler.accept(frames[1]!)).toEqual(splitEntry);
	});

	it("does not emit a truncated transfer and reset discards it", () => {
		const assembler = new CompactionFragmentAssembler();
		const frames = fragments(entry);
		expect(assembler.accept(frames[0]!)).toBeUndefined();
		expect(assembler.pending).toBe(true);
		assembler.reset();
		expect(assembler.pending).toBe(false);
		expect(() => assembler.accept(frames[1]!)).toThrow();
	});

	it("rejects out of order, duplicate, inconsistent, and invalid fragments", () => {
		const frames = fragments(entry);
		const first = frames[0]!;
		const second = frames[1]!;
		for (const bad of [
			{ ...first, part: -1 },
			{ ...first, part: 1 },
			{ ...first, part: 0.5 },
			{ ...first, parts: 0 },
			{ ...first, parts: 1.5 },
			{ ...first, byteLength: -1 },
			{ ...first, byteLength: 256 * 1024 * 1024 + 1 },
			{ ...first, parts: Number.MAX_SAFE_INTEGER },
			{ ...first, scope: "unknown" },
			{ ...first, entryId: "" },
			{ ...first, transferId: "" },
			{ ...first, data: "x".repeat(64 * 1024 + 1) },
		]) {
			const assembler = new CompactionFragmentAssembler();
			expect(() => assembler.accept(bad as Fragment)).toThrow();
		}
		for (const bad of [
			first,
			{ ...second, transferId: "other" },
			{ ...second, entryId: "other" },
			{ ...second, scope: "live" },
			{ ...second, parts: second.parts + 1 },
			{ ...second, byteLength: second.byteLength + 1 },
		]) {
			const assembler = new CompactionFragmentAssembler();
			assembler.accept(first);
			expect(() => assembler.accept(bad as Fragment)).toThrow();
		}
	});

	it("rejects invalid JSON, a mismatched entry id and a mismatched byte length", () => {
		const valid = fragments(entry);
		for (const frames of [
			valid.map(frame => ({ ...frame, entryId: "other" })),
			valid.map(frame => ({ ...frame, byteLength: frame.byteLength + 1 })),
			valid.map((frame, index) =>
				index === valid.length - 1 ? { ...frame, data: `${frame.data.slice(0, -1)}!` } : frame,
			),
		]) {
			const assembler = new CompactionFragmentAssembler();
			for (const frame of frames.slice(0, -1)) assembler.accept(frame);
			expect(() => assembler.accept(frames[frames.length - 1]!)).toThrow();
		}
	});
});
