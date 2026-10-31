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
 */
import { AgentDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { buildCaptureBatch } from "./capture.js";
import { resolveApiKey, resolveSettings, } from "./config.js";
import { DeliveryEngine } from "./delivery.js";
import { HonchoClient } from "./honcho.js";
import { ExtensionStores } from "./stores.js";
/** This extension's registry name AND its selection-gate sentinel. */
const EXTENSION_NAME = "@sigrun/memory-honcho";
/** The shutdown drain deadline (spec: 25s under the host's shutdown budget). */
const DRAIN_DEADLINE_MS = 25_000;
/** The missing-API-key notice fires once per process, not per event. */
let missingKeyWarned = false;
function warnMissingKeyOnce() {
    if (missingKeyWarned)
        return;
    missingKeyWarned = true;
    console.warn("memory-honcho: no API key (secrets 'api-key' or SIGRUN_EXT_MEMORY_HONCHO_API_KEY) — capturing to the outbox without delivery");
}
export function createHonchoMemory(host, deps = {}) {
    const settingsStore = host.stores.settings;
    const secretsStore = host.stores.secrets;
    const paths = host.stores.paths;
    // Lazily constructed on first use — settings/key are resolved at that
    // moment, so configuration written after boot still applies.
    let storesPromise;
    let enginePromise;
    function stores() {
        storesPromise ??= resolveSettings(settingsStore).then((settings) => new ExtensionStores(paths, settings));
        return storesPromise;
    }
    function engine() {
        enginePromise ??= (async () => {
            const settings = await resolveSettings(settingsStore);
            const apiKey = await resolveApiKey(secretsStore);
            const client = (deps.createClient ?? ((s, key) => new HonchoClient(s, key)))(settings, apiKey);
            return (deps.createEngine ?? ((c, st, s) => new DeliveryEngine(c, st, s)))(client, await stores(), settings);
        })();
        return enginePromise;
    }
    // Per-conversation selection memo: the extension selection does not
    // change mid-conversation, so the AgentDoc read happens once each.
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
        selectionMemo.set(conversationId, selected);
        return selected;
    }
    const workerStatus = new Map([
        ["honcho-representations", { runs: 0 }],
    ]);
    return {
        extension: defineExtension({
            name: EXTENSION_NAME,
            tools: [],
            sections: [
                // Render bodies land in Task 8.
                section("long-term-memory", () => undefined),
                section("honcho-memory", () => undefined),
            ],
            tasks: [],
        }),
        workerStatus,
        async runSettled(event, api, context) {
            const settings = await resolveSettings(settingsStore);
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
            const settings = await resolveSettings(settingsStore);
            const apiKey = await resolveApiKey(secretsStore);
            const client = (deps.createClient ?? ((s, key) => new HonchoClient(s, key)))(settings, apiKey);
            await client.drainAll(DRAIN_DEADLINE_MS);
        },
        workers: [
            {
                name: "honcho-representations",
                wakeOn: ["conversationIdle", "conversationArchived"],
                async run(_context, wake) {
                    // Bookkeeping only until Task 8 fills the refresh body; the
                    // engine resolution is the seam that body needs first.
                    const status = workerStatus.get("honcho-representations");
                    if (status !== undefined) {
                        status.runs += 1;
                        status.startedAt = Date.now();
                    }
                    try {
                        void wake;
                        await engine();
                        if (status !== undefined)
                            status.endedAt = Date.now();
                    }
                    catch (error) {
                        if (status !== undefined) {
                            status.lastError =
                                error instanceof Error ? error.message : String(error);
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
                action: { kind: "task", task: "honcho-outbox-sweep" },
            },
        ],
        routes: [
            {
                method: "GET",
                path: "status",
                auth: "user",
                // Stub body until Task 10.
                handler: async () => new Response("memory-honcho: status stub\n", { status: 200 }),
            },
        ],
        userDeleted(event) {
            // Departure notice only — no data movement (Task 11 pins it).
            console.info(`memory-honcho: user "${event.user}" deleted (resources transferred to "${event.transferTo}")`);
        },
    };
}
export default createHonchoMemory;
