import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { importRoomKey, seal } from "../src/lib/codec";
import { packEnvelope } from "../src/lib/link";
import type { GuestSnapshot } from "../src/lib/client";
import {
	base64Length,
	type DecodedImage,
	decidePromptSend,
	type EncodedMimeType,
	encodeWithinCap,
	fitPromptImages,
	fitWithinEdge,
	type ImageCodec,
	type ImageFile,
	MAX_IMAGE_EDGE_PX,
	PROMPT_FRAME_LIMIT_BYTES,
	PROMPT_IMAGE_BUDGET_BYTES,
	type PrepareResult,
	RELAY_FRAME_LIMIT_BYTES,
	sealedPromptFrameBytes,
} from "../src/lib/prompt-images";

/** A fake file: what is known up front plus the natural size decoding reveals. */
interface FakeFile extends ImageFile {
	readonly width: number;
	readonly height: number;
	readonly decodable: boolean;
}

interface EncodeCall {
	name: string;
	width: number;
	height: number;
	mimeType: EncodedMimeType;
	quality: number;
}

/**
 * Deterministic stand-in for the canvas codec: encoded size is proportional to
 * pixel count (PNG) or pixel count × quality (JPEG), so the ladder behaves like
 * a real encoder without a DOM.
 */
function fakeCodec(opts: { pngBytesPerPx: number; jpegBytesPerPx: number }): ImageCodec<FakeFile> & {
	calls: EncodeCall[];
	originals: string[];
	/** Files decoded, in order, with the edge limit each was decoded for. */
	decodes: { name: string; maxEdge: number }[];
	/** Decoded images not yet closed. */
	open: Set<string>;
	/** Most decoded images open at once. */
	peakOpen: number;
} {
	const codec = {
		calls: [] as EncodeCall[],
		originals: [] as string[],
		decodes: [] as { name: string; maxEdge: number }[],
		open: new Set<string>(),
		peakOpen: 0,
		async original(file: FakeFile) {
			codec.originals.push(file.name);
			return "o".repeat(base64Length(file.byteLength));
		},
		async decode(file: FakeFile, maxEdge: number): Promise<DecodedImage | null> {
			codec.decodes.push({ name: file.name, maxEdge });
			if (!file.decodable) return null;
			codec.open.add(file.name);
			codec.peakOpen = Math.max(codec.peakOpen, codec.open.size);
			return {
				width: file.width,
				height: file.height,
				async encode(width, height, mimeType, quality) {
					codec.calls.push({ name: file.name, width, height, mimeType, quality });
					const perPx = mimeType === "image/png" ? opts.pngBytesPerPx : opts.jpegBytesPerPx * quality;
					return { type: "image", data: "e".repeat(base64Length(Math.ceil(width * height * perPx))), mimeType };
				},
				close() {
					codec.open.delete(file.name);
				},
			};
		},
	};
	return codec;
}

function source(
	name: string,
	mimeType: string,
	width: number,
	height: number,
	byteLength: number,
	decodable = true,
): FakeFile {
	return { name, mimeType, width, height, byteLength, decodable };
}

/** Runs `encodeWithinCap` on a freshly decoded `file`. */
async function encode(file: FakeFile, cap: number, codec: ReturnType<typeof fakeCodec>) {
	const decoded = await codec.decode(file, MAX_IMAGE_EDGE_PX);
	if (!decoded) throw new Error(`${file.name} did not decode`);
	return encodeWithinCap(file, decoded, cap, codec);
}

describe("fitWithinEdge", () => {
	it("keeps images at or under the edge limit untouched", () => {
		expect(fitWithinEdge(MAX_IMAGE_EDGE_PX, 900, MAX_IMAGE_EDGE_PX)).toEqual({
			width: MAX_IMAGE_EDGE_PX,
			height: 900,
		});
		expect(fitWithinEdge(40, 30, MAX_IMAGE_EDGE_PX)).toEqual({ width: 40, height: 30 });
	});

	it("scales the longest edge down to the limit, preserving aspect ratio", () => {
		expect(fitWithinEdge(MAX_IMAGE_EDGE_PX + 1, 10, MAX_IMAGE_EDGE_PX).width).toBe(MAX_IMAGE_EDGE_PX);
		expect(fitWithinEdge(3000, 4000, MAX_IMAGE_EDGE_PX)).toEqual({ width: 1176, height: MAX_IMAGE_EDGE_PX });
	});

	it("never collapses a thin edge to zero", () => {
		expect(fitWithinEdge(100_000, 1, MAX_IMAGE_EDGE_PX)).toEqual({ width: MAX_IMAGE_EDGE_PX, height: 1 });
	});
});

