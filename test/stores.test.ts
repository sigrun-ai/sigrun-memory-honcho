import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HonchoSettings } from "../src/settings-schema.js";
import { ExtensionStores } from "../src/stores.js";
import type { Ledger, OutboxRecord, PendingForkRecord } from "../src/types.js";

const SETTINGS = {
	anchorWindow: 200,
	deliveredBatchWindow: 200,
} as HonchoSettings;

interface Root {
	dir: string;
	data: string;
	state: string;
	cache: string;
	stores: ExtensionStores;
}

const roots: Root[] = [];

async function makeStores(): Promise<Root> {
	const dir = await mkdtemp(join(tmpdir(), "memory-honcho-test-"));
	const root: Root = {
		dir,
		data: join(dir, "data"),
		state: join(dir, "state"),
		cache: join(dir, "cache"),
		stores: undefined as unknown as ExtensionStores,
	};
	root.stores = new ExtensionStores(
		{ data: root.data, state: root.state, cache: root.cache },
		SETTINGS,
	);
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((r) => rm(r.dir, { recursive: true, force: true })),
	);
});

function ledger(conversationId: number, overrides: Partial<Ledger> = {}): Ledger {
	return {
		conversationId,
		ownerAtFirstCapture: "alice",
		deliveredBatchIds: [],
		anchors: [],
		...overrides,
	};
}

function record(batchId: string, overrides: Partial<OutboxRecord> = {}): OutboxRecord {
	return {
		type: "capture",
		conversationId: 7,
		owner: "alice",
		entries: [],
		batchId,
		status: "pending",
		createdAt: 1_000,
		...overrides,
	};
}

describe("ledger", () => {
	it("round-trips a ledger", async () => {
		const { stores } = await makeStores();
		const value = ledger(7, {
			honchoSessionId: "sigrun-7",
			deliveredBatchIds: ["b1"],
			anchors: [{ entryId: 42, messageId: "m1" }],
		});
		await stores.writeLedger(7, value);
		expect(await stores.readLedger(7)).toEqual(value);
		expect(stores.readLedgerSync(7)).toEqual(value);
	});

	it("returns undefined for a conversation with no ledger", async () => {
		const { stores } = await makeStores();
		expect(await stores.readLedger(404)).toBeUndefined();
		expect(stores.readLedgerSync(404)).toBeUndefined();
	});

	it("folds anchors oldest-first at the anchorWindow bound", async () => {
		const { stores } = await makeStores();
		const anchors = Array.from({ length: 201 }, (_, i) => ({
			entryId: i,
			messageId: `m${i}`,
		}));
		await stores.writeLedger(7, ledger(7, { anchors }));
		const read = await stores.readLedger(7);
		expect(read?.anchors).toHaveLength(200);
		expect(read?.anchors[0]).toEqual({ entryId: 1, messageId: "m1" });
		expect(read?.anchors[199]).toEqual({ entryId: 200, messageId: "m200" });
	});

	it("folds deliveredBatchIds oldest-first at the deliveredBatchWindow bound", async () => {
		const { stores } = await makeStores();
		const ids = Array.from({ length: 201 }, (_, i) => `b${i}`);
		await stores.writeLedger(7, ledger(7, { deliveredBatchIds: ids }));
		const read = await stores.readLedger(7);
		expect(read?.deliveredBatchIds).toHaveLength(200);
		expect(read?.deliveredBatchIds[0]).toBe("b1");
		expect(read?.deliveredBatchIds[199]).toBe("b200");
	});

	it("writes atomically (no temp files left behind)", async () => {
		const { stores, state } = await makeStores();
		await stores.writeLedger(7, ledger(7));
		expect(await readdir(join(state, "ledger"))).toEqual(["7.json"]);
	});
});

describe("outbox", () => {
	it("reads an empty outbox as an empty list", async () => {
		const { stores } = await makeStores();
		expect(await stores.readOutbox()).toEqual([]);
	});

	it("appends records one JSONL line at a time, in file order", async () => {
		const { stores } = await makeStores();
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(record("b1"));
			await stores.appendOutboxRecord(record("b2"));
		});
		const read = await stores.withOutbox(() => stores.readOutbox());
		expect(read.map((r) => r.batchId)).toEqual(["b1", "b2"]);
	});

	it("rewrite replaces the outbox", async () => {
		const { stores } = await makeStores();
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(record("b1"));
			await stores.appendOutboxRecord(record("b2"));
			await stores.rewriteOutbox([record("b2", { status: "delivered" })]);
		});
		const read = await stores.withOutbox(() => stores.readOutbox());
		expect(read).toEqual([record("b2", { status: "delivered" })]);
	});

	it("withOutbox serializes read-modify-write across conversations", async () => {
		const { stores } = await makeStores();
		const writers = Array.from({ length: 10 }, (_, i) =>
			stores.withOutbox(async () => {
				const current = await stores.readOutbox();
				await stores.rewriteOutbox([...current, record(`b${i}`)]);
			}),
		);
		await Promise.all(writers);
		const read = await stores.withOutbox(() => stores.readOutbox());
		expect(read).toHaveLength(10);
		expect(read.map((r) => r.batchId)).toEqual(
			Array.from({ length: 10 }, (_, i) => `b${i}`),
		);
	});

	it("withOutbox serializes across ExtensionStores instances (module-level mutex)", async () => {
		const root = await makeStores();
		const other = new ExtensionStores(
			{ data: root.data, state: root.state, cache: root.cache },
			SETTINGS,
		);
		const fromA = Array.from({ length: 5 }, (_, i) =>
			root.stores.withOutbox(async () => {
				const current = await root.stores.readOutbox();
				await root.stores.rewriteOutbox([...current, record(`a${i}`)]);
			}),
		);
		const fromB = Array.from({ length: 5 }, (_, i) =>
			other.withOutbox(async () => {
				const current = await other.readOutbox();
				await other.rewriteOutbox([...current, record(`b${i}`)]);
			}),
		);
		await Promise.all([...fromA, ...fromB]);
		expect(
		await root.stores.withOutbox(() => root.stores.readOutbox()),
		).toHaveLength(10);
	});
});

describe("pending forks", () => {
	it("writes, reads, and resolves a pending fork", async () => {
		const { stores } = await makeStores();
		const fork: PendingForkRecord = {
			childId: 9,
			parentId: 7,
			at: 42,
			createdAt: 1_000,
		};
		await stores.writePendingFork(fork);
		expect(await stores.readPendingFork(9)).toEqual(fork);
		const resolved = await stores.resolvePendingFork(9);
		expect(resolved?.resolvedAt).toEqual(expect.any(Number));
		expect(await stores.readPendingFork(9)).toEqual({
			...fork,
			resolvedAt: resolved?.resolvedAt,
		});
	});

	it("returns undefined for an unknown child", async () => {
		const { stores } = await makeStores();
		expect(await stores.readPendingFork(404)).toBeUndefined();
		expect(await stores.resolvePendingFork(404)).toBeUndefined();
	});
});

describe("representations", () => {
	it("round-trips a snapshot; the sync read sees it", async () => {
		const { stores } = await makeStores();
		const snapshot = {
			userProfile: "profile",
			projectSummary: null,
			fetchedAt: 1_000,
		};
		await stores.writeRepresentation(7, snapshot);
		expect(stores.readRepresentationSync(7)).toEqual(snapshot);
	});

	it("returns undefined when no snapshot exists", async () => {
		const { stores } = await makeStores();
		expect(stores.readRepresentationSync(404)).toBeUndefined();
	});
});
