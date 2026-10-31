/**
 * The memory-seam contract restated structurally.
 *
 * `RunSettledEventLike` and `MemoryEventApiLike` mirror the host contract
 * (sigrun `src/harness/event-bus.ts` / `src/extension.ts`) — declared
 * structurally, with NO core runtime import, so this module compiles against
 * the `@sigrun/sigrun` devDependency's types without pinning a release.
 * The host passes real values; anything satisfying these shapes works.
 */

/**
 * The settled-run event as the handler consumes it: ids as plain numbers
 * (pi-durable ids are branded numbers — structurally identical), and the
 * answered outcome's `answer` narrowed to the one member the capture path
 * reads (`content` blocks with `type`/`text` — the real `AssistantMessage`
 * satisfies this).
 */
export type RunSettledEventLike = {
	readonly conversationId: number;
	/** The conversation owner at delivery; absent when the conversation is ownerless. */
	readonly owner?: string;
	readonly inputs: readonly number[];
	readonly inputTexts: readonly string[];
	readonly outcome:
		| {
				readonly status: "answered";
				readonly answerEntryId: number;
				readonly answer: {
					readonly content: readonly {
						readonly type: string;
						readonly text?: string;
					}[];
				};
		  }
		| { readonly status: "unanswered"; readonly reason: string };
};

/**
 * The narrowed read surface a `runSettled` handler receives (the host's
 * `MemoryEventApi`). Only `document` is typed concretely here — Task 5's
 * selection gate is the only consumer; `entry`/`entries` are declared as
 * unknown-typed members so fakes can implement the full contract without
 * restating pi-durable's query/page generics.
 */
export type MemoryEventApiLike = {
	readonly entry: unknown;
	readonly entries: unknown;
	document<T>(
		token: unknown,
		conversationId: number,
		context: unknown,
	): Promise<Readonly<T> | undefined>;
};

// ---------------------------------------------------------------------------
// The extension's own on-disk records (spec: Capture §outbox, §ledger, §forks)
// ---------------------------------------------------------------------------

/** One message inside a capture batch: the peer side, the text, and the batch-level metadata. */
export type OutboxEntry = {
	readonly peer: "user" | "agent";
	readonly text: string;
	readonly metadata: {
		readonly conversationId: number;
		readonly submissionIds: readonly number[];
		readonly batchId: string;
		/** Present on user entries of UNANSWERED runs. */
		readonly unanswered?: true;
	};
};

/** One capture batch, JSONL-appended to `data/outbox/capture.jsonl`. */
export type OutboxRecord = {
	readonly type: "capture";
	readonly conversationId: number;
	/** The resolved owner for this capture (`"user"` when the conversation is ownerless). */
	readonly owner: string;
	/** The run's answer anchor; set only for answered runs. */
	readonly answerEntryId?: number;
	readonly entries: readonly OutboxEntry[];
	readonly batchId: string;
	readonly status: "pending" | "delivered";
	readonly createdAt: number;
};

/** One fork-mapping anchor: the run's `answerEntryId` → the Honcho message id delivery returned. */
export type LedgerAnchor = {
	readonly entryId: number;
	readonly messageId: string;
};

/**
 * Per-conversation bookkeeping, `state/ledger/<conversationId>.json`:
 * correctness-relevant but not user content. `deliveredBatchIds` and
 * `anchors` are bounded windows (folded oldest-first on write).
 */
export type Ledger = {
	readonly conversationId: number;
	readonly honchoSessionId?: string;
	readonly clonedFrom?: number;
	/** Why a fresh session was started instead of a clone ("none-window" / "none-empty"). */
	readonly inherit?: string;
	/** The owner resolved at the conversation's first captured run. */
	readonly ownerAtFirstCapture: string;
	readonly deliveredBatchIds: string[];
	readonly anchors: LedgerAnchor[];
};

/**
 * `state/forks/pending/<childId>.json`: written by `conversationForked`,
 * resolved on clone. Resolved records are kept (a `resolvedAt` stamp) so a
 * late, duplicate establish never re-clones.
 */
export type PendingForkRecord = {
	readonly childId: number;
	readonly parentId: number;
	/** The fork point (entry id in the parent). */
	readonly at: number;
	readonly createdAt: number;
	readonly resolvedAt?: number;
};

/**
 * The cached representation snapshot, `cache/representations/<conversationId>.json`
 * (SDK field names normalized: `peerRepresentation` → `userProfile`,
 * `summary.content` → `projectSummary`).
 */
export type RepresentationSnapshot = {
	readonly userProfile: string | null;
	readonly projectSummary: string | null;
	readonly fetchedAt: number;
};

/**
 * `state/last-delivery.json`: the persistent marker of the newest DELIVERY
 * (`at` = the delivered record's `createdAt`). The sweeper drops delivered
 * records every 15 minutes, so the status route cannot derive
 * `lastDeliveryAt` from retained records in steady state — the delivery
 * engine writes this marker when it flips a record, inside the same outbox
 * critical section as the flip (stores.ts / status.ts).
 */
export type LastDeliveryMarker = {
	readonly at: number;
};

/**
 * The worker-run bookkeeping the factory records and the status route
 * projects. The ONE declaration lives here: `src/index.ts` (writer) and
 * `src/status.ts` (reader) both alias it, so the two sides cannot drift.
 */
export type WorkerRunStatus = {
	runs: number;
	startedAt?: number;
	endedAt?: number;
	lastError?: string;
};
