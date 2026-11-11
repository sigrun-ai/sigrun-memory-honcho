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
 * capture on the conversation's extension selection (POSITIVE verdicts
 * memoized per conversation — a cached `false` is re-read on the next
 * event, so a mid-conversation opt-in captures; a mid-conversation
 * array-form opt-out keeps capturing until restart, the accepted residual
 * the README documents), appends the outbox record ALWAYS (a missing key
 * skips only the kick; the sweeper delivers later), and kicks
 * fire-and-forget delivery. The engine is constructed lazily on first use.
 *
 * Task 8's wiring: both prompt sections render from the representation
 * cache (`renderMemorySection`, sync reads only); the delivery engine's
 * `onDelivered` is the LEADING-EDGE injection point — a delivered
 * conversation with NO cache file refreshes once; and the idle/archived
 * worker re-refreshes from the ledger's owner.
 */
import { AgentDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { buildCaptureBatch } from "./capture.js";
import { resolveApiKey } from "./secrets.js";
import { HONCHO_SETTINGS_SCHEMA } from "./settings-schema.js";
import { DeliveryEngine } from "./delivery.js";
import { HonchoClient } from "./honcho.js";
import { createHonchoReader } from "./honcho-read.js";
import { refreshRepresentation, renderMemorySection } from "./representations.js";
import { createStatusHandler } from "./status.js";
import { ExtensionStores } from "./stores.js";
import { createSweepTask, SWEEP_TASK_NAME } from "./sweep.js";
import { createTools } from "./tools.js";
import { createHonchoView } from "./view.js";
/** This extension's registry name AND its selection-gate sentinel. */
const EXTENSION_NAME = "@sigrun/memory-honcho";
/** The shutdown drain deadline (spec: 25s under the host's shutdown budget). */
const DRAIN_DEADLINE_MS = 25_000;
/**
 * The missing-API-key notice fires once per FACTORY INSTANCE, not per
 * event. Factory-scoped (not module-global) so tests that create multiple
 * instances in any order each see the warning.
 */
function createWarnMissingKeyOnce() {
    let warned = false;
    return () => {
        if (warned)
            return;
        warned = true;
        console.warn("memory-honcho: no API key (secrets 'api-key' or SIGRUN_EXT_MEMORY_HONCHO_API_KEY) — capturing to the outbox without delivery");
    };
}
/**
 * Structural equality over the resolved settings (an engine rebuild is
 * warranted only when an actual value changed, not on a fresh object).
 */
function settingsEqual(a, b) {
    return (a.agentPeerId === b.agentPeerId &&
        a.baseUrl === b.baseUrl &&
        a.workspaceId === b.workspaceId &&
        a.contextTokens === b.contextTokens &&
        a.maxMessageLength === b.maxMessageLength &&
        a.searchLimit === b.searchLimit &&
        a.toolPreviewLength === b.toolPreviewLength &&
        a.representationTtlMs === b.representationTtlMs &&
        a.outboxRetentionDays === b.outboxRetentionDays &&
        a.deliveredBatchWindow === b.deliveredBatchWindow &&
        a.anchorWindow === b.anchorWindow);
}
/**
 * The leading-edge hook: a delivered conversation whose representation
 * cache is ABSENT refreshes once (a present cache is fresh enough — the
 * idle worker owns re-refreshes). The delivery engine calls the hook OUT
 * of the conversation chain, so this refresh chains behind the delivery
 * that just settled (never a circular wait). Failures log and are
 * swallowed: a failed refresh must never fault the delivery it rode in on.
 *
 * Extracted for the composition test (T8 parked minor): the test uses the
 * same factory instead of re-implementing the body verbatim.
 */
export function makeLeadingEdgeHook(opts) {
    return {
        onDelivered: async (conversationId) => {
            const store = await opts.stores();
            if (store.readRepresentationSync(conversationId) !== undefined)
                return;
            const ledger = store.readLedgerSync(conversationId);
            if (ledger === undefined)
                return;
            try {
                await refreshRepresentation(opts.client, store, opts.settings, conversationId, ledger.ownerAtFirstCapture);
            }
            catch (error) {
                console.error(`memory-honcho: leading-edge representation refresh failed for conversation ${conversationId}`, error);
            }
        },
    };
}
export function createHonchoMemory(host, deps = {}) {
    const declaredSettings = host.settings.declare({
        schema: HONCHO_SETTINGS_SCHEMA,
    });
    const resolveSettings = declaredSettings.get;
    const secretsStore = host.stores.secrets;
    const paths = host.stores.paths;
    const warnMissingKeyOnce = createWarnMissingKeyOnce();
    // Lazily constructed on first use — settings/key are resolved at that
    // moment, so configuration written after boot still applies.
    let storesPromise;
    // The sync-readable slot behind `storesPromise` (promise .then callbacks
    // are microtasks, NEVER synchronous, so the prompt sections — sync by
    // contract — cannot inspect the promise; they read this slot instead).
    let resolvedStores;
    let enginePromise;
    // The configuration the cached engine was built with: it is reused ONLY
    // while both are unchanged (stored wins without restart — the key can
    // arrive after boot).
    let engineKey;
    let engineSettings;
    // The client the cached engine was built with. Session marks live on
    // THIS instance (establishment marks its ConversationClients), so the
    // worker's refresh gate (`hasSession`) is only meaningful through it —
    // a per-run fresh client would always gate false and the idle-wake
    // refresh would never fire (Task-8 review finding 2).
    let engineClient;
    function makeClient(settings, apiKey) {
        return (deps.createClient ?? ((s, key) => new HonchoClient(s, key)))(settings, apiKey);
    }
    function stores() {
        storesPromise ??= resolveSettings().then((settings) => {
            resolvedStores = new ExtensionStores(paths, settings);
            return resolvedStores;
        });
        return storesPromise;
    }
    /**
     * The prompt-section posture: render ONLY once the stores are
     * constructed — the reads are sync, so a section must never block
     * prompt assembly on the settings read behind the stores' lazy
     * construction. Before the first event (or from a section render
     * racing it), there is nothing to render.
     */
    function renderMemorySectionSync(conversationId) {
        if (resolvedStores === undefined)
            return undefined;
        return renderMemorySection(resolvedStores, conversationId, Date.now());
    }
    async function engine() {
        // Resolve FIRST, cache-compare second: a key/settings change rebuilds.
        const settings = await resolveSettings();
        const apiKey = await resolveApiKey(secretsStore);
        if (enginePromise !== undefined &&
            apiKey === engineKey &&
            engineSettings !== undefined &&
            settingsEqual(settings, engineSettings)) {
            return enginePromise;
        }
        const building = (async () => {
            const client = makeClient(settings, apiKey);
            engineClient = client;
            // The leading-edge hook: a delivered conversation whose
            // representation cache is ABSENT refreshes once (a present cache
            // is fresh enough — the idle worker owns re-refreshes). The
            // delivery engine calls the hook OUT of the conversation chain,
            // so this refresh chains behind the delivery that just settled
            // (never a circular wait). Failures log and are swallowed: a
            // failed refresh must never fault the delivery it rode in on.
            const hooks = makeLeadingEdgeHook({
                stores,
                client,
                settings,
            });
            return (deps.createEngine ?? ((c, st, s, h) => new DeliveryEngine(c, st, s, h)))(client, await stores(), settings, hooks);
        })();
        enginePromise = building;
        engineKey = apiKey;
        engineSettings = settings;
        // A rejected build is never memoized (identity-guarded, same class as
        // the Task-2 peer memo): the next event retries the construction.
        building.catch(() => {
            if (enginePromise === building) {
                enginePromise = undefined;
                engineKey = undefined;
                engineSettings = undefined;
                engineClient = undefined;
            }
        });
        return building;
    }
    // Per-conversation selection memo: POSITIVE verdicts only (a `configure`
    // or owner transfer can rewrite the selection mid-conversation). A cached
    // `false` is never trusted — the AgentDoc is re-read on the next event, so
    // a later opt-in captures; the residual (an array-form opt-out AFTER a
    // positive verdict keeps capturing until restart) is the accepted v1
    // semantics, documented in the README.
    const selectionMemo = new Map();
    async function isSelected(conversationId, api, context) {
        const memoized = selectionMemo.get(conversationId);
        if (memoized !== undefined)
            return memoized;
        const agent = await api.document(AgentDoc, 
        // SAFETY: the seam's event carries plain numbers; branded ids are
        // structurally identical (src/types.ts), so the value the host
        // passes satisfies both spellings.
        conversationId, context);
        // Array form selects exactly its members; the object form edits the
        // host default (a `remove` of us is a no-op — we are not host-default).
        const selected = !Array.isArray(agent?.extensions) ||
            agent.extensions.includes(EXTENSION_NAME);
        if (selected)
            selectionMemo.set(conversationId, true);
        return selected;
    }
    const workerStatus = new Map([
        ["honcho-representations", { runs: 0 }],
    ]);
    // The tools need the engine, which is lazy. The extension's tools array
    // is static, so the tools are built once (eagerly) with a lazy engine
    // accessor: each tool's execute closure awaits the engine before its
    // first Honcho call.
    const tools = createTools({
        host,
        client: () => engineClient,
        engine: () => engine(),
        settings: () => engineSettings,
    });
    // The read-only Honcho view (Task 3): the reader is built per render
    // from FRESH settings + key, so settings written after boot apply at
    // the next render without a restart.
    const view = createHonchoView({
        host,
        reader: deps.createReader ??
            ((s, key) => createHonchoReader({
                baseUrl: s.baseUrl ?? process.env.HONCHO_URL ?? "https://api.honcho.dev",
                workspaceId: s.workspaceId,
                ...(key === undefined ? {} : { apiKey: key }),
            })),
        settings: () => resolveSettings(),
        apiKey: () => resolveApiKey(secretsStore),
    });
    return {
        title: "Honcho",
        extension: defineExtension({
            name: EXTENSION_NAME,
            tools,
            sections: [
                // Both sections render the same cache snapshot.
                section("long-term-memory", (input) => renderMemorySectionSync(Number(input.conversationId))),
                section("honcho-memory", (input) => renderMemorySectionSync(Number(input.conversationId))),
            ],
            tasks: [
                // The outbox sweeper (fired by the outbox-sweep cron job below).
                createSweepTask({ engine, stores, settings: () => resolveSettings() }),
            ],
        }),
        workerStatus,
        async runSettled(event, api, context) {
            const settings = await resolveSettings();
            const owner = event.owner ?? "user";
            const record = buildCaptureBatch(event, owner, settings.maxMessageLength);
            if (record === undefined)
                return;
            if (!(await isSelected(event.conversationId, api, context)))
                return;
            // Append ALWAYS — under the outbox mutex so the sweeper's rewrite
            // never loses a concurrent capture (Task 7's posture).
            const store = await stores();
            await store.withOutbox(() => store.appendOutboxRecord(record));
            // A missing key skips ONLY the kick: the sweeper delivers later.
            const apiKey = await resolveApiKey(secretsStore);
            if (apiKey === undefined) {
                warnMissingKeyOnce();
                return;
            }
            (await engine()).kick(event.conversationId, owner);
        },
        async conversationForked(event) {
            // The fork ANCHOR is all this handler writes; the clone itself
            // happens on the child's first delivery (zero network here).
            const store = await stores();
            await store.writePendingFork({
                childId: event.childId,
                parentId: event.parentId,
                at: event.at,
                createdAt: Date.now(),
            });
        },
        async harnessShutdown() {
            const settings = await resolveSettings();
            const apiKey = await resolveApiKey(secretsStore);
            await makeClient(settings, apiKey).drainAll(DRAIN_DEADLINE_MS);
        },
        workers: [
            {
                name: "honcho-representations",
                wakeOn: ["conversationIdle", "conversationArchived"],
                async run(_context, wake) {
                    const status = workerStatus.get("honcho-representations");
                    if (status !== undefined) {
                        status.runs += 1;
                        status.startedAt = Date.now();
                    }
                    try {
                        // The wake carries the conversation to re-refresh; the
                        // owner comes from the ledger (the same record the
                        // render gates on, so a ledger-less conversation is a
                        // bookkeeping-only no-op). The engine resolution keeps
                        // client/stores warm and honors the live-settings seam;
                        // a custom `createEngine` (tests) skips the refresh.
                        if (wake !== undefined) {
                            const resolvedEngine = await engine();
                            if (resolvedEngine instanceof DeliveryEngine &&
                                engineSettings !== undefined) {
                                const store = await stores();
                                // SAFETY: the host's WorkerWake carries a branded
                                // ConversationId; branded ids are plain numbers (see
                                // src/types.ts), so Number() is the honest unwrapping.
                                const conversationId = Number(wake.conversationId);
                                const ledger = store.readLedgerSync(conversationId);
                                if (ledger !== undefined) {
                                    // Refresh through the ENGINE's client: session
                                    // marks live there (a fresh client would always
                                    // gate false). A conversation without an
                                    // established session (never delivered — e.g.
                                    // idle before the first capture) has nothing to
                                    // snapshot; skip quietly. `engineClient` is set
                                    // alongside the engine the `instanceof` check
                                    // just confirmed.
                                    if (engineClient !== undefined) {
                                        const conversation = engineClient.for(String(conversationId));
                                        if (conversation.hasSession()) {
                                            await refreshRepresentation(engineClient, store, engineSettings, conversationId, ledger.ownerAtFirstCapture);
                                        }
                                    }
                                }
                            }
                        }
                        if (status !== undefined)
                            status.endedAt = Date.now();
                    }
                    catch (error) {
                        if (status !== undefined) {
                            const message = error instanceof Error ? error.message : String(error);
                            // Bounded: the status route projects this verbatim and a
                            // runaway error string must not blow up the body.
                            status.lastError = message.slice(0, 500);
                            status.endedAt = Date.now();
                        }
                        throw error;
                    }
                },
            },
        ],
        jobs: [
            {
                name: "outbox-sweep",
                schedule: { cron: "*/15 * * * *" },
                action: { kind: "task", task: SWEEP_TASK_NAME },
            },
        ],
        surfaces: { views: [view] },
        routes: [
            {
                method: "GET",
                path: "status",
                auth: "user",
                // Display-only observability over the on-disk state. The deps
                // resolve LIVE per request (settings/key/stores written after
                // boot apply at the next read); the worker bookkeeping is the
                // factory-closure map this result also exposes as
                // `workerStatus`. No key material crosses the body —
                // buildStatus projects the key to the `configured` boolean.
                handler: createStatusHandler({
                    settings: () => resolveSettings(),
                    apiKey: () => resolveApiKey(secretsStore),
                    stores,
                    workerStatus,
                    workerName: "honcho-representations",
                }),
            },
        ],
        userDeleted(event) {
            // Departure notice only — no data movement (Task 11 pins it).
            console.info(`memory-honcho: user "${event.user}" deleted (resources transferred to "${event.transferTo}")`);
        },
    };
}
export default createHonchoMemory;
