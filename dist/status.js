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
/** `lastError` is display-only and bounded — a huge error string must not blow up the status body. */
const LAST_ERROR_MAX = 500;
export async function buildStatus(deps) {
    const [settings, apiKey, stores] = await Promise.all([
        deps.settings(),
        deps.apiKey(),
        deps.stores(),
    ]);
    // Best-effort snapshot: a corrupt file degrades that bucket's counts to
    // zero rather than 500ing the route (display-only observability).
    const safe = (read) => read.catch(() => []);
    const [outbox, ledgers, forks, marker] = await Promise.all([
        safe(stores.readOutbox()),
        safe(stores.readLedgers()),
        safe(stores.readPendingForks()),
        stores.readLastDelivery().catch(() => undefined),
    ]);
    let lastDeliveryAt = null;
    let pendingOutbox = 0;
    for (const record of outbox) {
        if (record.status === "delivered") {
            if (lastDeliveryAt === null || record.createdAt > lastDeliveryAt) {
                lastDeliveryAt = record.createdAt;
            }
        }
        else {
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
    const lastError = run?.lastError === undefined
        ? undefined
        : run.lastError.slice(0, LAST_ERROR_MAX);
    const worker = {
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
export function createStatusHandler(deps) {
    return async () => Response.json(await buildStatus(deps), { status: 200 });
}