describe("encodeWithinCap", () => {
	it("sends an accepted format untouched when its base64 fits the cap exactly", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 1, jpegBytesPerPx: 1 });
		const img = source("shot.png", "image/png", 800, 600, 3000);
		const out = await encode(img, base64Length(3000), codec);
		expect(out?.mimeType).toBe("image/png");
		expect(out?.data.length).toBe(base64Length(3000));
		expect(codec.originals).toEqual(["shot.png"]);
		expect(codec.calls).toEqual([]);
	});

	it("re-encodes once the original is one byte over the cap", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 0.001, jpegBytesPerPx: 1 });
		const img = source("shot.png", "image/png", 800, 600, 3000);
		const out = await encode(img, base64Length(3000) - 1, codec);
		expect(codec.originals).toEqual([]);
		expect(out?.mimeType).toBe("image/png");
		expect(out!.data.length).toBeLessThan(base64Length(3000));
	});

	it("re-encodes formats the host does not accept even when small", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 0.01, jpegBytesPerPx: 1 });
		const out = await encode(source("photo.heic", "image/heic", 100, 100, 10), 10_000, codec);
		expect(codec.originals).toEqual([]);
		expect(out?.mimeType).toBe("image/png");
	});

	it("downscales oversized sources to the edge limit before encoding", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 0.01, jpegBytesPerPx: 1 });
		const out = await encode(source("big.png", "image/png", 4000, 2000, 50), 1_000_000, codec);
		expect(out).not.toBeNull();
		expect(codec.originals).toEqual([]);
		expect(codec.calls[0]).toMatchObject({ width: MAX_IMAGE_EDGE_PX, height: 784, mimeType: "image/png" });
	});

	it("falls back to JPEG when PNG is over the cap, and never tries PNG for JPEG sources", async () => {
		const png = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 0.2 });
		const fromPng = await encode(source("ui.png", "image/png", 1000, 1000, 4_000_000), 300_000, png);
		expect(fromPng?.mimeType).toBe("image/jpeg");
		expect(png.calls[0].mimeType).toBe("image/png");

		const jpeg = fakeCodec({ pngBytesPerPx: 0, jpegBytesPerPx: 0.2 });
		await encode(source("cam.jpg", "image/jpeg", 4000, 3000, 5_000_000), 300_000, jpeg);
		expect(jpeg.calls.every(call => call.mimeType === "image/jpeg")).toBe(true);
	});

	it("walks quality then scale until the result fits", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 1 });
		const cap = 400_000;
		const out = await encode(source("cam.jpg", "image/jpeg", 1568, 1568, 5_000_000), cap, codec);
		expect(out!.data.length).toBeLessThanOrEqual(cap);
		const chosen = codec.calls.at(-1)!;
		expect(chosen.width).toBeLessThan(1568);
		// Every rejected step produced more than the cap.
		expect(codec.calls.length).toBeGreaterThan(1);
	});

	it("returns null when even the smallest step is over the cap", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 4 });
		expect(await encode(source("huge.png", "image/png", 1568, 1568, 9_000_000), 1000, codec)).toBeNull();
	});
});

