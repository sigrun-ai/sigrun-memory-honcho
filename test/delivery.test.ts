import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	Message,
	MessageInput,
	Peer,
	Session,
} from "@honcho-ai/sdk";

import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";

import { HONCHO_SETTINGS_SCHEMA, type HonchoSettings } from "../src/settings-schema.js";
import { DeliveryEngine } from "../src/delivery.js";
import { HonchoClient, type HonchoSdk } from "../src/honcho.js";
import createHonchoMemory from "../src/index.js";
import { ExtensionStores, type StorePaths } from "../src/stores.js";
import type {
	OutboxEntry,
	OutboxRecord,
	RunSettledEventLike,
} from "../src/types.js";

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

// -- fake SDK (extends the Task-2 seam: recorded calls, in-memory sessions) --

type SdkCall =
	| { kind: "session"; id: string }
	| { kind: "addPeers"; sessionId: string; peers: unknown }
	| { kind: "setConfiguration"; sessionId: string; config: unknown }
	| { kind: "clone"; sessionId: string; messageId: string | undefined }
	| { kind: "addMessages"; sessionId: string; messages: MessageInput[] };

interface FakeHarness {
	sdk: HonchoSdk;
	calls: SdkCall[];
	sessions: Map<string, FakeSession>;
	fresh: (id: string) => FakeSession;
	contextResult: (options: unknown) => unknown;
}

class FakePeer {
	readonly id: string;
	readonly messageCalls: { content: string; metadata: unknown }[] = [];

	constructor(id: string) {
		this.id = id;
	}

	message(content: string, options?: { metadata?: Record<string, unknown> }): MessageInput {
		this.messageCalls.push({ content, metadata: options?.metadata });
		return { peerId: this.id, content, metadata: options?.metadata };
	}
}

class FakeSession {
	readonly id: string;
	#harness: FakeHarness;
	#messageCounter = 0;

	constructor(harness: FakeHarness, id: string) {
		this.#harness = harness;
		this.id = id;
	}

	async addPeers(peers: unknown): Promise<void> {
		this.#harness.calls.push({ kind: "addPeers", sessionId: this.id, peers });
	}

	async setConfiguration(config: unknown): Promise<void> {
		this.#harness.calls.push({
			kind: "setConfiguration",
			sessionId: this.id,
			config,
		});
	}

	async context(options: unknown) {
		return this.#harness.contextResult(options);
	}

	async clone(messageId?: string): Promise<Session> {
		this.#harness.calls.push({
			kind: "clone",
			sessionId: this.id,
			messageId,
		});
		const cloned = this.#harness.fresh(`clone-of-${this.id}`);
		return cloned as unknown as Session;
	}

	async addMessages(messages: MessageInput | MessageInput[]): Promise<Message[]> {
		const list = Array.isArray(messages) ? messages : [messages];
		this.#harness.calls.push({
			kind: "addMessages",
			sessionId: this.id,
			messages: list,
		});
		return list.map((input) => {
			this.#messageCounter += 1;
			return {
				id: `${this.id}-msg-${this.#messageCounter}`,
				content: input.content,
				peerId: input.peerId,
			} as unknown as Message;
		});
	}
}

const fakeSdk = (): FakeHarness => {
	const calls: SdkCall[] = [];
	const sessions = new Map<string, FakeSession>();
	const peers = new Map<string, FakePeer>();
	const harness: FakeHarness = {
		calls,
		sessions,
		contextResult: () => ({
			peerRepresentation: "rep",
			summary: { content: "sum" },
		}),
		fresh(id: string): FakeSession {
			const existing = sessions.get(id);
			if (existing !== undefined) return existing;
			const created = new FakeSession(harness, id);
			sessions.set(id, created);
			return created;
		},
		sdk: {
			async peer(id: string) {
				const existing = peers.get(id);
				if (existing !== undefined) return existing as unknown as Peer;
				const created = new FakePeer(id);
				peers.set(id, created);
				return created as unknown as Peer;
			},
			async session(id: string) {
				calls.push({ kind: "session", id });
				return harness.fresh(id) as unknown as Session;
			},
		},
	};
	return harness;
}

// -- fixture stores ------------------------------------------------------------

interface Root {
	dir: string;
	paths: StorePaths;
	stores: ExtensionStores;
}

const roots: Root[] = [];

