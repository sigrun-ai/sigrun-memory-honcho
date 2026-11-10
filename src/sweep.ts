/**
 * The outbox sweeper task (`honcho-outbox-sweep`), fired by the
 * `outbox-sweep` cron job every 15 minutes.
 *
 * Body: group the outbox by conversation in file order; ESTABLISH every
 * planned conversation (unresolved pending-forks first — a cloned child's
 * establishment must land before its own deliveries), so the spec's
 * recovery lane works: a pending record whose conversation has no ledger
 * and no in-memory session mark (the missing-key / Honcho-down-at-capture
 * state) gets the get-or-create it needs, because `establish` is
 * idempotent (one ledger read when the ledger exists, no network). Then
 * `deliverPending` each conversation; then compact inside `withOutbox`
 * (drop delivered records — including the skipped-but-lingering kind whose
 * batchId already sits in the ledger's delivered window — and pending
 * records older than `outboxRetentionDays`, warning per retention drop;
 * rewrite). Idempotent under re-fire: a sweep with a fully-delivered
 * outbox touches nothing but the terminal commit.
 *
 * Failure posture: per-conversation try/catch + `console.error` +
 * continue. ONE poisoned conversation can never fault the task, block the
 * rest of the file, or skip compaction — a phase rejection faults the
 * task, and a faulted sweep leaves retention drops and later-conversation
 * deliveries undone forever.
 *
 * Lock discipline: the engine calls happen OUTSIDE the outbox mutex
 * (`deliverPending` owns its own `withOutbox`; the mutex is not
 * re-entrant). The planning read runs inside `withOutbox` (a read-only
 * hold; nothing here calls the engine inside it). The compaction pass
 * re-reads inside its own `withOutbox`, so records appended between the
 * planning read and the rewrite are re-examined, never clobbered.
 * Settings are resolved FRESH per sweep (the stores freeze
 * `anchorWindow`/`deliveredBatchWindow` at first use, but retention must
 * follow live settings).
 *
 * The real pi-durable `TaskDefinition` shape: `{name, version, initial,
 * phases, abort}` — there is NO `run` member. A phase must commit durable
 * progress before returning (returning without a commit faults the task),
 * so `phases.sweep` ends in the terminal-completed commit and `abort`
 * commits terminal-failed.
 */

import { defineTask } from "@earendil-works/pi-durable";

import type { HonchoSettings } from "./settings-schema.js";
import type { DeliveryEngine } from "./delivery.js";
import type { ExtensionStores } from "./stores.js";
import type { OutboxRecord } from "./types.js";

/** The registered task kind; the cron job's action names it. */
export const SWEEP_TASK_NAME = "honcho-outbox-sweep";

const DAY_MS = 86_400_000;

/** The sweep's dependencies — the factory wires the real ones; tests inject fakes. */
export interface SweepTaskDeps {
	readonly engine: () => DeliveryEngine | Promise<DeliveryEngine>;
	readonly stores: () => ExtensionStores | Promise<ExtensionStores>;
	readonly settings: () => HonchoSettings | Promise<HonchoSettings>;
}

interface SweepPlan {
	/** Conversation ids in outbox file order (first appearance wins). */
	readonly conversationIds: number[];
	/** Per-conversation owner (the first record's — ledger-consistent per the delivery rules). */
	readonly ownerByConversation: ReadonlyMap<number, string>;
	/** Unresolved pending-fork child ids, file order, established ahead of the rest. */
	readonly unresolvedForks: number[];
}

/**
 * The planning read, INSIDE the outbox mutex (read-only; it never calls
 * the engine, so the non-reentrancy rule is never tripped): which
 * conversations have outbox records, and which of their pending-fork
 * records are still unresolved.
 */
async function plan(stores: ExtensionStores): Promise<SweepPlan> {
	return stores.withOutbox(async () => {
		const records = await stores.readOutbox();
		const conversationIds: number[] = [];
		const seen = new Set<number>();
		const ownerByConversation = new Map<number, string>();
		for (const record of records) {
			if (!seen.has(record.conversationId)) {
				seen.add(record.conversationId);
				conversationIds.push(record.conversationId);
				ownerByConversation.set(record.conversationId, record.owner);
			}
		}
		const unresolvedForks: number[] = [];
		for (const conversationId of conversationIds) {
			const fork = await stores.readPendingFork(conversationId);
			if (fork !== undefined && fork.resolvedAt === undefined) {
				unresolvedForks.push(conversationId);
			}
		}
		return { conversationIds, ownerByConversation, unresolvedForks };
	});
}