describe("fitPromptImages", () => {
	it("keeps the total within the budget and preserves input order", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 1 });
		const sources = [
			source("a.jpg", "image/jpeg", 3000, 2000, 3_000_000),
			source("b.png", "image/png", 1200, 800, 900_000),
			source("c.jpg", "image/jpeg", 4000, 3000, 6_000_000),
		];
		const result = await fitPromptImages(sources, codec);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const total = result.images.reduce((sum, image) => sum + image.data.length, 0);
		expect(total).toBeLessThanOrEqual(PROMPT_IMAGE_BUDGET_BYTES);
		expect(result.images).toHaveLength(3);
		const encodedNames = new Set(codec.calls.map(call => call.name));
		expect(encodedNames).toEqual(new Set(["a.jpg", "b.png", "c.jpg"]));
	});

	it("rolls a small image's unused share over to a larger one", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 1, jpegBytesPerPx: 1 });
		const budget = 100_000;
		// The icon needs ~1.3 KB of its 50 KB share; the screenshot's original needs 80 KB, over an even split.
		const icon = source("icon.png", "image/png", 32, 32, 1000);
		const shot = source("shot.png", "image/png", 1000, 700, 60_000);
		const result = await fitPromptImages([shot, icon], codec, budget);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(codec.originals).toEqual(["icon.png", "shot.png"]);
		expect(result.images[0].data.length).toBe(base64Length(60_000));
		expect(result.images[1].data.length).toBe(base64Length(1000));
	});

	it("refuses a single image that cannot fit and names it", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 4 });
		const result = await fitPromptImages([source("huge.png", "image/png", 1568, 1568, 9_000_000)], codec, 1000);
		expect(result).toEqual({ ok: false, message: "huge.png is too large to send, even downscaled" });
	});

	it("refuses a set that cannot share the budget", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 4 });
		const sources = Array.from({ length: 3 }, (_, i) => source(`${i}.png`, "image/png", 1568, 1568, 9_000_000));
		const result = await fitPromptImages(sources, codec, 3000);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("3 images are too large to send together");
	});

	it("decodes one file at a time, smallest first, at the edge limit, closing each", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 1 });
		const sources = [
			source("big.jpg", "image/jpeg", 8000, 6000, 20_000_000),
			source("small.png", "image/png", 200, 100, 5000),
			source("mid.jpg", "image/jpeg", 4000, 3000, 6_000_000),
		];
		const result = await fitPromptImages(sources, codec);
		expect(result.ok).toBe(true);
		expect(codec.decodes).toEqual([
			{ name: "small.png", maxEdge: MAX_IMAGE_EDGE_PX },
			{ name: "mid.jpg", maxEdge: MAX_IMAGE_EDGE_PX },
			{ name: "big.jpg", maxEdge: MAX_IMAGE_EDGE_PX },
		]);
		expect(codec.peakOpen).toBe(1);
		expect(codec.open.size).toBe(0);
	});

	it("closes the decoded image when it cannot fit", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 4, jpegBytesPerPx: 4 });
		await fitPromptImages([source("huge.png", "image/png", 1568, 1568, 9_000_000)], codec, 1000);
		expect(codec.open.size).toBe(0);
	});

	it("names a file that cannot be decoded and stops there", async () => {
		const codec = fakeCodec({ pngBytesPerPx: 0.01, jpegBytesPerPx: 1 });
		const sources = [
			source("ok.png", "image/png", 100, 100, 100),
			source("art.svg", "image/svg+xml", 0, 0, 200, false),
			source("later.png", "image/png", 100, 100, 300),
		];
		const result = await fitPromptImages(sources, codec);
		expect(result).toEqual({ ok: false, message: "art.svg could not be read as an image" });
		expect(codec.decodes.map(d => d.name)).toEqual(["ok.png", "art.svg"]);
		expect(codec.open.size).toBe(0);
	});
});

describe("sealedPromptFrameBytes", () => {
	it("matches the envelope the socket actually puts on the wire", async () => {
		const key = await importRoomKey(new Uint8Array(32));
		const images: ImageContent[] = [{ type: "image", data: "a".repeat(5000), mimeType: "image/png" }];
		const frame = { t: "prompt" as const, text: "what is this? ünïcode", images };
		const wire = packEnvelope(0, await seal(key, frame));
		expect(sealedPromptFrameBytes(frame.text, images)).toBe(wire.byteLength);
	});

	it("omits the images key for text-only prompts", async () => {
		const key = await importRoomKey(new Uint8Array(32));
		const wire = packEnvelope(0, await seal(key, { t: "prompt", text: "hi" }));
		expect(sealedPromptFrameBytes("hi", [])).toBe(wire.byteLength);
	});
});

