/**
 * Prompt image attachments: fits guest-picked images into one `prompt` frame.
 *
 * A sealed guest frame travels as a single binary WebSocket message
 * (`[4B peer header][12B IV][ciphertext][16B tag]`, ciphertext the same length
 * as the JSON). Relays cap that message: the omp-connected relay sets
 * `maxPayloadLength` to 1 MiB and drops anything larger, and the host's own
 * replication ceiling (`MAX_REPLICATED_PAYLOAD_BYTES` in
 * `coding-agent/src/collab/replication-shrink.ts`) is the same 1 MiB. Images are
 * downscaled to omp's 1568 px longest edge and re-encoded until the base64 total
 * fits {@link PROMPT_IMAGE_BUDGET_BYTES}; the remainder of the frame is left for
 * the prompt text and JSON.
 *
 * Files are decoded one at a time, smallest first, at no more than the fitted
 * size, and released as soon as their encoding is chosen, so a batch of large
 * photos never holds more than one decoded image.
 *
 * The fitting logic is written against {@link ImageCodec} so it runs without a
 * DOM; {@link prepareImageFiles} binds it to the browser canvas codec.
 */

import type { ImageContent } from "@oh-my-pi/pi-wire";
import { ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";
import type { GuestSnapshot } from "./client";

/** Largest WebSocket message the relay forwards. */
export const RELAY_FRAME_LIMIT_BYTES = 1_048_576;

/**
 * Largest sealed `prompt` frame a guest sends with images. The host replicates
 * the prompt as a `custom_message` entry (id, parent, timestamp, attribution
 * around the same text and images) under the same 1 MiB ceiling; the reserve
 * keeps that echo from being shrunk.
 */
export const PROMPT_FRAME_LIMIT_BYTES = RELAY_FRAME_LIMIT_BYTES - 4096;

/** Bytes a sealed frame adds on top of its JSON: peer header, AES-GCM IV and tag. */
export const SEALED_FRAME_OVERHEAD_BYTES = ENVELOPE_HEADER_LENGTH + 12 + 16;

/** Total base64 characters of image data one prompt may carry. */
export const PROMPT_IMAGE_BUDGET_BYTES = 850_000;

/** Longest edge sent to the host; matches omp's own image resize default. */
export const MAX_IMAGE_EDGE_PX = 1568;

/** Source formats the host's providers accept as-is. */
const PASSTHROUGH_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};

/** Scale factors applied to the fitted size, walked until an encoding fits. */
const SCALE_LADDER = [1, 0.75, 0.5, 0.35] as const;
/** JPEG qualities tried at each scale. */
const JPEG_QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4] as const;

export type EncodedMimeType = "image/png" | "image/jpeg";

/** An image file as known before decoding. */
export interface ImageFile {
	readonly name: string;
	readonly mimeType: string;
	/** Size of the original file in bytes. */
	readonly byteLength: number;
}

/** Decoded pixels of one file, held at no more than the size they were decoded for. */
export interface DecodedImage {
	/** Natural width of the source. */
	readonly width: number;
	/** Natural height of the source. */
	readonly height: number;
	/** The image redrawn at `width`×`height`; `mimeType` on the result is what the encoder produced. */
	encode(width: number, height: number, mimeType: EncodedMimeType, quality: number): Promise<ImageContent>;
	/** Releases the decoded pixels. */
	close(): void;
}

export interface ImageCodec<F extends ImageFile> {
	/** The untouched file bytes as base64. */
	original(file: F): Promise<string>;
	/**
	 * Decodes `file`, keeping at most `maxEdge` px on its longest side, or
	 * returns `null` when it cannot be decoded.
	 */
	decode(file: F, maxEdge: number): Promise<DecodedImage | null>;
}

export type PrepareResult = { ok: true; images: ImageContent[] } | { ok: false; message: string };

/** Base64 length of `byteLength` raw bytes (padded). */
export function base64Length(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}

/** Size scaled to fit `maxEdge` on its longest side, preserving aspect ratio; never upscales. */
export function fitWithinEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (longest <= maxEdge) return { width, height };
	const scale = maxEdge / longest;
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Bytes the relay sees for `{ t: "prompt", text, images }` once sealed. */
export function sealedPromptFrameBytes(text: string, images: readonly ImageContent[]): number {
	const frame = images.length > 0 ? { t: "prompt", text, images } : { t: "prompt", text };
	return new TextEncoder().encode(JSON.stringify(frame)).byteLength + SEALED_FRAME_OVERHEAD_BYTES;
}

