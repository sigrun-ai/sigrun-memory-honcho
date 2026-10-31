/**
 * @sigrun/memory-honcho: the public surface.
 *
 * The DEFAULT export is the factory the sigrun extension loader calls.
 * ARITY IS THE CONTRACT: the loader passes the host only when
 * `factory.length > 0`, and a defaulted FIRST parameter would consume the
 * host as a real dependency — so the host is declared bare and the test
 * seam (`deps`) is the defaulted SECOND parameter, keeping `length === 1`.
 *
 * The factory composes Tasks 1-4: per-event it resolves settings and the
 * API key LIVE (a key written after boot applies at the next event), gates
 * capture on the conversation's extension selection (memoized per
 * conversation — the selection does not change mid-conversation), appends
 * the outbox record ALWAYS (a missing key skips only the kick; the sweeper
 * delivers later), and kicks fire-and-forget delivery. The engine is
 * constructed lazily on first use.
 *
 * Task 8's wiring: both prompt sections render from the representation
 * cache (`renderMemorySection`, sync reads only); the delivery engine's
 * `onDelivered` is the LEADING-EDGE injection point — a delivered
 * conversation with NO cache file refreshes once; and the idle/archived
 * worker re-refreshes from the ledger's owner.
 */
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { type HonchoSettings } from "./config.js";
import { DeliveryEngine, type DeliveryHooks } from "./delivery.js";
import { HonchoClient } from "./honcho.js";
import { ExtensionStores } from "./stores.js";
/** Bookkeeping the worker's run body records (Task 8 fills the real work). */
export interface WorkerRunStatus {
    runs: number;
    startedAt?: number;
    endedAt?: number;
    lastError?: string;
}
/** The factory result, plus the worker bookkeeping Task 8 reports from. */
export type SigrunExtensionResultLike = SigrunExtensionResult & {
    readonly workerStatus: ReadonlyMap<string, WorkerRunStatus>;
};
/** Test seam: replace the engine/client construction (never the stores). */
export interface FactoryDeps {
    createEngine?: (client: HonchoClient, stores: ExtensionStores, settings: HonchoSettings, hooks: DeliveryHooks) => DeliveryEngine;
    createClient?: (settings: HonchoSettings, apiKey: string | undefined) => HonchoClient;
}
export declare function createHonchoMemory(host: SigrunHost, deps?: FactoryDeps): SigrunExtensionResultLike;
export default createHonchoMemory;