async function makeStores(): Promise<Root> {
	const dir = await mkdtemp(join(tmpdir(), "memory-honcho-delivery-test-"));
	const paths: StorePaths = {
		data: join(dir, "data"),
		state: join(dir, "state"),
		cache: join(dir, "cache"),
	};
	const root: Root = {
		dir,
		paths,
		stores: new ExtensionStores(paths, SETTINGS),
	};
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((r) => rm(r.dir, { recursive: true, force: true })),
	);
});

// -- records -------------------------------------------------------------------

function entry(
	peer: "user" | "agent",
	text: string,
	batchId: string,
	overrides: Partial<OutboxEntry["metadata"]> = {},
): OutboxEntry {
	return {
		peer,
		text,
		metadata: {
			conversationId: 7,
			submissionIds: [1],
			batchId,
			...overrides,
		},
	};
}

function record(batchId: string, overrides: Partial<OutboxRecord> = {}): OutboxRecord {
	return {
		type: "capture",
		conversationId: 7,
		owner: "alice",
		entries: [entry("user", "hello", batchId)],
		batchId,
		status: "pending",
		createdAt: 1_000,
		...overrides,
	};
}

function makeEngine(harness: FakeHarness, stores: ExtensionStores, hooks?: ConstructorParameters<typeof DeliveryEngine>[3]) {
	const client = new HonchoClient(SETTINGS, "synthetic-key", () => harness.sdk);
	return new DeliveryEngine(client, stores, SETTINGS, hooks);
}

// -- establish -------------------------------------------------------------------

describe("establish", () => {
	it("unknown conversation: get-or-create sigrun-<id>, tuple-form addPeers, summary+dream config", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);

		await engine.establish(7, "alice");

		expect(
			harness.calls.filter((c) => c.kind === "session").map((c) => c.id),
		).toEqual(["sigrun-7"]);
		const addPeers = harness.calls.find((c) => c.kind === "addPeers");
		// The SDK's zod union rejects the documented map form; the tuple
		// form is the shape that reaches the wire (verified live 2026-10-31).
		expect(addPeers).toMatchObject({
			kind: "addPeers",
			sessionId: "sigrun-7",
			peers: [
				["alice", { observeMe: true, observeOthers: true }],
				["test-agent", { observeMe: true, observeOthers: true }],
			],
		});
		expect(
			harness.calls.find(
				(c) => c.kind === "setConfiguration" && c.sessionId === "sigrun-7",
			),
		).toMatchObject({
			config: { summary: { enabled: true }, dream: { enabled: true } },
		});
		const ledger = await stores.readLedger(7);
		expect(ledger?.honchoSessionId).toBe("sigrun-7");
		expect(ledger?.ownerAtFirstCapture).toBe("alice");
	});

	it("pending fork with a parent anchor: clone(<anchor>), config on the clone, ledger stamped, record resolved", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [{ entryId: 5, messageId: "m5" }],
		});
		await stores.writePendingFork({ childId: 9, parentId: 7, at: 5, createdAt: 1_000 });
		const engine = makeEngine(harness, stores);

		await engine.establish(9, "alice");

		const cloneCalls = harness.calls.filter((c) => c.kind === "clone");
		expect(cloneCalls).toEqual([
			{ kind: "clone", sessionId: "sigrun-7", messageId: "m5" },
		]);
		// setConfiguration on the clone too — the clone is server-assigned, never "sigrun-7".
		const clonedConfig = harness.calls.find(
			(c) => c.kind === "setConfiguration" && c.sessionId !== "sigrun-7",
		);
		expect(clonedConfig).toMatchObject({
			config: { summary: { enabled: true }, dream: { enabled: true } },
		});
		const ledger = await stores.readLedger(9);
		expect(ledger?.clonedFrom).toBe(7);
		expect(ledger?.honchoSessionId).toBe("clone-of-sigrun-7");
		// A clone never re-runs addPeers on the child.
		expect(harness.calls.some((c) => c.kind === "addPeers")).toBe(false);
		const resolved = await stores.readPendingFork(9);
		expect(resolved?.resolvedAt).toEqual(expect.any(Number));
	});

	it("fork after the newest anchor (at=10): clone at the newest anchor, NEVER a no-arg clone()", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [{ entryId: 9, messageId: "m9" }],
		});
		await stores.writePendingFork({ childId: 11, parentId: 7, at: 10, createdAt: 1_000 });
		const engine = makeEngine(harness, stores);

		await engine.establish(11, "alice");

		expect(harness.calls.filter((c) => c.kind === "clone")).toEqual([
			{ kind: "clone", sessionId: "sigrun-7", messageId: "m9" },
		]);
		// No whole-session clone anywhere.
		expect(
			harness.calls.some((c) => c.kind === "clone" && c.messageId === undefined),
		).toBe(false);
	});

	it("fork before the oldest anchor: fresh session stamped inherit none-window", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [{ entryId: 5, messageId: "m5" }],
		});
		await stores.writePendingFork({ childId: 13, parentId: 7, at: 1, createdAt: 1_000 });
		const engine = makeEngine(harness, stores);

		await engine.establish(13, "alice");

		expect(harness.calls.some((c) => c.kind === "clone")).toBe(false);
		const ledger = await stores.readLedger(13);
		expect(ledger?.honchoSessionId).toBe("sigrun-13");
		expect(ledger?.inherit).toBe("none-window");
		const resolved = await stores.readPendingFork(13);
		expect(resolved?.resolvedAt).toEqual(expect.any(Number));
	});

	it("fork with an empty parent anchor list: fresh session stamped inherit none-empty", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [],
		});
		await stores.writePendingFork({ childId: 15, parentId: 7, at: 5, createdAt: 1_000 });
		const engine = makeEngine(harness, stores);

		await engine.establish(15, "alice");

		expect(harness.calls.some((c) => c.kind === "clone")).toBe(false);
		const ledger = await stores.readLedger(15);
		expect(ledger?.honchoSessionId).toBe("sigrun-15");
		expect(ledger?.inherit).toBe("none-empty");
	});

	it("no pending-fork record: plain get-or-create even when a same-id ledger pattern could suggest a parent", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);

		await engine.establish(17, "alice");

		expect(harness.calls.some((c) => c.kind === "clone")).toBe(false);
		const ledger = await stores.readLedger(17);
		expect(ledger?.honchoSessionId).toBe("sigrun-17");
		expect(ledger?.clonedFrom).toBeUndefined();
	});

	it("already-established conversation: no repeated get-or-create work", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);

		await engine.establish(19, "alice");
		await engine.establish(19, "alice");

		// The second establish performs no addPeers / setConfiguration / clone
		// work again — only re-resolves the session object.
		const work = harness.calls.filter((c) => c.kind !== "session");
		expect(work).toHaveLength(2); // addPeers + setConfiguration, once each
	});
});