/**
 * Encodes `file` so its base64 data is at most `cap` characters, or returns
 * `null` when no step of the ladder fits. Order: the original bytes when the
 * format is accepted as-is and already within the edge limit; PNG at the fitted
 * size for non-JPEG sources (keeps screenshots lossless); then JPEG down the
 * quality ladder at each step of the scale ladder.
 */
export async function encodeWithinCap<F extends ImageFile>(
	file: F,
	decoded: DecodedImage,
	cap: number,
	codec: ImageCodec<F>,
): Promise<ImageContent | null> {
	const fitted = fitWithinEdge(decoded.width, decoded.height, MAX_IMAGE_EDGE_PX);
	const unscaled = fitted.width === decoded.width && fitted.height === decoded.height;
	if (unscaled && PASSTHROUGH_TYPES[file.mimeType] && base64Length(file.byteLength) <= cap) {
		return { type: "image", data: await codec.original(file), mimeType: file.mimeType };
	}
	if (file.mimeType !== "image/jpeg") {
		const png = await decoded.encode(fitted.width, fitted.height, "image/png", 1);
		if (png.data.length <= cap) return png;
	}
	for (const scale of SCALE_LADDER) {
		const width = Math.max(1, Math.round(fitted.width * scale));
		const height = Math.max(1, Math.round(fitted.height * scale));
		for (const quality of JPEG_QUALITY_LADDER) {
			const jpeg = await decoded.encode(width, height, "image/jpeg", quality);
			if (jpeg.data.length <= cap) return jpeg;
		}
	}
	return null;
}

/** Notice for a file that cannot be decoded. */
function undecodableMessage(name: string): string {
	return `${name} could not be read as an image`;
}

/**
 * Fits every file into one prompt's image budget. Files are decoded and
 * encoded one at a time, smallest first, each capped at an even share of what
 * is left, so bytes a small image doesn't need roll over to the larger ones.
 * Each decoded image is closed before the next is decoded. Results keep the
 * input order.
 */
export async function fitPromptImages<F extends ImageFile>(
	files: readonly F[],
	codec: ImageCodec<F>,
	budget: number = PROMPT_IMAGE_BUDGET_BYTES,
): Promise<PrepareResult> {
	const order = files.map((_, index) => index).sort((a, b) => files[a].byteLength - files[b].byteLength);
	const images: ImageContent[] = [];
	let remaining = budget;
	for (let i = 0; i < order.length; i++) {
		const file = files[order[i]];
		const cap = Math.floor(remaining / (order.length - i));
		const decoded = await codec.decode(file, MAX_IMAGE_EDGE_PX);
		if (!decoded) return { ok: false, message: undecodableMessage(file.name) };
		let image: ImageContent | null;
		try {
			image = await encodeWithinCap(file, decoded, cap, codec);
		} finally {
			decoded.close();
		}
		if (!image) {
			return {
				ok: false,
				message:
					files.length === 1
						? `${file.name} is too large to send, even downscaled`
						: `${files.length} images are too large to send together; remove some and try again`,
			};
		}
		images[order[i]] = image;
		remaining -= image.data.length;
	}
	return { ok: true, images };
}

export type PromptSendDecision = { ok: true; images: ImageContent[] } | { ok: false; notice: string };

/**
 * Decides whether a prompt with attached images can be sent: prepares the
 * images, measures the sealed frame against {@link PROMPT_FRAME_LIMIT_BYTES},
 * then re-reads the session, which may have ended or turned read-only while
 * the images were encoding. Returns the images to send or the notice to show.
 */
