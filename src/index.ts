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
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	HandlerContext,
	MemoryEventApi,
	SigrunExtensionResult,
	SigrunHost,
} from "@sigrun/sigrun/extension";

import { buildCaptureBatch } from "./capture.js";
import {
	resolveApiKey,
	resolveSettings,
	type HonchoSettings,
	type SecretsReader,
	type SettingsReader,
} from "./config.js";
import { DeliveryEngine } from "./delivery.js";
import { HonchoClient } from "./honcho.js";
import { ExtensionStores, type StorePaths } from "./stores.js";
import { createSweepTask } from "./sweep.js";
import type { RunSettledEventLike } from "./types.js";

/** This extension's registry name AND its selection-gate sentinel. */
const EXTENSION_NAME = "@sigrun/memory-honcho";

/** The shutdown drain deadline (spec: 25s under the host's shutdown budget). */
const DRAIN_DEADLINE_MS = 25_000;

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
	createEngine?: (
		client: HonchoClient,
		stores: ExtensionStores,
		settings: HonchoSettings,
	) => DeliveryEngine;
	createClient?: (
		settings: HonchoSettings,
		apiKey: string | undefined,
	) => HonchoClient;
}

/** The missing-API-key notice fires once per process, not per event. */
let missingKeyWarned = false;

function warnMissingKeyOnce(): void {
	if (missingKeyWarned) return;
	missingKeyWarned = true;
	console.warn(
		"memory-honcho: no API key (secrets 'api-key' or SIGRUN_EXT_MEMORY_HONCHO_API_KEY) — capturing to the outbox without delivery",
	);
}

/**
 * Structural equality over the resolved settings (an engine rebuild is
 * warranted only when an actual value changed, not on a fresh object).
 */
function settingsEqual(a: HonchoSettings, b: HonchoSettings): boolean {
	return (
		a.agentPeerId === b.agentPeerId &&
		a.baseUrl === b.baseUrl &&
		a.workspaceId === b.workspaceId &&
		a.contextTokens === b.contextTokens &&
		a.maxMessageLength === b.maxMessageLength &&
		a.searchLimit === b.searchLimit &&
		a.toolPreviewLength === b.toolPreviewLength &&
		a.representationTtlMs === b.representationTtlMs &&
		a.outboxRetentionDays === b.outboxRetentionDays &&
		a.deliveredBatchWindow === b.deliveredBatchWindow &&
		a.anchorWindow === b.anchorWindow
	);
}

export function createHonchoMemory(
	host: SigrunHost,
	deps: FactoryDeps = {},
): SigrunExtensionResultLike {
	const settingsStore: SettingsReader = host.stores.settings;
	const secretsStore: SecretsReader = host.stores.secrets;
	const paths: StorePaths = host.stores.paths;

	// Lazily constructed on first use — settings/key are resolved at that
	// moment, so configuration written after boot still applies.
	let storesPromise: Promise<ExtensionStores> | undefined;
	let enginePromise: Promise<DeliveryEngine> | undefined;
	// The configuration the cached engine was built with: it is reused ONLY
	// while both are unchanged (stored wins without restart — the key can
	// arrive after boot).
	let engineKey: string | undefined;
	let engineSettings: HonchoSettings | undefined;

	function makeClient(
		settings: HonchoSettings,
		apiKey: string | undefined,
	): HonchoClient {
		return (deps.createClient ?? ((s, key) => new HonchoClient(s, key)))(
			settings,
			apiKey,
		);
	}

	function stores(): Promise<ExtensionStores> {
		storesPromise ??= resolveSettings(settingsStore).then(
			(settings) => new ExtensionStores(paths, settings),
		);
		return storesPromise;
	}

	async function engine(): Promise<DeliveryEngine> {
		// Resolve FIRST, cache-compare second: a key/settings change rebuilds.
		const settings = await resolveSettings(settingsStore);
		const apiKey = await resolveApiKey(secretsStore);
		if (
			enginePromise !== undefined &&
			apiKey === engineKey &&
			engineSettings !== undefined &&
			settingsEqual(settings, engineSettings)
		) {
			return enginePromise;
		}
		const building = (async () => {
			const client = makeClient(settings, apiKey);
			return (deps.createEngine ?? ((c, st, s) => new DeliveryEngine(c, st, s)))(
				client,
				await stores(),
				settings,
			);
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
	const selectionMemo = new Map<number, boolean>();

	async function isSelected(
		conversationId: number,
		api: MemoryEventApi,
		context: HandlerContext,
	): Promise<boolean> {
		const memoized = selectionMemo.get(conversationId);
		if (memoized !== undefined) return memoized;
		const agent = await api.document(
			AgentDoc,
			// SAFETY: the seam's event carries plain numbers; branded ids are
			// structurally identical (src/types.ts), so the value the host
			// passes satisfies both spellings.
			conversationId as unknown as ConversationId,
			context,
		);
		// Array form selects exactly its members; the object form edits the
		// host default (a `remove` of us is a no-op — we are not host-default).
		const selected =
			!Array.isArray(agent?.extensions) ||
			agent.extensions.includes(EXTENSION_NAME);
		if (selected) selectionMemo.set(conversationId, true);
		return selected;
	}

	const workerStatus = new Map<string, WorkerRunStatus>([
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
			tasks: [
				// The outbox sweeper (fired by the outbox-sweep cron job below).
				createSweepTask({ engine, stores, settings: () => resolveSettings(settingsStore) }),
			],
		}),

		workerStatus,

		async runSettled(event, api, context) {
			const settings = await resolveSettings(settingsStore);
			const owner = event.owner ?? "user";
			const record = buildCaptureBatch(
				event as RunSettledEventLike,
				owner,
				settings.maxMessageLength,
			);
			if (record === undefined) return;

			if (!(await isSelected(event.conversationId, api, context))) return;

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
			await makeClient(settings, apiKey).drainAll(DRAIN_DEADLINE_MS);
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
						if (status !== undefined) status.endedAt = Date.now();
					} catch (error) {
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
				handler: async () =>
					new Response("memory-honcho: status stub\n", { status: 200 }),
			},
		],

		userDeleted(event) {
			// Departure notice only — no data movement (Task 11 pins it).
			console.info(
				`memory-honcho: user "${event.user}" deleted (resources transferred to "${event.transferTo}")`,
			);
		},
	};
}

export default createHonchoMemory;
