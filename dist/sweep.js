/**
 * The outbox sweeper task (`honcho-outbox-sweep`), fired by the
 * `outbox-sweep` cron job every 15 minutes.
 *
 * Body: group the outbox by conversation in file order; resolve
 * UNRESOLVED pending-forks first (a per-conversation `establish` ahead of
 * the forked child's own deliveries); `deliverPending` each conversation;
 * then compact inside `withOutbox` (drop delivered records — including the
 * skipped-but-lingering kind whose batchId already sits in the ledger's
 * delivered window — and pending records older than `outboxRetentionDays`,
 * warning per drop; rewrite). Idempotent under re-fire: a sweep with a
 * fully-delivered outbox touches nothing but the terminal commit.
 *
 * Lock discipline: the engine calls happen OUTSIDE the outbox mutex
 * (`deliverPending` owns its own `withOutbox`; the mutex is not
 * re-entrant); the compaction pass re-reads inside its own `withOutbox`,
 * so records appended between the planning read and the rewrite are
 * re-examined, never clobbered. Settings are resolved FRESH per sweep (the
 * stores freeze `anchorWindow`/`deliveredBatchWindow` at first use, but
 * retention must follow live settings).
 *
 * The real pi-durable `TaskDefinition` shape: `{name, version, initial,
 * phases, abort}` — there is NO `run` member. A phase must commit durable
 * progress before returning (returning without a commit faults the task),
 * so `phases.sweep` ends in the terminal-completed commit and `abort`
 * commits terminal-failed.
 */
import { defineTask } from "@earendil-works/pi-durable";
/** The registered task kind; the cron job's action names it. */
export const SWEEP_TASK_NAME = "honcho-outbox-sweep";
const DAY_MS = 86_400_000;
/**
 * The planning read: which conversations have outbox records, and which of
 * their pending-fork records are still unresolved. Runs OUTSIDE the mutex —
 * nothing here writes, and the compaction re-read re-validates everything
 * the rewrite touches.
 */
async function plan(stores) {
    const records = await stores.readOutbox();
    const conversationIds = [];
    const seen = new Set();
    const ownerByConversation = new Map();
    for (const record of records) {
        if (!seen.has(record.conversationId)) {
            seen.add(record.conversationId);
            conversationIds.push(record.conversationId);
            ownerByConversation.set(record.conversationId, record.owner);
        }
    }
    const unresolvedForks = [];
    for (const conversationId of conversationIds) {
        const fork = await stores.readPendingFork(conversationId);
        if (fork !== undefined && fork.resolvedAt === undefined) {
            unresolvedForks.push(conversationId);
        }
    }
    return { conversationIds, ownerByConversation, unresolvedForks };
}
/**
 * Compact: drop delivered records (a re-read inside the mutex catches
 * records the engine flipped after the planning read, and the ledger's
 * delivered window catches the skipped-but-lingering kind — a pending
 * record whose batchId is already delivered), and pending records older
 * than the retention cutoff (warned, per record). Records appended between
 * the planning read and here are re-examined by the same rules. Returns
 * the dropped counts for observability.
 */
async function compact(stores, retentionDays) {
    const cutoff = Date.now() - retentionDays * DAY_MS;
    return stores.withOutbox(async () => {
        const records = await stores.readOutbox();
        let droppedDelivered = 0;
        let droppedExpired = 0;
        const deliveredWindows = new Map();
        const kept = [];
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
                // window) — drop it so every later sweep stops revisiting it.
                droppedDelivered += 1;
                continue;
            }
            if (record.createdAt < cutoff) {
                droppedExpired += 1;
                console.warn(`memory-honcho: dropping over-retention outbox record ${record.batchId} (conversation ${record.conversationId}, created ${new Date(record.createdAt).toISOString()}, older than ${retentionDays}d retention)`);
                continue;
            }
            kept.push(record);
        }
        await stores.rewriteOutbox(kept);
        return { delivered: droppedDelivered, expired: droppedExpired };
    });
}
/** The sweep body, shared by the task phase and directly unit-testable. */
export async function runSweep(deps) {
    const stores = await deps.stores();
    const settings = await deps.settings();
    const engine = await deps.engine();
    const { conversationIds, ownerByConversation, unresolvedForks } = await plan(stores);
    // Forks first: a cloned child's establishment must land before its own
    // deliveries (the clone decision reads the parent's ledger, which this
    // very sweep may have just advanced).
    for (const childId of unresolvedForks) {
        const owner = ownerByConversation.get(childId) ?? "user";
        await engine.establish(childId, owner);
    }
    for (const conversationId of conversationIds) {
        const owner = ownerByConversation.get(conversationId) ?? "user";
        await engine.deliverPending(conversationId, owner);
    }
    await compact(stores, settings.outboxRetentionDays);
}
/** The task object the extension registers (`extension.tasks`). */
export function createSweepTask(deps) {
    return defineTask({
        name: SWEEP_TASK_NAME,
        version: 1,
        initial: () => ({ phase: "sweep" }),
        phases: {
            sweep: async (_task, runtime, context) => {
                await runSweep(deps);
                // REQUIRED: a phase returning without durable progress faults the
                // task. The sweep's bookkeeping lives in the outbox files; the
                // task's own terminal outcome is the durable progress.
                await runtime.commit(() => ({
                    status: "terminal",
                    outcome: { status: "completed", result: undefined },
                }), context);
            },
        },
        abort: async (_task, runtime, context) => {
            await runtime.commit(() => ({
                status: "terminal",
                outcome: {
                    status: "failed",
                    error: { message: "aborted" },
                },
            }), context);
        },
    });
}
