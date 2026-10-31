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
export async function buildStatus(deps) {
    const [settings, apiKey, stores] = await Promise.all([
        deps.settings(),
        deps.apiKey(),
        deps.stores(),
    ]);
    const [outbox, ledgers, forks] = await Promise.all([
        stores.readOutbox(),
        stores.readLedgers(),
        stores.readPendingForks(),
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
    const run = deps.workerStatus.get(deps.workerName);
    // `endedAt` is the last COMPLETED run; a still-running worker's most
    // recent activity is its `startedAt`.
    const lastRunAt = run === undefined ? undefined : (run.endedAt ?? run.startedAt);
    const worker = {
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
        ...(run?.lastError !== undefined ? { lastError: run.lastError } : {}),
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