export async function decidePromptSend<F>(
	text: string,
	files: readonly F[],
	prepare: (files: readonly F[]) => Promise<PrepareResult>,
	snapshot: () => Pick<GuestSnapshot, "phase" | "readOnly">,
): Promise<PromptSendDecision> {
	let prepared: PrepareResult;
	try {
		prepared = await prepare(files);
	} catch (error) {
		return { ok: false, notice: `could not prepare images: ${String(error)}` };
	}
	if (!prepared.ok) return { ok: false, notice: prepared.message };
	const frameBytes = sealedPromptFrameBytes(text, prepared.images);
	if (frameBytes > PROMPT_FRAME_LIMIT_BYTES) {
		return {
			ok: false,
			notice: `prompt with images is ${Math.ceil(frameBytes / 1024)} KiB, over the ${PROMPT_FRAME_LIMIT_BYTES / 1024} KiB limit; shorten the text or remove an image`,
		};
	}
	const now = snapshot();
	if (now.readOnly) return { ok: false, notice: "session is read-only; prompt not sent" };
	if (now.phase !== "live") return { ok: false, notice: "session disconnected; prompt not sent" };
	return { ok: true, images: prepared.images };
}

// ═══════════════════════════════════════════════════════════════════════════
// Browser codec
// ═══════════════════════════════════════════════════════════════════════════

interface BrowserFile extends ImageFile {
	readonly file: Blob;
}

function blobToBase64(blob: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => {
		const url = reader.result as string;
		resolve(url.slice(url.indexOf(",") + 1));
	};
	reader.onerror = () => reject(reader.error ?? new Error("could not read image"));
	reader.readAsDataURL(blob);
	return promise;
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createCanvas(width: number, height: number): { canvas: Canvas; ctx: Context2D } {
	const canvas =
		typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d") as Context2D | null;
	if (!ctx) throw new Error("2d canvas unavailable");
	ctx.imageSmoothingQuality = "high";
	return { canvas, ctx };
}

function canvasToBlob(canvas: Canvas, type: string, quality: number): Promise<Blob> {
	if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
	const { promise, resolve, reject } = Promise.withResolvers<Blob>();
	canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("image encode failed"))), type, quality);
	return promise;
}

/** Pixels drawn from `pixels` at the requested size and encoded. */
function drawableImage(width: number, height: number, pixels: ImageBitmap | Canvas, release: () => void): DecodedImage {
	return {
		width,
		height,
		async encode(outWidth, outHeight, mimeType, quality) {
			const { canvas, ctx } = createCanvas(outWidth, outHeight);
			if (mimeType === "image/jpeg") {
				// JPEG has no alpha; flatten transparency onto white rather than black.
				ctx.fillStyle = "#fff";
				ctx.fillRect(0, 0, outWidth, outHeight);
			}
			ctx.drawImage(pixels, 0, 0, outWidth, outHeight);
			const blob = await canvasToBlob(canvas, mimeType, quality);
			return { type: "image", data: await blobToBase64(blob), mimeType: blob.type || mimeType };
		},
		close: release,
	};
}

/**
 * Decodes `file` and, when it is larger than `maxEdge`, draws it once into a
 * fitted canvas and closes the full-size bitmap straight away.
 */
async function decodeFile(file: Blob, maxEdge: number): Promise<DecodedImage | null> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}
	const { width, height } = bitmap;
	const fitted = fitWithinEdge(width, height, maxEdge);
	if (fitted.width === width && fitted.height === height) {
		return drawableImage(width, height, bitmap, () => bitmap.close());
	}
	try {
		const { canvas, ctx } = createCanvas(fitted.width, fitted.height);
		ctx.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
		return drawableImage(width, height, canvas, () => {
			canvas.width = 0;
			canvas.height = 0;
		});
	} finally {
		bitmap.close();
	}
}

/** Whether the browser can decode `file` as an image; the probe bitmap is closed at once. */
export async function canDecodeImage(file: Blob): Promise<boolean> {
	try {
		(await createImageBitmap(file)).close();
		return true;
	} catch {
		return false;
	}
}

const browserCodec: ImageCodec<BrowserFile> = {
	original: source => blobToBase64(source.file),
	decode: (source, maxEdge) => decodeFile(source.file, maxEdge),
};

/** Decodes, downscales and re-encodes `files` so they fit one prompt frame. */
export function prepareImageFiles(files: readonly File[]): Promise<PrepareResult> {
	return fitPromptImages(
		files.map(file => ({ name: file.name || "image", mimeType: file.type, byteLength: file.size, file })),
		browserCodec,
	);
}
