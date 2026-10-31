/**
 * The `GET /v1/ext/memory-honcho/status` route (auth: user).
 *
 * A display-only observability projection over the extension's on-disk
 * state: the outbox backlog, the newest delivery timestamp, ledger/session
 * and pending-fork counts, the live settings' identity fields, whether an
 * API key resolves, and the representation worker's last-run bookkeeping.
 *
 * Two hard rules from the spec:
 *
 * - NO key material ever crosses the response body — `configured` is the
 *   boolean projection of the key resolution, and the key string is
 *   discarded immediately (the tests assert the fake key's absence from
 *   the serialized response).
 * - The read is a best-effort snapshot: the outbox read outside `withOutbox`
 *   is explicitly a display-only read (the stores' own posture), and every
 *   count comes from fresh disk reads — never from cached state.
 */
import type { ExtensionStores } from "./stores.js";
import type { HonchoSettings } from "./config.js";
import type { WorkerRunStatus } from "./types.js";
/** Alias for the shared worker bookkeeping (the one declaration lives in types.ts). */
export type { WorkerRunStatus as StatusWorkerRun } from "./types.js";
/** The status response body (the spec's exact field set). */
export interface HonchoStatus {
    readonly configured: boolean;
    readonly workspaceId: string;
    readonly agentPeerId: string;
    readonly baseUrl?: string;
    /** The newest delivered outbox record's `createdAt`; `null` before the first delivery. */
    readonly lastDeliveryAt: number | null;
    /** Outbox records still awaiting delivery. */
    readonly pendingOutbox: number;
    /** Per-conversation ledger count. */
    readonly ledgers: number;
    /** Pending-fork records with no `resolvedAt` stamp. */
    readonly pendingForks: number;
    /** Ledgers with an established Honcho session (clone-duplicate visibility). */
    readonly sessions: number;
    readonly worker: {
        readonly lastRunAt?: number;
        readonly lastError?: string;
    };
}
/** Everything the route needs, resolved live per request (settings/key written after boot apply at the next read). */
export interface StatusDeps {
    readonly settings: () => Promise<HonchoSettings>;
    readonly apiKey: () => Promise<string | undefined>;
    readonly stores: () => Promise<ExtensionStores>;
    /** The factory's worker bookkeeping map (Task 5/8's `workerStatus`). */
    readonly workerStatus: ReadonlyMap<string, WorkerRunStatus>;
    /** The bookkeeping map key of the representation worker. */
    readonly workerName: string;
}
export declare function buildStatus(deps: StatusDeps): Promise<HonchoStatus>;
/** Build the web-standard route handler from live-resolving deps. */
export declare function createStatusHandler(deps: StatusDeps): (request: Request) => Promise<Response>;
