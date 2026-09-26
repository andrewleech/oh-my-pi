import type { ImageContent } from "@oh-my-pi/pi-wire";
import { ImagePlus, SendHorizontal, Square, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { canDecodeImage, decidePromptSend, prepareImageFiles } from "../../lib/prompt-images";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

/** Splits picked, pasted or dropped files into images and a count of everything else. */
export function partitionImageFiles(files: Iterable<File>): { images: File[]; ignored: number } {
	const images: File[] = [];
	let ignored = 0;
	for (const file of files) {
		if (file.type.startsWith("image/")) images.push(file);
		else ignored++;
	}
	return { images, ignored };
}

/** The parts of a paste's `DataTransfer` that decide what it attaches. */
export interface PastedData {
	readonly files: ArrayLike<File> & Iterable<File>;
	readonly items: Iterable<{ readonly kind: string; getAsFile(): File | null }>;
	getData(format: string): string;
}

/** Plain text that is only the address of a copied image, as browsers put next to it. */
const IMAGE_ADDRESS_TEXT = /^(?:https?:|data:|blob:)\S*$/;

/**
 * Files a paste attaches. A paste carrying plain text is a text paste and
 * attaches nothing: Office apps and file managers put a rendered image of the
 * selection next to its text. Text that is a single URL does not count, since
 * a browser's "Copy Image" can carry the image's address as text. Some
 * browsers expose pasted images only through `items`.
 */
export function pastedFiles(data: PastedData): File[] {
	const text = data.getData("text/plain").trim();
	if (text.length > 0 && !IMAGE_ADDRESS_TEXT.test(text)) return [];
	if (data.files.length > 0) return [...data.files];
	const files: File[] = [];
	for (const item of data.items) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file) files.push(file);
	}
	return files;
}

/** Tray notice for files a pick, paste or drop left out, or `null` when every file was attached. */
function attachNoticeText(ignored: number, unreadable: readonly string[]): string | null {
	const parts: string[] = [];
	if (ignored > 0) parts.push(`ignored ${ignored} non-image file${ignored === 1 ? "" : "s"}`);
	if (unreadable.length > 0) {
		parts.push(`${unreadable.join(", ")} could not be read as ${unreadable.length === 1 ? "an image" : "images"}`);
	}
	return parts.length > 0 ? parts.join("; ") : null;
}