/**
 * Compact: drop delivered records (a re-read inside the mutex catches
 * records the engine flipped after the planning read, and the ledger's
 * delivered window catches the skipped-but-lingering kind — a pending
 * record whose batchId is already delivered, dropped SILENTLY: the ledger
 * already counts the batch, so this is housekeeping, not data loss), and
 * pending records older than the retention cutoff (warned, per record).
 * Records appended between the planning read and here are re-examined by
 * the same rules. The rewrite is skipped when nothing was dropped. The
 * counts are logged for observability.
 */
async function compact(
	stores: ExtensionStores,
	retentionDays: number,
): Promise<void> {
	const cutoff = Date.now() - retentionDays * DAY_MS;
	const counts = await stores.withOutbox(async () => {
		const records = await stores.readOutbox();
		let droppedDelivered = 0;
		let droppedExpired = 0;
		const deliveredWindows = new Map<number, ReadonlySet<string>>();
		const kept: OutboxRecord[] = [];
		for (const record of records) {
			if (record.status === "delivered") {
				droppedDelivered += 1;
				continue;
			}
			let delivered = deliveredWindows.get(record.conversationId);
			if (delivered === undefined) {
				const ledger = await stores.readLedger(record.conversationId);
				delivered = new Set(ledger?.deliveredBatchIds ?? []);
				deliveredWindows.set(record.conversationId, delivered);
			}
			if (delivered.has(record.batchId)) {
				// Skipped-but-lingering: the ledger already counts the batch as
				// delivered but the record never flipped (the accepted crash
				// window) — drop it silently so every later sweep stops
				// revisiting it.
				droppedDelivered += 1;
				continue;
			}
			if (record.createdAt < cutoff) {
				droppedExpired += 1;
				console.warn(
					`memory-honcho: dropping over-retention outbox record ${record.batchId} (conversation ${record.conversationId}, created ${new Date(record.createdAt).toISOString()}, older than ${retentionDays}d retention)`,
				);
				continue;
			}
			kept.push(record);
		}
		if (droppedDelivered + droppedExpired > 0) {
			await stores.rewriteOutbox(kept);
		}
		return { delivered: droppedDelivered, expired: droppedExpired };
	});
	if (counts.delivered + counts.expired > 0) {
		console.info(
			`memory-honcho: outbox compaction dropped ${counts.delivered} delivered, ${counts.expired} expired`,
		);
	}
}

/** The sweep body, shared by the task phase and directly unit-testable. */
export async function runSweep(
	deps: SweepTaskDeps,
	signal?: AbortSignal,
): Promise<void> {
	const stores = await deps.stores();
	const settings = await deps.settings();
	const engine = await deps.engine();

	const { conversationIds, ownerByConversation, unresolvedForks } =
		await plan(stores);

	// Establish EVERY planned conversation — idempotent (one ledger read
	// when the ledger exists, no network), and for a ledger-less
	// conversation the get-or-create the recovery lane needs. Unresolved
	// forks go first (a clone decision reads the parent's ledger, which
	// this very sweep may have just advanced). One failure logs and moves
	// on: a poisoned conversation can never block the rest.
	const establishOrder = [
		...unresolvedForks,
		...conversationIds.filter((id) => !unresolvedForks.includes(id)),
	];
	for (const conversationId of establishOrder) {
		if (signal?.aborted === true) break;
		const owner = ownerByConversation.get(conversationId) ?? "user";
		try {
			await engine.establish(conversationId, owner);
		} catch (error) {
			console.error(
				`memory-honcho: sweep establish failed for conversation ${conversationId}`,
				error,
			);
		}
	}

	for (const conversationId of conversationIds) {
		if (signal?.aborted === true) break;
		const owner = ownerByConversation.get(conversationId) ?? "user";
		try {
			await engine.deliverPending(conversationId, owner);
		} catch (error) {
			console.error(
				`memory-honcho: sweep delivery failed for conversation ${conversationId}`,
				error,
			);
		}
	}

	// Compaction runs even when conversations above failed: retention and
	// delivered-record drops must not be hostage to a poisoned entry.
	await compact(stores, settings.outboxRetentionDays);
}

/** The sweep is one phase; the checkpoint never carries data. */
type SweepCheckpoint = { phase: "sweep" };

/** The task object the extension registers (`extension.tasks`). */
export function createSweepTask(deps: SweepTaskDeps) {
	return defineTask({
		name: SWEEP_TASK_NAME,
		version: 1,
		initial: (): SweepCheckpoint => ({ phase: "sweep" }),
		phases: {
			sweep: async (_task, runtime, context) => {
				await runSweep(deps, runtime.signal);
				// REQUIRED: a phase returning without durable progress faults the
				// task. The sweep's bookkeeping lives in the outbox files; the
				// task's own terminal outcome is the durable progress.
				await runtime.commit(
					() => ({
						status: "terminal" as const,
						outcome: { status: "completed" as const, result: undefined },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: {
						status: "failed" as const,
						error: { message: "aborted" },
					},
				}),
				context,
			);
		},
	});
}
