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
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { HonchoSettings } from "./config.js";
import type {
	Ledger,
	OutboxRecord,
	PendingForkRecord,
	RepresentationSnapshot,
} from "./types.js";

/** The three store roots, exactly `host.stores.paths`' shape. */
export interface StorePaths {
	readonly data: string;
	readonly state: string;
	readonly cache: string;
}

/**
 * The module-level outbox tail: every `withOutbox` caller queues behind the
 * previous one, so a rewrite can never lose a concurrent append. The tail
 * never rejects (a failing caller settles for ITS caller, the next queued
 * work still runs).
 */
let outboxTail: Promise<unknown> = Promise.resolve();

export class ExtensionStores {
	readonly #paths: StorePaths;
	readonly #anchorWindow: number;
	readonly #deliveredBatchWindow: number;

	constructor(paths: StorePaths, settings: HonchoSettings) {
		this.#paths = paths;
		this.#anchorWindow = settings.anchorWindow;
		this.#deliveredBatchWindow = settings.deliveredBatchWindow;
	}

	/**
	 * Run `work` holding the outbox mutex. The caller's promise settles with
	 * the work's own result (rejection included); the internal tail is
	 * self-catching so one failing caller cannot poison the queue.
	 * NOT re-entrant: do not call `withOutbox` from within `work`.
	 */
	async withOutbox<T>(work: () => Promise<T>): Promise<T> {
		const previous = outboxTail;
		let release!: () => void;
		outboxTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	}

	// -- ledger (state) -------------------------------------------------------

	async readLedger(conversationId: number): Promise<Ledger | undefined> {
		return readJson<Ledger>(this.#ledgerPath(conversationId));
	}

	/** Every ledger on disk (status/observability reads; missing dir → []). */
	async readLedgers(): Promise<Ledger[]> {
		return readJsonDir<Ledger>(join(this.#paths.state, "ledger"));
	}

	readLedgerSync(conversationId: number): Ledger | undefined {
		return readJsonSync<Ledger>(this.#ledgerPath(conversationId));
	}

	async writeLedger(conversationId: number, ledger: Ledger): Promise<void> {
		// Window bounds fold oldest-first on write (spec §ledger).
		const bounded: Ledger = {
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
	async readOutbox(): Promise<OutboxRecord[]> {
		let raw: string;
		try {
			raw = await readFile(this.#outboxPath(), "utf8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		return raw
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as OutboxRecord);
	}

	/** Append one record (one JSONL line). Call inside `withOutbox`. */
	async appendOutboxRecord(record: OutboxRecord): Promise<void> {
		const path = this.#outboxPath();
		await mkdir(dirname(path), { recursive: true });
		const file = await open(path, "a");
		try {
			await file.appendFile(JSON.stringify(record) + "\n", "utf8");
		} finally {
			await file.close();
		}
	}

	/** Replace the outbox (atomic). Call inside `withOutbox`. */
	async rewriteOutbox(records: OutboxRecord[]): Promise<void> {
		await writeTextAtomic(
			this.#outboxPath(),
			records.map((record) => JSON.stringify(record)).join("\n") +
				(records.length === 0 ? "" : "\n"),
		);
	}

	// -- pending forks (state) ------------------------------------------------

	async readPendingFork(childId: number): Promise<PendingForkRecord | undefined> {
		return readJson<PendingForkRecord>(this.#pendingForkPath(childId));
	}

	/**
	 * Every pending-fork record on disk, resolved ones included (they are
	 * kept stamped so a late duplicate establish never re-clones; callers
	 * wanting the still-pending count filter on `resolvedAt`).
	 */
	async readPendingForks(): Promise<PendingForkRecord[]> {
		return readJsonDir<PendingForkRecord>(
			join(this.#paths.state, "forks", "pending"),
		);
	}

	async writePendingFork(record: PendingForkRecord): Promise<void> {
		await writeJsonAtomic(this.#pendingForkPath(record.childId), record);
	}

	/**
	 * Stamp `resolvedAt` on the record (kept on disk, so a late duplicate
	 * establish never re-clones). Returns the resolved record, or `undefined`
	 * when no pending fork exists for the child.
	 */
	async resolvePendingFork(childId: number): Promise<PendingForkRecord | undefined> {
		const existing = await this.readPendingFork(childId);
		if (existing === undefined) return undefined;
		const resolved: PendingForkRecord = { ...existing, resolvedAt: Date.now() };
		await this.writePendingFork(resolved);
		return resolved;
	}

	// -- representations (cache) ----------------------------------------------

	readRepresentationSync(
		conversationId: number,
	): RepresentationSnapshot | undefined {
		return readJsonSync<RepresentationSnapshot>(
			this.#representationPath(conversationId),
		);
	}

	async writeRepresentation(
		conversationId: number,
		snapshot: RepresentationSnapshot,
	): Promise<void> {
		await writeJsonAtomic(this.#representationPath(conversationId), snapshot);
	}

	// -- paths ------------------------------------------------------------------

	#ledgerPath(conversationId: number): string {
		return join(this.#paths.state, "ledger", `${conversationId}.json`);
	}

	#outboxPath(): string {
		return join(this.#paths.data, "outbox", "capture.jsonl");
	}

	#pendingForkPath(childId: number): string {
		return join(this.#paths.state, "forks", "pending", `${childId}.json`);
	}

	#representationPath(conversationId: number): string {
		return join(this.#paths.cache, "representations", `${conversationId}.json`);
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

/** Parse every `*.json` file in a directory; a missing directory is empty. */
async function readJsonDir<T>(dir: string): Promise<T[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const values: T[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		values.push(JSON.parse(await readFile(join(dir, name), "utf8")) as T);
	}
	return values;
}

function readJsonSync<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

/** Atomic JSON write: temp file in the same directory, then rename. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeTextAtomic(path, JSON.stringify(value));
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const temp = join(
		dir,
		`.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
}
