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

import type { HonchoSettings } from "../src/config.js";
import { DeliveryEngine } from "../src/delivery.js";
import { HonchoClient, type HonchoSdk } from "../src/honcho.js";
import { ExtensionStores } from "../src/stores.js";
import type { Ledger, OutboxEntry, OutboxRecord } from "../src/types.js";

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
	stores: ExtensionStores;
}

const roots: Root[] = [];

async function makeStores(): Promise<Root> {
	const dir = await mkdtemp(join(tmpdir(), "memory-honcho-delivery-test-"));
	const root: Root = {
		dir,
		stores: new ExtensionStores(
			{ data: join(dir, "data"), state: join(dir, "state"), cache: join(dir, "cache") },
			SETTINGS,
		),
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
	it("unknown conversation: get-or-create sigrun-<id>, map-form addPeers, summary+dream config", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);

		await engine.establish(7, "alice");

		expect(
			harness.calls.filter((c) => c.kind === "session").map((c) => c.id),
		).toEqual(["sigrun-7"]);
		const addPeers = harness.calls.find((c) => c.kind === "addPeers");
		expect(addPeers).toMatchObject({
			kind: "addPeers",
			sessionId: "sigrun-7",
			peers: {
				alice: { observeMe: true, observeOthers: true },
				"test-agent": { observeMe: true, observeOthers: true },
			},
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
	it("runs deliverPending fire-and-forget and logs on failure instead of rejecting", async () => {
		const harness = fakeSdk();
		const { stores } = await makeStores();
		const engine = makeEngine(harness, stores);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// Never established: deliverPending rejects; kick swallows + logs.
			engine.kick(404, "alice");
			// Give the fire-and-forget chain a chance to run.
			for (let i = 0; i < 20; i++) await Promise.resolve();
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
