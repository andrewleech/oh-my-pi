/**
 * The browser guest's `GuestClient` against a real `CollabHost` and the real side request engine, over the
 * in-memory relay. The client's own codec, socket and frame handling run for real; only the provider is scripted.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { GuestClient, type GuestSnapshot } from "../../../collab-web/src/lib/client";
import { startSideRequestHost, transcript } from "./helpers/side-request-harness";
import { waitFor } from "./helpers/throttled-host";

// Each test runs a real host, sessions and shell commands; a loaded machine must not turn a slow start into a failure.
setDefaultTimeout(30_000);

const clients: GuestClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
});

async function connect(link: string, name: string): Promise<GuestClient> {
	const client = new GuestClient(link, name);
	clients.push(client);
	client.connect();
	await waitFor(() => client.getSnapshot().phase === "live", `${name} never went live`);
	return client;
}

function agentIds(snapshot: GuestSnapshot): string[] {
	return snapshot.agents.map(agent => agent.id);
}

describe("GuestClient side requests against a real host", () => {
	it("starts children for two guests at once, lists them, and routes chat to the child it names", async () => {
		await using h = await startSideRequestHost();
		h.script.parent.push({ content: ["parent answer"] });
		await h.session.prompt("parent question");
		const client = await connect(h.host.link, "writer");
		const colleague = await connect(h.host.link, "colleague");
		expect(client.getSnapshot().sideRequests).toBe(true);
		h.script.side.push({ content: ["answer one"] }, { content: ["answer two"] });

		const [first, second] = await Promise.all([
			client.sendSideRequest("task one"),
			colleague.sendSideRequest("task two"),
		]);

		expect(first.agentId).not.toBe(second.agentId);
		expect(h.childIds().sort()).toEqual([first.agentId, second.agentId].sort());
		await Promise.all([h.live(first.agentId).waitForIdle(), h.live(second.agentId).waitForIdle()]);
		await waitFor(
			() =>
				agentIds(client.getSnapshot()).includes(first.agentId) &&
				agentIds(client.getSnapshot()).includes(second.agentId),
			"the client never listed both children",
		);
		// Each child started from the parent's history plus its own task only.
		for (const [agentId, task] of [
			[first.agentId, "task one"],
			[second.agentId, "task two"],
		] as const) {
			const userTexts = transcript(h.live(agentId).messages).filter(line => line.startsWith("user:"));
			expect(userTexts).toHaveLength(2);
			expect(userTexts[0]).toBe("user: parent question");
			expect(userTexts[1]).toStartWith('user: <system-notice cause="side-request">');
			expect(userTexts[1]).toEndWith(`\n\n${task}`);
		}

		const callsBefore = h.requests.length;
		h.script.side.push({ content: ["follow-up answer"] });
		client.sendAgentCmd("chat", first.agentId, "follow-up for one");
		await waitFor(() => h.requests.length === callsBefore + 1, "the child never saw the follow-up");
		await h.live(first.agentId).waitForIdle();
		expect(transcript(h.live(first.agentId).messages).at(-2)).toBe("user: follow-up for one");
		expect(transcript(h.live(second.agentId).messages).join("\n")).not.toContain("follow-up for one");
		expect(h.parentRequests()).toHaveLength(1);

		// The client reads the child's transcript through the host.
		const rows = await client.fetchTranscript(first.agentId, 0);
		expect(rows).toMatchObject({ kind: "rows" });
		expect(rows?.kind === "rows" ? rows.text : "").toContain("follow-up for one");
	});

	it("rejects on a read-only link and creates no child", async () => {
		await using h = await startSideRequestHost();
		const viewer = await connect(h.host.viewLink, "viewer");

		expect(viewer.getSnapshot().sideRequests).toBe(false);
		await expect(viewer.sendSideRequest("sneaky")).rejects.toThrow("full-control link");
		// A reply to a later frame on the same socket proves the host handled everything sent before it.
		await viewer.fetchTranscript(MAIN_AGENT_ID, 0);
		expect(h.childIds()).toEqual([]);
		expect(h.requests).toHaveLength(0);
	});

	it("rejects with the host's reason and leaves the connection usable when the child cannot start", async () => {
		await using h = await startSideRequestHost({ persisted: false });
		const client = await connect(h.host.link, "writer");

		await expect(client.sendSideRequest("task")).rejects.toThrow("persisted session");

		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().sideRequests).toBe(true);
		expect(h.childIds()).toEqual([]);
		expect(h.requests).toHaveLength(0);
	});
});
