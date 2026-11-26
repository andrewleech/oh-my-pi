/**
 * `window.ompCollabGuest`: the page-level API for hosts that embed or overlay this guest on the same origin.
 * It starts a side request (an independent subagent forked from the session) from the composer draft.
 */
import { useEffect, useMemo } from "react";
import type { GuestClient } from "./client";

export interface CollabGuestEmbed {
	/** True when connected, writable, the host supports side requests and no host question is pending. */
	readonly sideRequests: boolean;
	/** Starts a side request from the composer draft. The draft is cleared only after the host reports success. */
	submitSideRequest(): Promise<{ agentId: string }>;
}

declare global {
	interface Window {
		ompCollabGuest?: CollabGuestEmbed;
	}
}

/** Live view of the guest that the embed API reads. Every member is read at call time. */
export interface SideRequestSource {
	available(): boolean;
	/** Current composer text. */
	draft(): string;
	send(text: string): Promise<{ agentId: string }>;
	/** Clears the composer only when its text still equals `submitted`. */
	clearIfUnchanged(submitted: string): void;
	onStarted?(agentId: string): void;
}

/** Composer draft access for {@link createGuestSideRequestSource}. */
export interface DraftAccess {
	read(): string;
	clear(): void;
	/** Called after a side request started. */
	onStarted?(agentId: string): void;
}

/** Binds {@link SideRequestSource} to a guest client: availability is read from its current snapshot. */
export function createGuestSideRequestSource(
	client: Pick<GuestClient, "getSnapshot" | "sendSideRequest">,
	draft: DraftAccess,
): SideRequestSource {
	return {
		available: () => {
			const snap = client.getSnapshot();
			return snap.phase === "live" && !snap.readOnly && snap.sideRequests && snap.uiRequest === null;
		},
		draft: draft.read,
		send: text => client.sendSideRequest(text),
		clearIfUnchanged: submitted => {
			if (draft.read() === submitted) draft.clear();
		},
		onStarted: agentId => draft.onStarted?.(agentId),
	};
}

export function createCollabGuestEmbed(source: SideRequestSource): CollabGuestEmbed {
	let pending = false;
	return {
		get sideRequests(): boolean {
			return source.available();
		},
		async submitSideRequest(): Promise<{ agentId: string }> {
			if (pending) throw new Error("A side request is already being started");
			if (!source.available()) throw new Error("Side requests are not available in this session");
			const submitted = source.draft();
			const text = submitted.trim();
			if (!text) throw new Error("Type a message before starting a side request");
			pending = true;
			try {
				const result = await source.send(text);
				source.clearIfUnchanged(submitted);
				source.onStarted?.(result.agentId);
				return result;
			} finally {
				pending = false;
			}
		},
	};
}

/** Publishes `embed` on `target`. The returned function removes it unless another embed replaced it. */
export function installCollabGuestEmbed(
	embed: CollabGuestEmbed,
	target: { ompCollabGuest?: CollabGuestEmbed } = window,
): () => void {
	target.ompCollabGuest = embed;
	return () => {
		if (target.ompCollabGuest === embed) delete target.ompCollabGuest;
	};
}

/** Installs the embed API while the calling component is mounted. `source` MUST be referentially stable. */
export function useCollabGuestEmbed(source: SideRequestSource): void {
	const embed = useMemo(() => createCollabGuestEmbed(source), [source]);
	useEffect(() => installCollabGuestEmbed(embed), [embed]);
}