// -- deliverPending -----------------------------------------------------------

describe("deliverPending", () => {
	it("delivers a pending batch: peer-resolved messages in order, status flipped, batchId folded, agent anchor keyed by the agent Message.id", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		const batch = record("b1", {
			answerEntryId: 42,
			entries: [
				entry("user", "u1", "b1"),
				entry("agent", "a1", "b1"),
			],
		});
		await stores.withOutbox(() => stores.appendOutboxRecord(batch));

		await engine.deliverPending(7, "alice");

		const add = harness.calls.find((c) => c.kind === "addMessages");
		expect(add).toMatchObject({
			kind: "addMessages",
			sessionId: "sigrun-7",
			messages: [
				{ peerId: "alice", content: "u1" },
				{ peerId: "test-agent", content: "a1" },
			],
		});
		const ledger = await stores.readLedger(7);
		expect(ledger?.deliveredBatchIds).toContain("b1");
		expect(ledger?.anchors).toEqual([
			{ entryId: 42, messageId: "sigrun-7-msg-2" },
		]);
		const outbox = await stores.readOutbox();
		expect(outbox[0]?.status).toBe("delivered");
	});

	it("a delivered flip writes the last-delivery marker (written per flip; the sweeper's delivered-drop cannot erase it)", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		expect(await stores.readLastDelivery()).toBeUndefined();

		await stores.withOutbox(() =>
			stores.appendOutboxRecord(record("b-marker", { createdAt: 3_000 })),
		);
		await engine.deliverPending(7, "alice");

		// The marker carries the delivered record's createdAt (not Date.now()
		// — it answers "when was the newest DELIVERED batch captured", the
		// same value the status route derives from retained records).
		expect(await stores.readLastDelivery()).toEqual({ at: 3_000 });
	});

	it("an unanswered batch folds NO anchor", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		await stores.withOutbox(() =>
			stores.appendOutboxRecord(
				record("b2", {
					entries: [entry("user", "u1", "b2", { unanswered: true })],
				}),
			),
		);

		await engine.deliverPending(7, "alice");

		const ledger = await stores.readLedger(7);
		expect(ledger?.deliveredBatchIds).toContain("b2");
		expect(ledger?.anchors).toEqual([]);
		expect((await stores.readOutbox())[0]?.status).toBe("delivered");
	});

	it("a user-only answered batch folds no anchor", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		await stores.withOutbox(() =>
			stores.appendOutboxRecord(
				record("b3", {
					answerEntryId: 42,
					entries: [entry("user", "u1", "b3")],
				}),
			),
		);

		await engine.deliverPending(7, "alice");

		const ledger = await stores.readLedger(7);
		expect(ledger?.deliveredBatchIds).toContain("b3");
		expect(ledger?.anchors).toEqual([]);
	});

	it("an already-delivered batchId is skipped, never re-sent", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(record("b4"));
			// A re-queued copy of the SAME batchId (the retry lane re-append).
			await stores.appendOutboxRecord(record("b4", { createdAt: 2_000 }));
		});

		await engine.deliverPending(7, "alice");

		expect(harness.calls.filter((c) => c.kind === "addMessages")).toHaveLength(1);
		expect((await stores.readOutbox()).every((r) => r.status === "delivered")).toBe(
			true,
		);
	});

	it("crash window: addMessages succeeds but the ledger write is skipped — the next pass re-sends (accepted duplicate)", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		await stores.withOutbox(() => stores.appendOutboxRecord(record("b5")));

		// First pass: the send lands, the ledger write is skipped (the accepted
		// crash window — a restart between send and ledger write looks like this).
		// failAfterSend is construct-time here: establish must NOT carry it or
		// it would skip the establish ledger write too.
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		const crashing = new DeliveryEngine(
			new HonchoClient(SETTINGS, "synthetic-key", () => harness.sdk),
			stores,
			SETTINGS,
			{ failAfterSend: true },
		);
		// The crashing engine's client never establishes, so re-establish it.
		await crashing.establish(7, "alice");
		await crashing.deliverPending(7, "alice");
		expect((await stores.readLedger(7))?.deliveredBatchIds ?? []).not.toContain(
			"b5",
		);
		expect((await stores.readOutbox())[0]?.status).toBe("pending");

		// Second pass: the batch is re-sent (the documented duplicate). A
		// restart lands here — a fresh engine and client, same stores.
		const client2 = new HonchoClient(SETTINGS, "synthetic-key", () => harness.sdk);
		const engine2 = new DeliveryEngine(client2, stores, SETTINGS);
		await engine2.establish(7, "alice");
		await engine2.deliverPending(7, "alice");
		const sends = harness.calls.filter((c) => c.kind === "addMessages");
		expect(sends).toHaveLength(2);
		expect((await stores.readLedger(7))?.deliveredBatchIds).toContain("b5");
	});

	it("rebuilt client (ledger survives, in-memory mark lost): deliverPending re-establishes and delivers — no hang, no throw", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		// The FIRST engine establishes and delivers (as the pre-restart process did).
		const engine1 = makeEngine(harness, stores);
		await engine1.establish(7, "alice");
		await stores.withOutbox(() => stores.appendOutboxRecord(record("b-restart")));
		await engine1.deliverPending(7, "alice");
		expect((await stores.readLedger(7))?.deliveredBatchIds).toContain("b-restart");

		// The rebuilt client: SAME stores (ledger survives), NO in-memory mark
		// — the Task-5 review hazard, and the sweeper's normal path on a fresh
		// process. deliverPending with NO prior establish must re-establish
		// from the ledger and deliver (an establish-inside-the-chain would
		// deadlock here and vitest's default timeout would fail the test).
		const engine2 = new DeliveryEngine(
			new HonchoClient(SETTINGS, "synthetic-key", () => harness.sdk),
			stores,
			SETTINGS,
		);
		await stores.withOutbox(() => stores.appendOutboxRecord(record("b-after")));
		await engine2.deliverPending(7, "alice");

		const sends = harness.calls.filter((c) => c.kind === "addMessages");
		expect(sends).toHaveLength(2);
		// Re-establishment resolved the ledger's session id — no get-or-create.
		expect(harness.calls.filter((c) => c.kind === "session")).toEqual([
			{ kind: "session", id: "sigrun-7" },
			{ kind: "session", id: "sigrun-7" },
		]);
		const ledger = await stores.readLedger(7);
		expect(ledger?.deliveredBatchIds).toContain("b-after");
		expect((await stores.readOutbox()).every((r) => r.status === "delivered")).toBe(true);
	});

	it("hooks.onDelivered fires when a flip happened, not otherwise", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const delivered: number[] = [];
		const engine = makeEngine(harness, stores, {
			onDelivered: (conversationId: number) => {
				delivered.push(conversationId);
			},
		});
		await engine.establish(7, "alice");

		// Nothing pending: no flip, no hook.
		await engine.deliverPending(7, "alice");
		expect(delivered).toEqual([]);

		await stores.withOutbox(() => stores.appendOutboxRecord(record("b6")));
		await engine.deliverPending(7, "alice");
		expect(delivered).toEqual([7]);

		// Second pass over an already-delivered batch: no flip, no second hook.
		await engine.deliverPending(7, "alice");
		expect(delivered).toEqual([7]);
	});

	it("real composition: first delivery with a chain-entering hook never deadlocks the conversation chain", async () => {
		// The regression guard for the leading-edge deadlock: the factory's
		// onDelivered calls refreshRepresentation, which re-enters
		// chain("conversation:<id>") on the same label. Called INSIDE
		// deliverPending's chain callback, that is a circular wait; the hook
		// must run OUT of the chain and queue behind the settled tail.
		// Real engine + the real factory hook (via makeLeadingEdgeHook) +
		// fake SDK + the REAL refresh (only `context` stubbed on the fake
		// session).
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => harness.sdk);
		const { makeLeadingEdgeHook } = await import("../src/index.js");
		const engine = new DeliveryEngine(client, stores, SETTINGS,
			makeLeadingEdgeHook({
				stores: async () => stores,
				client,
				settings: SETTINGS,
			}),
		);

		await engine.establish(7, "alice");
		await stores.withOutbox(() => stores.appendOutboxRecord(record("b-first")));

		// The deadlock signature: this never resolves. The bounded race turns
		// a hang into a fast test failure rather than a suite stall.
		await Promise.race([
			engine.deliverPending(7, "alice"),
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("deliverPending deadlocked")), 5_000);
			}),
		]);

		// The leading-edge refresh landed afterward: the cache file carries
		// the SDK-field mapping (peerRepresentation → userProfile).
		expect(stores.readRepresentationSync(7)).toEqual({
			userProfile: "rep",
			projectSummary: "sum",
			fetchedAt: expect.any(Number),
		});
	});

	it("leading edge: absent cache at delivery triggers one refresh", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		let refreshes = 0;
		const engine = makeEngine(harness, stores, {
			onDelivered: async (conversationId: number) => {
				if (stores.readRepresentationSync(conversationId) === undefined) {
					refreshes += 1;
				}
			},
		});
		await engine.establish(7, "alice");
		await stores.withOutbox(() => stores.appendOutboxRecord(record("b-leading")));
		await engine.deliverPending(7, "alice");
		expect(refreshes).toBe(1);
	});

	it("leading edge: a present cache skips the refresh", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		let refreshes = 0;
		const engine = makeEngine(harness, stores, {
			onDelivered: async (conversationId: number) => {
				if (stores.readRepresentationSync(conversationId) === undefined) {
					refreshes += 1;
				}
			},
		});
		await engine.establish(7, "alice");
		await stores.writeRepresentation(7, {
			userProfile: "profile",
			projectSummary: null,
			fetchedAt: 1_000,
		});
		await stores.withOutbox(() => stores.appendOutboxRecord(record("b-cached")));
		await engine.deliverPending(7, "alice");
		expect(refreshes).toBe(0);
	});

	it("delivers batches in file order, one addMessages call per batch", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(record("b1", { createdAt: 1 }));
			await stores.appendOutboxRecord(record("b2", { createdAt: 2 }));
		});

		await engine.deliverPending(7, "alice");

		const sends = harness.calls.filter((c) => c.kind === "addMessages");
		expect(sends.map((s) => s.messages[0]?.metadata?.batchId)).toEqual(["b1", "b2"]);
		const ledger = await stores.readLedger(7);
		expect(ledger?.deliveredBatchIds).toEqual(["b1", "b2"]);
	});

	it("records for other conversations are left pending", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		await engine.establish(7, "alice");
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(record("b-mine", { conversationId: 7 }));
			await stores.appendOutboxRecord(
				record("b-other", { conversationId: 99, owner: "bob" }),
			);
		});

		await engine.deliverPending(7, "alice");

		const outbox = await stores.readOutbox();
		expect(outbox.find((r) => r.batchId === "b-mine")?.status).toBe("delivered");
		expect(outbox.find((r) => r.batchId === "b-other")?.status).toBe("pending");
	});
});

