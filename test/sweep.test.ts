import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/chord";
import type { AnyTask } from "@earendil-works/pi-durable";

import type { HonchoSettings } from "../src/config.js";
import type { DeliveryEngine } from "../src/delivery.js";
import { createSweepTask, type SweepTaskDeps } from "../src/sweep.js";
import { ExtensionStores, type StorePaths } from "../src/stores.js";
import type { Ledger, OutboxRecord, PendingForkRecord } from "../src/types.js";

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

const CONTEXT = { abortSignal: undefined } as unknown as Context;

// -- fakes -------------------------------------------------------------------

type EngineCall =
	| { kind: "establish"; conversationId: number; owner: string }
	| { kind: "deliverPending"; conversationId: number; owner: string };

interface Harness {
	readonly task: AnyTask;
	readonly stores: ExtensionStores;
	readonly calls: EngineCall[];
	readonly cleanup: () => Promise<void>;
}

async function makeHarness(options?: {
	readonly settings?: Partial<HonchoSettings>;
	readonly engine?: Partial<DeliveryEngine>;
}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "memory-honcho-sweep-"));
	const paths: StorePaths = {
		data: join(root, "data"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	const settings: HonchoSettings = { ...SETTINGS, ...options?.settings };
	const stores = new ExtensionStores(paths, settings);
	const calls: EngineCall[] = [];
	const overrides = options?.engine ?? {};
	const engine = {
		establish: async (conversationId: number, owner: string) => {
			calls.push({ kind: "establish" as const, conversationId, owner });
			if (overrides.establish !== undefined) {
				await overrides.establish(conversationId, owner);
			}
		},
		deliverPending: async (conversationId: number, owner: string) => {
			calls.push({ kind: "deliverPending" as const, conversationId, owner });
			await overrides.deliverPending?.(conversationId, owner);
		},
	} as unknown as DeliveryEngine;
	const deps: SweepTaskDeps = {
		engine: async () => engine,
		stores: async () => stores,
		settings: async () => settings,
	};
	const task = createSweepTask(deps) as unknown as AnyTask;
	return {
		task,
		stores,
		calls,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

// -- fixtures ----------------------------------------------------------------

let recordCounter = 0;

function pendingRecord(
	conversationId: number,
	overrides?: Partial<OutboxRecord>,
): OutboxRecord {
	recordCounter += 1;
	return {
		type: "capture",
		conversationId,
		owner: "alice",
		entries: [
			{
				peer: "user",
				text: `message ${recordCounter}`,
				metadata: {
					conversationId,
					submissionIds: [recordCounter],
					batchId: `batch-${recordCounter}`,
				},
			},
		],
		batchId: `batch-${recordCounter}`,
		status: "pending",
		// Default "now": only the retention test backdates a record.
		createdAt: Date.now(),
		...overrides,
	};
}

function ledger(conversationId: number, deliveredBatchIds: string[] = []): Ledger {
	return {
		conversationId,
		honchoSessionId: `sigrun-${conversationId}`,
		ownerAtFirstCapture: "alice",
		deliveredBatchIds,
		anchors: [],
	};
}

function fork(childId: number, parentId: number): PendingForkRecord {
	return { childId, parentId, at: 10, createdAt: 1_000_000 };
}

// -- task invocation ---------------------------------------------------------

/**
 * Drive the phase and return the committed terminal state. The contract:
 * a phase returning without durable progress faults the task, so the sweep
 * MUST end in a commit — an empty commit log is the failure this proves
 * against.
 */
async function runSweep(task: AnyTask): Promise<unknown[]> {
	const commits: unknown[] = [];
	const runtime = {
		commit: async (change: () => unknown) => {
			commits.push(await change());
		},
	};
	const definition = task.definition as {
		initial(input: unknown): unknown;
		phases: Record<string, (task: unknown, runtime: unknown, context: unknown) => Promise<void>>;
	};
	const state = definition.initial(undefined);
	await definition.phases.sweep(
		{ state },
		runtime,
		CONTEXT,
	);
	return commits;
}

// -- tests -------------------------------------------------------------------

const roots: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const cleanup = roots.pop();
		if (cleanup !== undefined) await cleanup();
	}
	vi.restoreAllMocks();
});

function tracked(harness: Harness): Harness {
	roots.push(harness.cleanup);
	return harness;
}

