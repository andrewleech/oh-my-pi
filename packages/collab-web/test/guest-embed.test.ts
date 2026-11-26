import { describe, expect, it } from "bun:test";
import type { GuestSnapshot } from "../src/lib/client";
import {
	type CollabGuestEmbed,
	createCollabGuestEmbed,
	createGuestSideRequestSource,
	installCollabGuestEmbed,
} from "../src/lib/guest-embed";

type SnapshotFields = Pick<GuestSnapshot, "phase" | "readOnly" | "sideRequests" | "uiRequest">;

const LIVE: SnapshotFields = { phase: "live", readOnly: false, sideRequests: true, uiRequest: null };

/** Fake client and composer state. `text` models the composer textarea. */
function setup(initial: Partial<SnapshotFields> = {}) {
	const state = {
		snap: { ...LIVE, ...initial } as SnapshotFields,
		text: "",
		sent: [] as string[],
		started: [] as string[],
		pending: [] as PromiseWithResolvers<{ agentId: string }>[],
	};
	const client = {
		getSnapshot: () => state.snap as GuestSnapshot,
		sendSideRequest: (text: string) => {
			state.sent.push(text);
			const d = Promise.withResolvers<{ agentId: string }>();
			state.pending.push(d);
			return d.promise;
		},
	};
	const embed = createCollabGuestEmbed(
		createGuestSideRequestSource(client, {
			read: () => state.text,
			clear: () => {
				state.text = "";
			},
			onStarted: id => state.started.push(id),
		}),
	);
	return { state, embed };
}

describe("window.ompCollabGuest availability", () => {
	it("is available when live, writable, advertised and no question is pending", () => {
		expect(setup().embed.sideRequests).toBe(true);
	});

	it.each([
		["read-only", { readOnly: true }],
		["host without the capability", { sideRequests: false }],
		[
			"a pending host question",
			{ uiRequest: { reqId: 1, kind: "editor", title: "Other" } as GuestSnapshot["uiRequest"] },
		],
		["connecting", { phase: "connecting" }],
		["reconnecting", { phase: "reconnecting" }],
		["ended", { phase: "ended" }],
	] as const)("is unavailable for %s", (_label, override) => {
		const { embed } = setup(override as Partial<SnapshotFields>);
		expect(embed.sideRequests).toBe(false);
	});

	it("tracks snapshot changes without re-creating the embed", () => {
		const { state, embed } = setup();
		expect(embed.sideRequests).toBe(true);
		state.snap = { ...state.snap, phase: "reconnecting" };
		expect(embed.sideRequests).toBe(false);
		state.snap = { ...state.snap, phase: "live" };
		expect(embed.sideRequests).toBe(true);
	});

	it("rejects submit without sending when unavailable", async () => {
		const { state, embed } = setup({ readOnly: true });
		state.text = "hello";
		await expect(embed.submitSideRequest()).rejects.toThrow("not available");
		expect(state.sent).toEqual([]);
		expect(state.text).toBe("hello");
	});
});

describe("window.ompCollabGuest submitSideRequest", () => {
	it("rejects an empty or whitespace-only draft", async () => {
		const { state, embed } = setup();
		await expect(embed.submitSideRequest()).rejects.toThrow("Type a message");
		state.text = "  \n ";
		await expect(embed.submitSideRequest()).rejects.toThrow("Type a message");
		expect(state.sent).toEqual([]);
	});

	it("sends the trimmed draft and clears it after success", async () => {
		const { state, embed } = setup();
		state.text = "  investigate the flaky test \n";
		const result = embed.submitSideRequest();
		expect(state.sent).toEqual(["investigate the flaky test"]);
		expect(state.text).toBe("  investigate the flaky test \n");
		state.pending[0]!.resolve({ agentId: "side-1" });
		expect(await result).toEqual({ agentId: "side-1" });
		expect(state.text).toBe("");
		expect(state.started).toEqual(["side-1"]);
	});

	it("keeps the draft and rejects with the reason on failure", async () => {
		const { state, embed } = setup();
		state.text = "do the thing";
		const result = embed.submitSideRequest();
		state.pending[0]!.reject(new Error("Could not start the side request"));
		await expect(result).rejects.toThrow("Could not start the side request");
		expect(state.text).toBe("do the thing");
		expect(state.started).toEqual([]);
	});

	it("keeps a draft that changed while the request was pending", async () => {
		const { state, embed } = setup();
		state.text = "first";
		const result = embed.submitSideRequest();
		state.text = "first, edited";
		state.pending[0]!.resolve({ agentId: "side-2" });
		await result;
		expect(state.text).toBe("first, edited");
		expect(state.started).toEqual(["side-2"]);
	});

	it("rejects a second call while one is pending and allows a new one after it settles", async () => {
		const { state, embed } = setup();
		state.text = "once";
		const first = embed.submitSideRequest();
		await expect(embed.submitSideRequest()).rejects.toThrow("already being started");
		expect(state.sent).toEqual(["once"]);
		state.pending[0]!.reject(new Error("failed"));
		await expect(first).rejects.toThrow("failed");
		const retry = embed.submitSideRequest();
		expect(state.sent).toEqual(["once", "once"]);
		state.pending[1]!.resolve({ agentId: "side-3" });
		expect((await retry).agentId).toBe("side-3");
	});

	it("rejects when the client throws synchronously", async () => {
		const state = { text: "hello" };
		const embed = createCollabGuestEmbed(
			createGuestSideRequestSource(
				{
					getSnapshot: () => LIVE as GuestSnapshot,
					sendSideRequest: () => {
						throw new Error("Side requests are not available");
					},
				},
				{ read: () => state.text, clear: () => {} },
			),
		);
		await expect(embed.submitSideRequest()).rejects.toThrow("not available");
	});
});

describe("window.ompCollabGuest install", () => {
	it("publishes the embed and removes it on cleanup", () => {
		const target: { ompCollabGuest?: CollabGuestEmbed } = {};
		const { embed } = setup();
		const uninstall = installCollabGuestEmbed(embed, target);
		expect(target.ompCollabGuest).toBe(embed);
		uninstall();
		expect("ompCollabGuest" in target).toBe(false);
	});

	it("does not remove an embed that replaced it", () => {
		const target: { ompCollabGuest?: CollabGuestEmbed } = {};
		const a = setup().embed;
		const b = setup().embed;
		const uninstallA = installCollabGuestEmbed(a, target);
		installCollabGuestEmbed(b, target);
		uninstallA();
		expect(target.ompCollabGuest).toBe(b);
	});
});