// -- kick ---------------------------------------------------------------------

describe("kick", () => {
	it("establishes lazily inside the fire-and-forget attempt, and logs on failure instead of rejecting", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => harness.sdk);
		const engine = new DeliveryEngine(client, stores, SETTINGS);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// The SDK itself is down: the kick's lazy establishment rejects;
			// kick swallows + logs (never rejects into the caller).
			harness.sdk.session = async () => {
				throw new Error("honcho down");
			};
			engine.kick(404, "alice");
			await client.drainAll(5_000);
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(
				errorSpy.mock.calls.some((args) =>
					args.some(
						(arg) => typeof arg === "string" && arg.includes("memory-honcho"),
					),
				),
			).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

// -- end-to-end fork flow (Task 6: real Task-5 factory handlers + fake SDK) ----

describe("end-to-end fork flow (real factory handlers)", () => {
	function settledEvent(
		conversationId: number,
		inputs: number[],
		inputTexts: string[],
		answerEntryId: number,
		answerText: string,
	): RunSettledEventLike {
		return {
			conversationId,
			owner: "alice",
			inputs,
			inputTexts,
			outcome: {
				status: "answered",
				answerEntryId,
				answer: { content: [{ type: "text", text: answerText }] },
			},
		};
	}

	// Selection gate: no AgentDoc → capture proceeds.
	const EVENT_API = {
		entry: async () => undefined,
		entries: async () => ({ items: [], next: undefined }),
		document: async () => undefined,
	};
	const CONTEXT = { abortSignal: undefined };

	interface E2E {
		harness: FakeHarness;
		stores: ExtensionStores;
		result: ReturnType<typeof createHonchoMemory>;
		client: HonchoClient;
		/** Barrier after runSettled: drains every chain, so the fire-and-forget
		 *  kick's own establish+deliver half has provably completed. */
		flush: () => Promise<void>;
	}

	async function makeE2E(): Promise<E2E> {
		const harness = fakeSdk();
		const { paths, stores } = await makeStores();
		const engineRef: { current?: DeliveryEngine } = {};
		const host = {
			settings: {
				declare: () => ({
					get: async () => checkStoredSettings(HONCHO_SETTINGS_SCHEMA, {}).value,
				}),
			},
			stores: {
				secrets: { get: async () => "sk-test" },
				settings: { get: async () => ({}) },
				paths,
			},
		};
		const client = new HonchoClient(SETTINGS, "sk-test", () => harness.sdk);
		const result = createHonchoMemory(host as never, {
			// The default factory would construct the REAL network client —
			// tests own their literals: inject the fake-SDK client.
			createClient: () => client,
			createEngine: (engineClient, engineStores, settings) => {
				const engine = new DeliveryEngine(engineClient, engineStores, settings);
				engineRef.current = engine;
				return engine;
			},
		});
		return {
			harness,
			stores,
			result,
			client,
			flush: async () => {
				if (engineRef.current === undefined) {
					throw new Error("engine not constructed");
				}
				// Barrier twice: the first drain can settle the kick's establish
				// half before its delivery half has been QUEUED (a drain sees only
				// tails live at call time); the second drain sees them all.
				await client.drainAll(5_000);
				await client.drainAll(5_000);
			},
		};
	}

	it("full flow: parent capture → fork → child runSettled clones at the parent's anchor and delivers into the CLONED session", async () => {
		const { harness, stores, result, flush } = await makeE2E();

		// Parent captures + delivers: the anchor folds {43 → sigrun-7-msg-2}.
		await result.runSettled?.(
			settledEvent(7, [42], ["parent question"], 43, "parent answer") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();
		expect((await stores.readLedger(7))?.anchors).toEqual([
			{ entryId: 43, messageId: "sigrun-7-msg-2" },
		]);

		// The fork handler writes the pending record — zero network, no clone yet.
		await result.conversationForked?.(
			{ childId: 9, parentId: 7, at: 43 } as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		expect(harness.calls.some((c) => c.kind === "clone")).toBe(false);

		// The child's first settled run lazily establishes (the clone) and delivers.
		await result.runSettled?.(
			settledEvent(9, [50], ["child question"], 51, "child answer") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();

		// The child session is the parent's clone at the fork anchor.
		expect(harness.calls.filter((c) => c.kind === "clone")).toEqual([
			{ kind: "clone", sessionId: "sigrun-7", messageId: "sigrun-7-msg-2" },
		]);
		const childLedger = await stores.readLedger(9);
		expect(childLedger?.honchoSessionId).toBe("clone-of-sigrun-7");
		expect(childLedger?.clonedFrom).toBe(7);
		expect(childLedger?.anchors).toEqual([
			{ entryId: 51, messageId: "clone-of-sigrun-7-msg-2" },
		]);
		expect((await stores.readPendingFork(9))?.resolvedAt).toEqual(
			expect.any(Number),
		);

		// The child capture landed in the CLONED session — never a fresh sigrun-9.
		expect(
			harness.calls.find(
				(c) => c.kind === "addMessages" && c.sessionId === "clone-of-sigrun-7",
			),
		).toMatchObject({
			messages: [{ content: "child question" }, { content: "child answer" }],
		});
		expect(
			harness.calls.some((c) => c.kind === "session" && c.id === "sigrun-9"),
		).toBe(false);
	});

	it("no pending-fork record → fresh session: child establishes fresh sigrun-<childId>, no inherit stamp, parent ledger untouched", async () => {
		const { harness, stores, result, flush } = await makeE2E();
		await result.runSettled?.(
			settledEvent(7, [42], ["parent question"], 43, "parent answer") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();
		const parentBefore = await stores.readLedger(7);

		// The child settles with NO fork record (the fork predates the extension).
		await result.runSettled?.(
			settledEvent(9, [50], ["child question"], 51, "child answer") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();

		expect(harness.calls.some((c) => c.kind === "clone")).toBe(false);
		const childLedger = await stores.readLedger(9);
		expect(childLedger?.honchoSessionId).toBe("sigrun-9");
		expect(childLedger?.clonedFrom).toBeUndefined();
		expect(childLedger?.inherit).toBeUndefined();
		// The parent's ledger is byte-identical.
		expect(await stores.readLedger(7)).toEqual(parentBefore);
	});

	it("trailing-input fork: parent anchors [(1,m1),(5,m5)], at=7 → clone(m5) (bounded under-inclusion)", async () => {
		const { harness, stores, result, flush } = await makeE2E();
		await result.runSettled?.(
			settledEvent(7, [1], ["q1"], 1, "a1") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await result.runSettled?.(
			settledEvent(7, [5], ["q2"], 5, "a2") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();
		expect((await stores.readLedger(7))?.anchors).toEqual([
			{ entryId: 1, messageId: "sigrun-7-msg-2" },
			{ entryId: 5, messageId: "sigrun-7-msg-4" },
		]);

		// The fork point sits between the newest anchor and the next answer.
		await result.conversationForked?.(
			{ childId: 9, parentId: 7, at: 7 } as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await result.runSettled?.(
			settledEvent(9, [50], ["child question"], 51, "child answer") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();

		expect(harness.calls.filter((c) => c.kind === "clone")).toEqual([
			{ kind: "clone", sessionId: "sigrun-7", messageId: "sigrun-7-msg-4" },
		]);
		expect((await stores.readLedger(9))?.clonedFrom).toBe(7);
	});

	it("pending fork whose parent never captured: the record is RESOLVED (nothing to inherit), fresh child session, no inherit stamp", async () => {
		const { harness, stores, result, flush } = await makeE2E();

		// The fork handler ran, but the parent never captured (no parent ledger).
		await result.conversationForked?.(
			{ childId: 9, parentId: 71, at: 12 } as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await result.runSettled?.(
			settledEvent(9, [50], ["child question"], 51, "child answer") as never,
			EVENT_API as never,
			CONTEXT as never,
		);
		await flush();

		expect(harness.calls.some((c) => c.kind === "clone")).toBe(false);
		const childLedger = await stores.readLedger(9);
		expect(childLedger?.honchoSessionId).toBe("sigrun-9");
		expect(childLedger?.clonedFrom).toBeUndefined();
		expect(childLedger?.inherit).toBeUndefined();
		// Resolved, not left to trip the sweeper's fork-first pass every sweep.
		expect((await stores.readPendingFork(9))?.resolvedAt).toEqual(
			expect.any(Number),
		);
	});
});