interface Attachment {
	id: number;
	file: File;
	/** Object URL backing the thumbnail; revoked when the attachment leaves the composer. */
	url: string;
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
	const [attachNotice, setAttachNotice] = useState<string | null>(null);
	const [preparing, setPreparing] = useState(false);
	/** Batches of added files still being probed for decodability; sending waits for them. */
	const [checking, setChecking] = useState(0);
	const [dragging, setDragging] = useState(false);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const attachmentSeq = useRef(0);
	const liveUrls = useRef(new Set<string>());
	const mounted = useRef(false);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const canAttach = canPrompt && !preparing;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const hasText = text.trim().length > 0;
	const canSend = canPrompt && !preparing && checking === 0 && hasText;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		const urls = liveUrls.current;
		mounted.current = true;
		return () => {
			mounted.current = false;
			for (const url of urls) URL.revokeObjectURL(url);
			urls.clear();
		};
	}, []);

	/**
	 * Attaches the decodable images among `files`. Each image is probed first so
	 * one the browser cannot read is reported now rather than failing the send;
	 * object URLs are created only once the probe is done and the composer is
	 * still mounted.
	 */
	const addFiles = useCallback(async (files: readonly File[]): Promise<void> => {
		const { images, ignored } = partitionImageFiles(files);
		if (images.length === 0) {
			setAttachNotice(attachNoticeText(ignored, []));
			return;
		}
		setChecking(n => n + 1);
		const decodable: File[] = [];
		const unreadable: string[] = [];
		// One at a time: each probe decodes the whole file.
		for (const file of images) {
			if (await canDecodeImage(file)) decodable.push(file);
			else unreadable.push(file.name || "image");
		}
		if (!mounted.current) return;
		setChecking(n => n - 1);
		setAttachNotice(attachNoticeText(ignored, unreadable));
		const added = decodable.map(file => {
			const url = URL.createObjectURL(file);
			liveUrls.current.add(url);
			return { id: ++attachmentSeq.current, file, url };
		});
		setAttachments(prev => [...prev, ...added]);
	}, []);

	const removeAttachment = useCallback((attachment: Attachment): void => {
		URL.revokeObjectURL(attachment.url);
		liveUrls.current.delete(attachment.url);
		setAttachments(prev => prev.filter(a => a.id !== attachment.id));
		setAttachNotice(null);
	}, []);

	const send = useCallback(async (): Promise<void> => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly || preparing || checking > 0) return;
		const sent = attachments;
		let images: ImageContent[] | undefined;
		if (sent.length > 0) {
			setPreparing(true);
			const decision = await decidePromptSend(
				trimmed,
				sent.map(a => a.file),
				prepareImageFiles,
				() => client.getSnapshot(),
			);
			if (!mounted.current) return;
			setPreparing(false);
			if (!decision.ok) {
				setAttachNotice(decision.notice);
				return;
			}
			images = decision.images;
		}
		client.sendPrompt(trimmed, images);
		setText("");
		for (const attachment of sent) {
			URL.revokeObjectURL(attachment.url);
			liveUrls.current.delete(attachment.url);
		}
		setAttachments([]);
		setAttachNotice(null);
	}, [attachments, checking, client, live, preparing, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			void send();
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		if (!canAttach) return;
		const files = pastedFiles(e.clipboardData);
		if (files.length === 0) return;
		e.preventDefault();
		void addFiles(files);
	};

	// A file drag is always claimed, so a drop while attaching is unavailable never
	// falls through to the browser opening the file in place of the session.
	const draggingFiles = (e: DragEvent<HTMLDivElement>): boolean => e.dataTransfer.types.includes("Files");

	const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
		if (!draggingFiles(e)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = canAttach ? "copy" : "none";
		setDragging(canAttach);
	};

	const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
		if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
		setDragging(false);
	};

	const onDrop = (e: DragEvent<HTMLDivElement>): void => {
		setDragging(false);
		if (!draggingFiles(e)) return;
		e.preventDefault();
		if (canAttach) void addFiles([...e.dataTransfer.files]);
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	const trayNotice = preparing ? "preparing images…" : checking > 0 ? "checking images…" : attachNotice;

	return (
		<div
			className={`sh-composer${dragging ? " sh-composer-dropping" : ""}`}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{!readOnly && (attachments.length > 0 || trayNotice) && (
				<div className="sh-attach-tray">
					{attachments.length > 0 && (
						<ul className="sh-attachments" aria-label="attached images">
							{attachments.map(attachment => (
								<li key={attachment.id} className="sh-attachment">
									<img src={attachment.url} alt={attachment.file.name} className="sh-attachment-thumb" />
									<button
										type="button"
										className="sh-attachment-remove"
										onClick={() => removeAttachment(attachment)}
										disabled={preparing}
										title="remove image"
										aria-label={`remove ${attachment.file.name || "image"}`}
									>
										<X size={11} />
									</button>
								</li>
							))}
						</ul>
					)}
					{trayNotice && (
						<div className="sh-attach-notice" role="status">
							{trayNotice}
						</div>
					)}
				</div>
			)}
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "Read-only session — watching only"
							: !live
								? "Waiting for the session…"
								: attachments.length > 0
									? "Add a message to send with the images…"
									: "Prompt the host agent…"
					}
					disabled={!canPrompt}
					readOnly={preparing}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					{!readOnly && (
						<>
							<input
								ref={fileRef}
								type="file"
								accept="image/*"
								multiple
								hidden
								onChange={e => {
									void addFiles([...(e.target.files ?? [])]);
									e.target.value = "";
								}}
							/>
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => fileRef.current?.click()}
								disabled={!canAttach}
								title="attach images"
								aria-label="attach images"
							>
								<ImagePlus size={12} />
							</button>
						</>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => void send()}
						disabled={!canSend}
						title={attachments.length > 0 && !hasText ? "add a message to send the images" : "send (Enter)"}
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
}