describe("createSweepTask", () => {
	it("has the real TaskDefinition shape and the phase commits terminal-completed", async () => {
		const harness = tracked(await makeHarness());
		const definition = harness.task.definition as Record<string, unknown>;
		expect(definition.name).toBe("honcho-outbox-sweep");
		expect(definition.version).toBe(1);
		expect(typeof definition.initial).toBe("function");
		expect(typeof (definition.phases as Record<string, unknown>).sweep).toBe(
			"function",
		);
		expect(typeof definition.abort).toBe("function");
		const initial = definition.initial as (input: unknown) => unknown;
		expect(initial(undefined)).toEqual({ phase: "sweep" });
		expect(definition).not.toHaveProperty("run");

		const commits = await runSweep(harness.task);
		expect(commits).toEqual([
			{ status: "terminal", outcome: { status: "completed", result: undefined } },
		]);
	});

	it("abort commits terminal-failed", async () => {
		const harness = tracked(await makeHarness());
		const commits: unknown[] = [];
		const runtime = {
			commit: async (change: () => unknown) => {
				commits.push(await change());
			},
		};
		const definition = harness.task.definition as {
			abort(task: unknown, runtime: unknown, context: unknown): Promise<void>;
		};
		await definition.abort(
			{ state: { phase: "sweep" } },
			runtime,
			CONTEXT,
		);
		expect(commits).toEqual([
			{
				status: "terminal",
				outcome: { status: "failed", error: { message: "aborted" } },
			},
		]);
	});

	it("delivers two conversations' pending records in file order and compacts delivered only", async () => {
		const harness = tracked(await makeHarness());
		const first = pendingRecord(1);
		const second = pendingRecord(2);
		const third = pendingRecord(1);
		await harness.stores.writeLedger(1, ledger(1));
		await harness.stores.writeLedger(2, ledger(2));
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(first);
			await harness.stores.appendOutboxRecord(second);
			await harness.stores.appendOutboxRecord(third);
		});

		await runSweep(harness.task);

		// File order = the order the conversations FIRST appear, records of the
		// same conversation travel with their conversation's one delivery call.
		// EVERY planned conversation is established first (idempotent; the
		// ledger-less recovery lane needs it), forks ahead of the rest.
		expect(harness.calls).toEqual([
			{ kind: "establish", conversationId: 1, owner: "alice" },
			{ kind: "establish", conversationId: 2, owner: "alice" },
			{ kind: "deliverPending", conversationId: 1, owner: "alice" },
			{ kind: "deliverPending", conversationId: 2, owner: "alice" },
		]);

		// The fake engine sends nothing, so pending records stay pending — and
		// the rewrite keeps them in file order (a sweep never loses them).
		expect(await harness.stores.readOutbox()).toEqual([first, second, third]);
	});

	it("drops delivered records the engine flipped, keeping file order of the rest", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const harness = tracked(await makeHarness({
			engine: {
				deliverPending: async (conversationId: number) => {
					await harness.stores.withOutbox(async () => {
						const records = await harness.stores.readOutbox();
						const currentLedger = await harness.stores.readLedger(conversationId);
						if (currentLedger === undefined) return;
						await harness.stores.writeLedger(conversationId, {
							...currentLedger,
							deliveredBatchIds: [
								...currentLedger.deliveredBatchIds,
								...records
									.filter(
										(r) =>
											r.conversationId === conversationId && r.status === "pending",
									)
									.map((r) => r.batchId),
							],
						});
						await harness.stores.rewriteOutbox(
							records.map((r) =>
								r.conversationId === conversationId && r.status === "pending"
									? { ...r, status: "delivered" as const }
									: r,
							),
						);
					});
				},
			},
		}));
		const one = pendingRecord(1);
		const two = pendingRecord(2);
		const three = pendingRecord(1);
		await harness.stores.writeLedger(1, ledger(1));
		await harness.stores.writeLedger(2, ledger(2));
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(one);
			await harness.stores.appendOutboxRecord(two);
			await harness.stores.appendOutboxRecord(three);
		});

		await runSweep(harness.task);

		expect(harness.calls.map((call) => call.kind)).toEqual([
			"establish",
			"establish",
			"deliverPending",
			"deliverPending",
		]);
		expect(await harness.stores.readOutbox()).toEqual([]);

		// A second sweep after full delivery is a no-op: no engine calls, no
		// writes, still terminal-completed.
		harness.calls.length = 0;
		const commits = await runSweep(harness.task);
		expect(harness.calls).toEqual([]);
		expect(await harness.stores.readOutbox()).toEqual([]);
		expect(commits).toHaveLength(1);
	});

	it("drops over-retention pending records with a warning", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
			const harness = tracked(
				await makeHarness({ settings: { outboxRetentionDays: 30 } }),
			);
			const now = Date.now();
			const cutoff = now - 30 * 86_400_000;
			const old = pendingRecord(1, { createdAt: cutoff - 1 });
			const young = pendingRecord(1, { createdAt: cutoff });
			await harness.stores.writeLedger(1, ledger(1));
			await harness.stores.withOutbox(async () => {
				await harness.stores.appendOutboxRecord(old);
				await harness.stores.appendOutboxRecord(young);
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			await runSweep(harness.task);

			expect(await harness.stores.readOutbox()).toEqual([young]);
			expect(warn).toHaveBeenCalled();
			const message = warn.mock.calls.map((call) => String(call[0])).join("\n");
			expect(message).toContain(old.batchId);
		} finally {
			vi.useRealTimers();
		}
	});

	it("establishes an unresolved pending-fork conversation before its captures deliver", async () => {
		const harness = tracked(await makeHarness());
		await harness.stores.writePendingFork(fork(9, 3));
		await harness.stores.writeLedger(9, ledger(9));
		const capture = pendingRecord(9);
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(capture);
		});

		await runSweep(harness.task);

		expect(harness.calls).toEqual([
			{ kind: "establish", conversationId: 9, owner: "alice" },
			{ kind: "deliverPending", conversationId: 9, owner: "alice" },
		]);
	});

	it("does not revisit an already-resolved pending fork for a second establish pass", async () => {
		const harness = tracked(await makeHarness());
		await harness.stores.writePendingFork({
			...fork(9, 3),
			resolvedAt: 1_000_001,
		});
		await harness.stores.writeLedger(9, ledger(9));
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(pendingRecord(9));
		});

		await runSweep(harness.task);

		// No dedicated fork-establish pass (resolvedAt is stamped); the uniform
		// per-conversation establish covers it exactly once.
		expect(harness.calls).toEqual([
			{ kind: "establish", conversationId: 9, owner: "alice" },
			{ kind: "deliverPending", conversationId: 9, owner: "alice" },
		]);
	});

	it("drops a pending record already in the ledger's delivered window, silently", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const harness = tracked(await makeHarness());
		// Skipped-but-lingering: the batch was sent (ledger flipped) but the
		// record never flipped to delivered (the accepted crash window).
		const lingering = pendingRecord(7);
		await harness.stores.writeLedger(7, ledger(7, [lingering.batchId]));
		const healthy = pendingRecord(8);
		await harness.stores.writeLedger(8, ledger(8));
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(lingering);
			await harness.stores.appendOutboxRecord(healthy);
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await runSweep(harness.task);

		expect(await harness.stores.readOutbox()).toEqual([healthy]);
		// Silent drop: the ledger already counts the batch — housekeeping,
		// not data loss, so NO retention-style warning.
		expect(warn).not.toHaveBeenCalled();
	});

	it("recovers a ledger-less conversation end-to-end (the missing-key capture lane)", async () => {
		const harness = tracked(await makeHarness());
		// No ledger for conversation 5: the capture wrote the outbox record but
		// no key existed, so no session was ever established.
		const record = pendingRecord(5);
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(record);
		});

		await runSweep(harness.task);

		// The sweep establishes (the fake engine records it), delivers, and
		// does NOT fault — compaction still runs (the record stays pending
		// because the fake engine sends nothing, but nothing was dropped and
		// the phase committed terminal).
		expect(harness.calls).toEqual([
			{ kind: "establish", conversationId: 5, owner: "alice" },
			{ kind: "deliverPending", conversationId: 5, owner: "alice" },
		]);
	});

	it("a rejecting conversation never blocks the rest of the sweep or compaction", async () => {
		// Conversation 1's establish rejects; the recorded default covers the
		// rest (the harness composes overrides with its recording wrapper).
		const harness = tracked(
			await makeHarness({
				engine: {
					establish: async (conversationId: number) => {
						if (conversationId === 1) {
							throw new Error("session not established");
						}
					},
				},
			}),
		);
		const poisoned = pendingRecord(1);
		const delivered = pendingRecord(2, { status: "delivered" });
		const healthy = pendingRecord(3);
		await harness.stores.writeLedger(1, ledger(1));
		await harness.stores.writeLedger(2, ledger(2));
		await harness.stores.writeLedger(3, ledger(3));
		await harness.stores.withOutbox(async () => {
			await harness.stores.appendOutboxRecord(poisoned);
			await harness.stores.appendOutboxRecord(delivered);
			await harness.stores.appendOutboxRecord(healthy);
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Must NOT reject: one poisoned conversation cannot fault the task.
		const commits = await runSweep(harness.task);

		// Conversation 1's establish threw; 2 and 3 still establish + deliver,
		// and the sweep neither faults nor skips compaction. (The harness
		// records calls BEFORE the override runs, so the poisoned
		// conversation's deliverPending records but no-ops.)
		expect(harness.calls).toEqual([
			{ kind: "establish", conversationId: 1, owner: "alice" },
			{ kind: "establish", conversationId: 2, owner: "alice" },
			{ kind: "establish", conversationId: 3, owner: "alice" },
			{ kind: "deliverPending", conversationId: 1, owner: "alice" },
			{ kind: "deliverPending", conversationId: 2, owner: "alice" },
			{ kind: "deliverPending", conversationId: 3, owner: "alice" },
		]);
		expect(error).toHaveBeenCalled();
		// Compaction still ran: the pre-delivered record is gone.
		expect(await harness.stores.readOutbox()).toEqual([poisoned, healthy]);
		// And the phase still committed terminal.
		expect(commits).toHaveLength(1);
	});
});
