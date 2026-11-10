import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Peer, Session } from "@honcho-ai/sdk";

import type { HonchoSettings } from "../src/settings-schema.js";
import { HonchoClient, type HonchoSdk } from "../src/honcho.js";
import {
	refreshRepresentation,
	renderMemorySection,
} from "../src/representations.js";
import { ExtensionStores, type StorePaths } from "../src/stores.js";
import type { Ledger, RepresentationSnapshot } from "../src/types.js";

const SETTINGS: HonchoSettings = {
	agentPeerId: "test-agent",
	baseUrl: undefined,
	workspaceId: "test-workspace",
	contextTokens: 1200,
	maxMessageLength: 8000,
	searchLimit: 8,
	toolPreviewLength: 500,
	representationTtlMs: 600_000,
	outboxRetentionDays: 30,
	deliveredBatchWindow: 200,
	anchorWindow: 1000,
};

// -- fixtures ----------------------------------------------------------------

interface Root {
	readonly dir: string;
	readonly stores: ExtensionStores;
	readonly cleanup: () => Promise<void>;
}

const roots: Root[] = [];

async function makeStores(): Promise<Root> {
	const dir = await mkdtemp(join(tmpdir(), "memory-honcho-repr-"));
	const paths: StorePaths = {
		data: join(dir, "data"),
		state: join(dir, "state"),
		cache: join(dir, "cache"),
	};
	const root: Root = {
		dir,
		stores: new ExtensionStores(paths, SETTINGS),
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
	roots.push(root);
	return root;
}

afterEach(async () => {
	while (roots.length > 0) await roots.pop()?.cleanup();
});

function ledger(conversationId: number): Ledger {
	return {
		conversationId,
		honchoSessionId: `sigrun-${conversationId}`,
		ownerAtFirstCapture: "alice",
		deliveredBatchIds: [],
		anchors: [],
	};
}

function snapshot(overrides?: Partial<RepresentationSnapshot>): RepresentationSnapshot {
	return {
		userProfile: "Alice likes tea.",
		projectSummary: "The project ships memory.",
		fetchedAt: 1_000_000,
		...overrides,
	};
}

// -- fake SDK (a real HonchoClient over a stubbed HonchoSdk) -----------------

class FakePeer {
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}
}

interface ContextCall {
	readonly sessionId: string;
	readonly options: unknown;
}

class FakeSession {
	readonly id: string;
	readonly contextCalls: ContextCall[] = [];
	contextResult: { peerRepresentation: string | null; summary: { content: string } | null } = {
		peerRepresentation: "rep",
		summary: { content: "sum" },
	};

	constructor(id: string) {
		this.id = id;
	}

	async context(options: unknown) {
		this.contextCalls.push({ sessionId: this.id, options });
		return this.contextResult;
	}
}

interface FakeHarness {
	readonly client: HonchoClient;
	readonly sessions: Map<string, FakeSession>;
}

function fakeClient(): FakeHarness {
	const sessions = new Map<string, FakeSession>();
	const peers = new Map<string, FakePeer>();
	const sdk: HonchoSdk = {
		async peer(id: string) {
			const existing = peers.get(id);
			if (existing !== undefined) return existing as unknown as Peer;
			const created = new FakePeer(id);
			peers.set(id, created);
			return created as unknown as Peer;
		},
		async session(id: string) {
			const existing = sessions.get(id);
			if (existing !== undefined) return existing as unknown as Session;
			const created = new FakeSession(id);
			sessions.set(id, created);
			return created as unknown as Session;
		},
	};
	return {
		client: new HonchoClient(SETTINGS, "synthetic-key", () => sdk),
		sessions,
	};
}

/** Mark the conversation's session established the way Task 4's flow does. */
async function establish(harness: FakeHarness, conversationId: number): Promise<void> {
	await harness.client
		.for(String(conversationId))
		.chain(() =>
			harness.client
				.session(`sigrun-${conversationId}`)
				.then((session) => {
					harness.client.for(String(conversationId)).markEstablished(Promise.resolve(session));
				}),
		);
}

// -- renderMemorySection --------------------------------------------------------

describe("renderMemorySection", () => {
	it("no ledger → undefined", async () => {
		const { stores } = await makeStores();
		expect(renderMemorySection(stores, 7, 2_000_000)).toBeUndefined();
	});

	it("fresh cache with both parts renders the exact body", async () => {
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		await stores.writeRepresentation(
			7,
			snapshot({
				userProfile: "Alice likes tea.",
				projectSummary: "The project ships memory.",
				fetchedAt: 1_000_000,
			}),
		);
		expect(renderMemorySection(stores, 7, 1_000_100)).toBe(
			"[Persistent memory]\nUser profile:\nAlice likes tea.\nProject summary:\nThe project ships memory.",
		);
	});

	it("profile-only renders the user part without the summary", async () => {
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		await stores.writeRepresentation(7, snapshot({ projectSummary: null }));
		expect(renderMemorySection(stores, 7, 1_000_100)).toBe(
			"[Persistent memory]\nUser profile:\nAlice likes tea.",
		);
	});

	it("both-null renders nothing", async () => {
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		await stores.writeRepresentation(
			7,
			snapshot({ userProfile: null, projectSummary: null }),
		);
		expect(renderMemorySection(stores, 7, 1_000_100)).toBeUndefined();
	});

	it("stale beyond TTL still renders the last snapshot (last-good)", async () => {
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		// fetchedAt is far beyond representationTtlMs (600_000) behind `now`.
		await stores.writeRepresentation(7, snapshot({ fetchedAt: 100 }));
		expect(renderMemorySection(stores, 7, 2_000_000)).toBe(
			"[Persistent memory]\nUser profile:\nAlice likes tea.\nProject summary:\nThe project ships memory.",
		);
	});

	it("a ledger with no cache file renders nothing (only absent renders nothing)", async () => {
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		expect(renderMemorySection(stores, 7, 2_000_000)).toBeUndefined();
	});
});

// -- refreshRepresentation ------------------------------------------------------

describe("refreshRepresentation", () => {
	it("fetches inside the chain with exact context options and writes the mapped snapshot", async () => {
		const harness = fakeClient();
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		await establish(harness, 7);

		await refreshRepresentation(harness.client, stores, SETTINGS, 7, "alice");

		const session = harness.sessions.get("sigrun-7");
		expect(session?.contextCalls).toHaveLength(1);
		expect(session?.contextCalls[0]?.options).toEqual({
			summary: true,
			peerPerspective: await harness.client.agentPeer(),
			peerTarget: await harness.client.userPeerFor("alice"),
			tokens: SETTINGS.contextTokens,
		});
		expect(stores.readRepresentationSync(7)).toEqual({
			userProfile: "rep",
			projectSummary: "sum",
			fetchedAt: expect.any(Number),
		});
	});

	it("null-tolerates the SDK fields (peerRepresentation / summary null → null)", async () => {
		const harness = fakeClient();
		const { stores } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		await establish(harness, 7);
		const session = harness.sessions.get("sigrun-7");
		if (session !== undefined) {
			session.contextResult = { peerRepresentation: null, summary: null };
		}

		await refreshRepresentation(harness.client, stores, SETTINGS, 7, "alice");

		const written = stores.readRepresentationSync(7);
		expect(written?.userProfile).toBeNull();
		expect(written?.projectSummary).toBeNull();
	});
});
