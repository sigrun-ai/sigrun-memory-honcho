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
import type { HonchoSettings } from "./config.js";
import type { DeliveryEngine } from "./delivery.js";
import type { ExtensionStores } from "./stores.js";
/** The registered task kind; the cron job's action names it. */
export declare const SWEEP_TASK_NAME = "honcho-outbox-sweep";
/** The sweep's dependencies — the factory wires the real ones; tests inject fakes. */
export interface SweepTaskDeps {
    readonly engine: () => DeliveryEngine | Promise<DeliveryEngine>;
    readonly stores: () => ExtensionStores | Promise<ExtensionStores>;
    readonly settings: () => HonchoSettings | Promise<HonchoSettings>;
}
/** The sweep body, shared by the task phase and directly unit-testable. */
export declare function runSweep(deps: SweepTaskDeps): Promise<void>;
/** The sweep is one phase; the checkpoint never carries data. */
type SweepCheckpoint = {
    phase: "sweep";
};
/** The task object the extension registers (`extension.tasks`). */
export declare function createSweepTask(deps: SweepTaskDeps): import("@earendil-works/pi-durable").Task<unknown, SweepCheckpoint, unknown, object>;
export {};
