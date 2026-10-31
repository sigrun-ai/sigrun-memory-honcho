/**
 * Honcho client wrapper.
 *
 * Owns the SDK instance (constructed lazily — no network at construction,
 * each Peer/Session object performs its get-or-create HTTP call on first
 * use and is memoized after), the per-conversation ConversationClients,
 * and the shutdown drain over every conversation's serialization chain.
 */

import { Honcho, type Peer, type Session } from "@honcho-ai/sdk";

import { chain, chainTails } from "./chains.js";
import type { HonchoSettings } from "./config.js";

/**
 * Structural slice of the SDK the client uses — fakes in tests implement
 * this instead of the real network client.
 */
export interface HonchoSdk {
	peer(id: string): Promise<Peer>;
	session(id: string): Promise<Session>;
}

/** Test seam: construct the SDK from resolved settings + api key. */
export type CreateSdk = (
	settings: HonchoSettings,
	apiKey: string | undefined,
) => HonchoSdk;

const defaultCreateSdk: CreateSdk = (settings, apiKey) => {
	const config: { apiKey?: string; baseURL?: string; workspaceId: string } = {
		workspaceId: settings.workspaceId,
	};
	// Omit rather than pass undefined so the SDK's own env/default
	// resolution still applies.
	if (apiKey !== undefined) config.apiKey = apiKey;
	if (settings.baseUrl !== undefined) config.baseURL = settings.baseUrl;
	return new Honcho(config);
};

/** Map an arbitrary name to a valid Honcho peer/session id. */
export function sanitize(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return cleaned === "" ? "_" : cleaned;
}

/**
 * Per-conversation handle: its own serial chain plus the established
 * Honcho session (set by the establish flow in a later task).
 */
export class ConversationClient {
	/** Run work serialized with all other work for this conversation. */
	readonly chain: <T>(work: () => Promise<T>) => Promise<T>;

	#sessionPromise: Promise<Session> | undefined;

	constructor(conversationId: string) {
		this.chain = (work) => chain(`conversation:${conversationId}`, work);
	}

	/**
	 * The established Honcho session for this conversation. Throws until
	 * the establish flow has run (Task 4 wires `markEstablished`).
	 */
	established(): Promise<Session> {
		if (this.#sessionPromise === undefined) {
			return Promise.reject(
				new Error("memory-honcho: session not established"),
			);
		}
		return this.#sessionPromise;
	}

	/** Internal: record the establish promise (used by Task 4). */
	markEstablished(session: Promise<Session>): void {
		this.#sessionPromise = session;
	}
}

export class HonchoClient {
	readonly #settings: HonchoSettings;
	#sdk: HonchoSdk | undefined;
	readonly #createSdk: CreateSdk;
	readonly #apiKey: string | undefined;
	readonly #peers = new Map<string, Promise<Peer>>();
	readonly #conversations = new Map<string, ConversationClient>();

	constructor(
		settings: HonchoSettings,
		apiKey: string | undefined,
		createSdk: CreateSdk = defaultCreateSdk,
	) {
		this.#settings = settings;
		this.#apiKey = apiKey;
		this.#createSdk = createSdk;
	}

	get #client(): HonchoSdk {
		this.#sdk ??= this.#createSdk(this.#settings, this.#apiKey);
		return this.#sdk;
	}

	/** Get-or-create a peer by id, memoized (rejections are NOT memoized: a
	 *  transient failure must not stick — the outbox retry story depends on it). */
	peer(id: string): Promise<Peer> {
		const existing = this.#peers.get(id);
		if (existing !== undefined) return existing;
		const created = this.#client.peer(id);
		this.#peers.set(id, created);
		created.catch(() => {
			if (this.#peers.get(id) === created) this.#peers.delete(id);
		});
		return created;
	}

	/** The per-conversation client, memoized. */
	for(conversationId: string): ConversationClient {
		const existing = this.#conversations.get(conversationId);
		if (existing !== undefined) return existing;
		const created = new ConversationClient(conversationId);
		this.#conversations.set(conversationId, created);
		return created;
	}

	/** The peer for a conversation owner; ownerless conversations map to "user". */
	userPeerFor(owner: string | undefined): Promise<Peer> {
		return this.peer(sanitize(owner ?? "user"));
	}

	/** The agent's own peer (settings.agentPeerId). */
	agentPeer(): Promise<Peer> {
		return this.peer(this.#settings.agentPeerId);
	}

	/**
	 * Wait for every live chain to settle, giving up after `deadlineMs`.
	 * The drain hook `harnessShutdown` awaits.
	 */
	async drainAll(deadlineMs: number): Promise<void> {
		// unref: a fast drain must not hold the event loop open until the deadline.
		await Promise.race([
			chainTails(),
			new Promise<void>((resolve) => {
				const deadline = setTimeout(resolve, deadlineMs);
				deadline.unref();
			}),
		]);
	}
}
