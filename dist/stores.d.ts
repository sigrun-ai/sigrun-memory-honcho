/**
 * The extension's filesystem stores, rooted at `host.stores.paths`:
 *
 * - `data/outbox/capture.jsonl` — the durable outbox (the only durable copy
 *   of not-yet-delivered conversation content, so it takes the backed-up
 *   bucket), one JSON record per line in append order.
 * - `state/ledger/<conversationId>.json` — per-conversation bookkeeping
 *   (session mapping, delivered-batch window, fork anchors).
 * - `state/forks/pending/<childId>.json` — pending-fork records.
 * - `cache/representations/<conversationId>.json` — the representation
 *   snapshots the prompt section renders.
 *
 * `withOutbox` is a single MODULE-LEVEL mutex serializing every outbox
 * read-modify-write cycle across ALL conversations and ALL ExtensionStores
 * instances (the spec's serialization requirement: the sweeper's rewrite
 * must not lose a concurrent capture append). In-process only — a restart
 * loses in-flight work exactly as the outbox posture already accepts.
 *
 * All writes are atomic (temp file + rename in the same directory). The
 * `*Sync` reads use `readFileSync` because the prompt-section render is
 * synchronous (the spec'd cache-read posture).
 */
import type { HonchoSettings } from "./config.js";
import type { Ledger, OutboxRecord, PendingForkRecord, RepresentationSnapshot } from "./types.js";
/** The three store roots, exactly `host.stores.paths`' shape. */
export interface StorePaths {
    readonly data: string;
    readonly state: string;
    readonly cache: string;
}
export declare class ExtensionStores {
    #private;
    constructor(paths: StorePaths, settings: HonchoSettings);
    /**
     * Run `work` holding the outbox mutex. The caller's promise settles with
     * the work's own result (rejection included); the internal tail is
     * self-catching so one failing caller cannot poison the queue.
     * NOT re-entrant: do not call `withOutbox` from within `work`.
     */
    withOutbox<T>(work: () => Promise<T>): Promise<T>;
    readLedger(conversationId: number): Promise<Ledger | undefined>;
    readLedgerSync(conversationId: number): Ledger | undefined;
    writeLedger(conversationId: number, ledger: Ledger): Promise<void>;
    /**
     * Read every outbox record in file order. For anything other than a
     * display-only read, call inside `withOutbox` (see the module comment).
     */
    readOutbox(): Promise<OutboxRecord[]>;
    /** Append one record (one JSONL line). Call inside `withOutbox`. */
    appendOutboxRecord(record: OutboxRecord): Promise<void>;
    /** Replace the outbox (atomic). Call inside `withOutbox`. */
    rewriteOutbox(records: OutboxRecord[]): Promise<void>;
    readPendingFork(childId: number): Promise<PendingForkRecord | undefined>;
    writePendingFork(record: PendingForkRecord): Promise<void>;
    /**
     * Stamp `resolvedAt` on the record (kept on disk, so a late duplicate
     * establish never re-clones). Returns the resolved record, or `undefined`
     * when no pending fork exists for the child.
     */
    resolvePendingFork(childId: number): Promise<PendingForkRecord | undefined>;
    readRepresentationSync(conversationId: number): RepresentationSnapshot | undefined;
    writeRepresentation(conversationId: number, snapshot: RepresentationSnapshot): Promise<void>;
}
