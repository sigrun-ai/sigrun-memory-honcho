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
import type { HonchoSettings } from "./settings-schema.js";
import type { WorkerRunStatus } from "./types.js";

/** Alias for the shared worker bookkeeping (the one declaration lives in types.ts). */
export type { WorkerRunStatus as StatusWorkerRun } from "./types.js";

/** `lastError` is display-only and bounded — a huge error string must not blow up the status body. */
const LAST_ERROR_MAX = 500;

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

export async function buildStatus(deps: StatusDeps): Promise<HonchoStatus> {
	const [settings, apiKey, stores] = await Promise.all([
		deps.settings(),
		deps.apiKey(),
		deps.stores(),
	]);
	// Best-effort snapshot: a corrupt file degrades that bucket's counts to
	// zero rather than 500ing the route (display-only observability).
	const safe = <T>(read: Promise<T[]>): Promise<T[]> =>
		read.catch(() => [] as T[]);
	const [outbox, ledgers, forks, marker] = await Promise.all([
		safe(stores.readOutbox()),
		safe(stores.readLedgers()),
		safe(stores.readPendingForks()),
		stores.readLastDelivery().catch(() => undefined),
	]);

	let lastDeliveryAt: number | null = null;
	let pendingOutbox = 0;
	for (const record of outbox) {
		if (record.status === "delivered") {
			if (lastDeliveryAt === null || record.createdAt > lastDeliveryAt) {
				lastDeliveryAt = record.createdAt;
			}
		} else {
			pendingOutbox += 1;
		}
	}
	// The marker wins when present: the sweeper drops delivered records
	// every 15 minutes, so the retained-records derivation dies with them.
	// The derivation is the fallback for an install that delivered before
	// the marker existed.
	if (marker !== undefined) {
		lastDeliveryAt =
			lastDeliveryAt === null
				? marker.at
				: Math.max(lastDeliveryAt, marker.at);
	}

	const run = deps.workerStatus.get(deps.workerName);
	// `endedAt` is the last COMPLETED run; a still-running worker's most
	// recent activity is its `startedAt`.
	const lastRunAt = run === undefined ? undefined : (run.endedAt ?? run.startedAt);
	const lastError =
		run?.lastError === undefined
			? undefined
			: run.lastError.slice(0, LAST_ERROR_MAX);
	const worker: HonchoStatus["worker"] = {
		...(lastRunAt !== undefined ? { lastRunAt } : {}),
		...(lastError !== undefined ? { lastError } : {}),
	};

	// The key string is discarded the instant the boolean is taken — it can
	// never reach the body.
	const configured = apiKey !== undefined;
	return {
		configured,
		workspaceId: settings.workspaceId,
		agentPeerId: settings.agentPeerId,
		...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
		lastDeliveryAt,
		pendingOutbox,
		ledgers: ledgers.length,
		pendingForks: forks.filter((fork) => fork.resolvedAt === undefined).length,
		sessions: ledgers.filter((ledger) => ledger.honchoSessionId !== undefined)
			.length,
		worker,
	};
}

/** Build the web-standard route handler from live-resolving deps. */
export function createStatusHandler(
	deps: StatusDeps,
): (request: Request) => Promise<Response> {
	return async () =>
		Response.json(await buildStatus(deps), { status: 200 });
}
