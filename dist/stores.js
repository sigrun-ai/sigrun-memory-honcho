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
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
/**
 * The module-level outbox tail: every `withOutbox` caller queues behind the
 * previous one, so a rewrite can never lose a concurrent append. The tail
 * never rejects (a failing caller settles for ITS caller, the next queued
 * work still runs).
 */
let outboxTail = Promise.resolve();
export class ExtensionStores {
    #paths;
    #anchorWindow;
    #deliveredBatchWindow;
    constructor(paths, settings) {
        this.#paths = paths;
        this.#anchorWindow = settings.anchorWindow;
        this.#deliveredBatchWindow = settings.deliveredBatchWindow;
    }
    /**
     * Run `work` holding the outbox mutex. The caller's promise settles with
     * the work's own result (rejection included); the internal tail is
     * self-catching so one failing caller cannot poison the queue.
     */
    async withOutbox(work) {
        const previous = outboxTail;
        let release;
        outboxTail = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        }
        finally {
            release();
        }
    }
    // -- ledger (state) -------------------------------------------------------
    async readLedger(conversationId) {
        return readJson(this.#ledgerPath(conversationId));
    }
    readLedgerSync(conversationId) {
        return readJsonSync(this.#ledgerPath(conversationId));
    }
    async writeLedger(conversationId, ledger) {
        // Window bounds fold oldest-first on write (spec §ledger).
        const bounded = {
            ...ledger,
            deliveredBatchIds: ledger.deliveredBatchIds.slice(-this.#deliveredBatchWindow),
            anchors: ledger.anchors.slice(-this.#anchorWindow),
        };
        await writeJsonAtomic(this.#ledgerPath(conversationId), bounded);
    }
    // -- outbox (data) --------------------------------------------------------
    /**
     * Read every outbox record in file order. For anything other than a
     * display-only read, call inside `withOutbox` (see the module comment).
     */
    async readOutbox() {
        let raw;
        try {
            raw = await readFile(this.#outboxPath(), "utf8");
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw error;
        }
        return raw
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line));
    }
    /** Append one record (one JSONL line). Call inside `withOutbox`. */
    async appendOutboxRecord(record) {
        const path = this.#outboxPath();
        await mkdir(dirname(path), { recursive: true });
        const file = await open(path, "a");
        try {
            await file.appendFile(JSON.stringify(record) + "\n", "utf8");
        }
        finally {
            await file.close();
        }
    }
    /** Replace the outbox (atomic). Call inside `withOutbox`. */
    async rewriteOutbox(records) {
        await writeTextAtomic(this.#outboxPath(), records.map((record) => JSON.stringify(record)).join("\n") +
            (records.length === 0 ? "" : "\n"));
    }
    // -- pending forks (state) ------------------------------------------------
    async readPendingFork(childId) {
        return readJson(this.#pendingForkPath(childId));
    }
    async writePendingFork(record) {
        await writeJsonAtomic(this.#pendingForkPath(record.childId), record);
    }
    /**
     * Stamp `resolvedAt` on the record (kept on disk, so a late duplicate
     * establish never re-clones). Returns the resolved record, or `undefined`
     * when no pending fork exists for the child.
     */
    async resolvePendingFork(childId) {
        const existing = await this.readPendingFork(childId);
        if (existing === undefined)
            return undefined;
        const resolved = { ...existing, resolvedAt: Date.now() };
        await this.writePendingFork(resolved);
        return resolved;
    }
    // -- representations (cache) ----------------------------------------------
    readRepresentationSync(conversationId) {
        return readJsonSync(this.#representationPath(conversationId));
    }
    async writeRepresentation(conversationId, snapshot) {
        await writeJsonAtomic(this.#representationPath(conversationId), snapshot);
    }
    // -- paths ------------------------------------------------------------------
    #ledgerPath(conversationId) {
        return join(this.#paths.state, "ledger", `${conversationId}.json`);
    }
    #outboxPath() {
        return join(this.#paths.data, "outbox", "capture.jsonl");
    }
    #pendingForkPath(childId) {
        return join(this.#paths.state, "forks", "pending", `${childId}.json`);
    }
    #representationPath(conversationId) {
        return join(this.#paths.cache, "representations", `${conversationId}.json`);
    }
}
function isNotFound(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT");
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (isNotFound(error))
            return undefined;
        throw error;
    }
}
function readJsonSync(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        if (isNotFound(error))
            return undefined;
        throw error;
    }
}
/** Atomic JSON write: temp file in the same directory, then rename. */
async function writeJsonAtomic(path, value) {
    await writeTextAtomic(path, JSON.stringify(value));
}
async function writeTextAtomic(path, content) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
}
