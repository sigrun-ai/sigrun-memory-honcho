import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SigrunHost } from "@sigrun/sigrun/extension";

import {
	resolveApiKey,
	resolveSettings,
	type HonchoSettings,
} from "../src/config.js";
import createHonchoMemory from "../src/index.js";
import {
	buildStatus,
	createStatusHandler,
	type StatusDeps,
} from "../src/status.js";
import { ExtensionStores } from "../src/stores.js";
import type { Ledger, OutboxRecord, PendingForkRecord } from "../src/types.js";

const API_KEY_ENV = "SIGRUN_EXT_MEMORY_HONCHO_API_KEY";
const WORKER_NAME = "honcho-representations";

const SETTINGS = {
	anchorWindow: 200,
	deliveredBatchWindow: 200,
} as HonchoSettings;

// -- fixture helpers ----------------------------------------------------------

interface Root {
	dir: string;
	data: string;
	state: string;
	cache: string;
	stores: ExtensionStores;
}

const roots: Root[] = [];

async function makeStores(): Promise<Root> {
	const dir = await mkdtemp(join(tmpdir(), "memory-honcho-status-"));
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
	vi.unstubAllEnvs();
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

function fork(childId: number, overrides: Partial<PendingForkRecord> = {}): PendingForkRecord {
	return {
		childId,
		parentId: 1,
		at: 42,
		createdAt: 1_000,
		...overrides,
	};
}

/**
 * Deps wired through the REAL config resolvers (fake readers only), so the
 * status route exercises the same settings/key resolution as the handlers.
 */
function makeDeps(
	stores: ExtensionStores,
	options?: {
		readonly settings?: Record<string, unknown>;
		readonly apiKey?: string;
		readonly workerStatus?: StatusDeps["workerStatus"];
	},
): StatusDeps {
	const settings = options?.settings ?? {};
	const apiKey = options?.apiKey;
	return {
		settings: () => resolveSettings({ get: async () => settings }),
		apiKey: () => resolveApiKey({ get: async () => apiKey }),
		stores: async () => stores,
		workerStatus:
			options?.workerStatus ??
			new Map([[WORKER_NAME, { runs: 0 }]]),
		workerName: WORKER_NAME,
	};
}

// -- the status body ----------------------------------------------------------

describe("buildStatus", () => {
	it("reports the full shape with counts from the stores", async () => {
		// A key value that must never leak into the body.
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();

		await stores.writeLedger(7, ledger(7, { honchoSessionId: "session-7" }));
		await stores.writeLedger(8, ledger(8));

		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(
				record("b-pending", { status: "pending", createdAt: 1_000 }),
			);
			await stores.appendOutboxRecord(
				record("b-delivered-old", { status: "delivered", createdAt: 1_500 }),
			);
			await stores.appendOutboxRecord(
				record("b-delivered-new", { status: "delivered", createdAt: 2_000 }),
			);
		});

		await stores.writePendingFork(fork(10));
		await stores.writePendingFork(fork(11, { resolvedAt: 2_000 }));

		const deps = makeDeps(stores, {
			settings: {
				workspaceId: "ws-test",
				agentPeerId: "peer-test",
				baseUrl: "https://honcho.test",
			},
			workerStatus: new Map([
				[
					WORKER_NAME,
					{ runs: 2, startedAt: 5_000, endedAt: 6_000, lastError: "boom" },
				],
			]),
		});

		const status = await buildStatus(deps);
		expect(status).toEqual({
			configured: false,
			workspaceId: "ws-test",
			agentPeerId: "peer-test",
			baseUrl: "https://honcho.test",
			// The NEWEST delivered record's createdAt.
			lastDeliveryAt: 2_000,
			pendingOutbox: 1,
			ledgers: 2,
			// Only unresolved forks are pending.
			pendingForks: 1,
			// Ledgers with an established Honcho session.
			sessions: 1,
			worker: { lastRunAt: 6_000, lastError: "boom" },
		});
	});

	it("configured is true when an API key resolves", async () => {
		const { stores } = await makeStores();
		const status = await buildStatus(makeDeps(stores, { apiKey: "sk-present" }));
		expect(status.configured).toBe(true);
	});

	it("configured is false when no API key resolves", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		const status = await buildStatus(makeDeps(stores));
		expect(status.configured).toBe(false);
	});

	it("omits baseUrl when unset", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		const status = await buildStatus(makeDeps(stores));
		expect("baseUrl" in status).toBe(false);
	});

	it("empty stores report zeros, null lastDeliveryAt, and an empty worker", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		const status = await buildStatus(makeDeps(stores));
		expect(status).toEqual({
			configured: false,
			workspaceId: "sigrun",
			agentPeerId: "sigrun",
			lastDeliveryAt: null,
			pendingOutbox: 0,
			ledgers: 0,
			pendingForks: 0,
			sessions: 0,
			worker: {},
		});
	});

	it("the pending-record newest-createdAt discrimination: a pending record NEWER than every delivery never wins lastDeliveryAt", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(
				record("b-delivered", { status: "delivered", createdAt: 1_000 }),
			);
			// The LARGEST createdAt in the file, but PENDING: lastDeliveryAt
			// must be the newest DELIVERED (1_000), not the newest record.
			await stores.appendOutboxRecord(
				record("b-pending", { status: "pending", createdAt: 9_999 }),
			);
		});
		const status = await buildStatus(makeDeps(stores));
		expect(status.lastDeliveryAt).toBe(1_000);
		expect(status.pendingOutbox).toBe(1);
	});

	it("the last-delivery marker survives the sweeper's delivered-record compaction", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		await stores.withOutbox(async () => {
			await stores.appendOutboxRecord(
				record("b-gone", { status: "delivered", createdAt: 4_000 }),
			);
		});
		await stores.writeLastDelivery({ at: 4_000 });
		// The steady state: the sweeper dropped every delivered record.
		await stores.withOutbox(() => stores.rewriteOutbox([]));

		const status = await buildStatus(makeDeps(stores));
		expect(status.lastDeliveryAt).toBe(4_000);
	});

	it("falls back to the retained-records derivation when the marker is absent", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		await stores.withOutbox(() =>
			stores.appendOutboxRecord(
				record("b-old", { status: "delivered", createdAt: 5_000 }),
			),
		);
		const status = await buildStatus(makeDeps(stores));
		expect(status.lastDeliveryAt).toBe(5_000);
	});

	it("a corrupt store file degrades the counts instead of failing the request", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { dir, stores } = await makeStores();
		const { mkdir, writeFile } = await import("node:fs/promises");
		// A corrupt outbox line + a corrupt ledger file: JSON.parse throws.
		await mkdir(join(dir, "data", "outbox"), { recursive: true });
		await writeFile(
			join(dir, "data", "outbox", "capture.jsonl"),
			"{not json\n",
			"utf8",
		);
		await mkdir(join(dir, "state", "ledger"), { recursive: true });
		await writeFile(join(dir, "state", "ledger", "7.json"), "{corrupt", "utf8");

		const status = await buildStatus(makeDeps(stores));
		expect(status).toMatchObject({
			lastDeliveryAt: null,
			pendingOutbox: 0,
			ledgers: 0,
			pendingForks: 0,
			sessions: 0,
		});
	});

	it("worker lastError is capped at 500 characters", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		const status = await buildStatus(
			makeDeps(stores, {
				workerStatus: new Map([
					[WORKER_NAME, { runs: 1, endedAt: 1_000, lastError: "x".repeat(1_000) }],
				]),
			}),
		);
		expect(status.worker.lastError).toBeDefined();
		expect(status.worker.lastError!.length).toBeLessThanOrEqual(500);
	});

	it("worker lastRunAt falls back to startedAt while a run is in flight", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { stores } = await makeStores();
		const status = await buildStatus(
			makeDeps(stores, {
				workerStatus: new Map([[WORKER_NAME, { runs: 1, startedAt: 7_000 }]]),
			}),
		);
		expect(status.worker).toEqual({ lastRunAt: 7_000 });
	});

	it("never carries key material anywhere in the body", async () => {
		const secret = "sk-fake-key-material-0123456789";
		const { stores } = await makeStores();
		const deps = makeDeps(stores, {
			apiKey: secret,
			settings: { workspaceId: "ws-secret", agentPeerId: "peer-secret" },
		});
		expect(JSON.stringify(await buildStatus(deps))).not.toContain(secret);

		const response = await createStatusHandler(deps)(
			new Request("http://test/v1/ext/memory-honcho/status"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = await response.text();
		expect(body).not.toContain(secret);
		expect(JSON.parse(body)).toMatchObject({
			configured: true,
			workspaceId: "ws-secret",
		});
	});
});

// -- the factory wiring -------------------------------------------------------

describe("status route (factory)", () => {
	it("the GET status route serves the built status without key material", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const { dir, data, state, cache } = await makeStores();
		const host = {
			stores: {
				secrets: { get: async () => "sk-wired-key-material" },
				settings: {
					get: async () => ({
						workspaceId: "ws-wired",
						agentPeerId: "peer-wired",
					}),
				},
				paths: { data, state, cache },
			},
		} as unknown as SigrunHost;

		const result = createHonchoMemory(host);
		const route = result.routes?.find(
			(candidate) => candidate.method === "GET" && candidate.path === "status",
		);
		expect(route).toBeDefined();

		const response = await route!.handler(
			new Request("http://test/v1/ext/memory-honcho/status"),
			{ host },
		);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({
			configured: true,
			workspaceId: "ws-wired",
			agentPeerId: "peer-wired",
			lastDeliveryAt: null,
			pendingOutbox: 0,
			ledgers: 0,
			pendingForks: 0,
			sessions: 0,
			worker: {},
		});
		expect(body).not.toContain("sk-wired-key-material");
		expect(dir).not.toBe("");
	});
});