describe("decidePromptSend", () => {
	type Session = Pick<GuestSnapshot, "phase" | "readOnly">;
	const LIVE: Session = { phase: "live", readOnly: false };
	const budgetImages: ImageContent[] = [
		{ type: "image", data: "a".repeat(PROMPT_IMAGE_BUDGET_BYTES / 2), mimeType: "image/jpeg" },
		{ type: "image", data: "b".repeat(PROMPT_IMAGE_BUDGET_BYTES / 2), mimeType: "image/jpeg" },
	];
	/** ASCII characters that bring a prompt carrying `budgetImages` exactly to the limit. */
	const textRoom = PROMPT_FRAME_LIMIT_BYTES - sealedPromptFrameBytes("", budgetImages);

	function preparing(result: PrepareResult) {
		const seen: string[][] = [];
		const prepare = async (files: readonly string[]) => {
			seen.push([...files]);
			return result;
		};
		return { prepare, seen };
	}

	it("sends the prepared images when the frame fits and the session is still writable", async () => {
		const { prepare, seen } = preparing({ ok: true, images: budgetImages });
		const decision = await decidePromptSend("x".repeat(textRoom), ["a.jpg", "b.jpg"], prepare, () => LIVE);
		expect(decision).toEqual({ ok: true, images: budgetImages });
		expect(seen).toEqual([["a.jpg", "b.jpg"]]);
	});

	it("refuses a frame one byte over the limit, though the relay alone would carry it", async () => {
		const { prepare } = preparing({ ok: true, images: budgetImages });
		const text = "x".repeat(textRoom + 1);
		expect(sealedPromptFrameBytes(text, budgetImages)).toBeLessThanOrEqual(RELAY_FRAME_LIMIT_BYTES);
		const decision = await decidePromptSend(text, ["a.jpg"], prepare, () => LIVE);
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.notice).toContain(`over the ${PROMPT_FRAME_LIMIT_BYTES / 1024} KiB limit`);
	});

	it("counts multi-byte text by its encoded size", async () => {
		const { prepare } = preparing({ ok: true, images: budgetImages });
		// Same character count as a prompt that fits exactly, but CJK encodes to 3 bytes each.
		const cjk = "漢".repeat(Math.ceil(textRoom / 2)) + "x".repeat(Math.floor(textRoom / 2));
		expect(cjk.length).toBe(textRoom);
		const decision = await decidePromptSend(cjk, ["a.jpg"], prepare, () => LIVE);
		expect(decision.ok).toBe(false);
	});

	it("passes on the preparer's refusal", async () => {
		const { prepare } = preparing({ ok: false, message: "art.svg could not be read as an image" });
		expect(await decidePromptSend("hi", ["art.svg"], prepare, () => LIVE)).toEqual({
			ok: false,
			notice: "art.svg could not be read as an image",
		});
	});

	it("reports a preparer that throws", async () => {
		const prepare = async (): Promise<PrepareResult> => {
			throw new Error("canvas lost");
		};
		expect(await decidePromptSend("hi", ["a.png"], prepare, () => LIVE)).toEqual({
			ok: false,
			notice: "could not prepare images: Error: canvas lost",
		});
	});

	it("does not send when the session turned read-only while preparing", async () => {
		let session = LIVE;
		const prepare = async (): Promise<PrepareResult> => {
			session = { phase: "live", readOnly: true };
			return { ok: true, images: budgetImages };
		};
		expect(await decidePromptSend("hi", ["a.png"], prepare, () => session)).toEqual({
			ok: false,
			notice: "session is read-only; prompt not sent",
		});
	});

	it("does not send when the session dropped while preparing", async () => {
		let session = LIVE;
		const prepare = async (): Promise<PrepareResult> => {
			session = { phase: "reconnecting", readOnly: false };
			return { ok: true, images: budgetImages };
		};
		expect(await decidePromptSend("hi", ["a.png"], prepare, () => session)).toEqual({
			ok: false,
			notice: "session disconnected; prompt not sent",
		});
	});
});
