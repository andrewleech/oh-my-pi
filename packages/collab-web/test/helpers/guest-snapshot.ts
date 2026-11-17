import type { GuestSnapshot } from "../../src/lib/client";

export function createGuestSnapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: null,
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly: false,
		uiRequest: null,
		notices: [],
		loading: null,
		...overrides,
	};
}
