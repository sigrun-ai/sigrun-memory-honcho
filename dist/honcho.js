/**
 * Honcho client wrapper.
 *
 * Owns the SDK instance (constructed lazily — no network at construction,
 * each Peer/Session object performs its get-or-create HTTP call on first
 * use and is memoized after), the per-conversation ConversationClients,
 * and the shutdown drain over every conversation's serialization chain.
 */
import { Honcho } from "@honcho-ai/sdk";
import { chain, chainTails } from "./chains.js";
const defaultCreateSdk = (settings, apiKey) => {
    const config = {
        workspaceId: settings.workspaceId,
    };
    // Omit rather than pass undefined so the SDK's own env/default
    // resolution still applies.
    if (apiKey !== undefined)
        config.apiKey = apiKey;
    if (settings.baseUrl !== undefined)
        config.baseURL = settings.baseUrl;
    return new Honcho(config);
};
/** Map an arbitrary name to a valid Honcho peer/session id. */
export function sanitize(name) {
    const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return cleaned === "" ? "_" : cleaned;
}
/**
 * Per-conversation handle: its own serial chain plus the established
 * Honcho session (set by the establish flow in a later task).
 */
export class ConversationClient {
    /** Run work serialized with all other work for this conversation. */
    chain;
    #sessionPromise;
    constructor(conversationId) {
        this.chain = (work) => chain(`conversation:${conversationId}`, work);
    }
    /**
     * The established Honcho session for this conversation. Throws until
     * the establish flow has run (Task 4 wires `markEstablished`).
     */
    established() {
        if (this.#sessionPromise === undefined) {
            return Promise.reject(new Error("memory-honcho: session not established"));
        }
        return this.#sessionPromise;
    }
    /** Internal: record the establish promise (used by Task 4). */
    markEstablished(session) {
        this.#sessionPromise = session;
    }
}
export class HonchoClient {
    #settings;
    #sdk;
    #createSdk;
    #apiKey;
    #peers = new Map();
    #conversations = new Map();
    constructor(settings, apiKey, createSdk = defaultCreateSdk) {
        this.#settings = settings;
        this.#apiKey = apiKey;
        this.#createSdk = createSdk;
    }
    get #client() {
        this.#sdk ??= this.#createSdk(this.#settings, this.#apiKey);
        return this.#sdk;
    }
    /** Get-or-create a peer by id, memoized. */
    peer(id) {
        const existing = this.#peers.get(id);
        if (existing !== undefined)
            return existing;
        const created = this.#client.peer(id);
        this.#peers.set(id, created);
        return created;
    }
    /** The per-conversation client, memoized. */
    for(conversationId) {
        const existing = this.#conversations.get(conversationId);
        if (existing !== undefined)
            return existing;
        const created = new ConversationClient(conversationId);
        this.#conversations.set(conversationId, created);
        return created;
    }
    /** The peer for a conversation owner; ownerless conversations map to "user". */
    userPeerFor(owner) {
        return this.peer(sanitize(owner ?? "user"));
    }
    /** The agent's own peer (settings.agentPeerId). */
    agentPeer() {
        return this.peer(this.#settings.agentPeerId);
    }
    /**
     * Wait for every live chain to settle, giving up after `deadlineMs`.
     * The drain hook `harnessShutdown` awaits.
     */
    async drainAll(deadlineMs) {
        // unref: a fast drain must not hold the event loop open until the deadline.
        await Promise.race([
            chainTails(),
            new Promise((resolve) => {
                const deadline = setTimeout(resolve, deadlineMs);
                deadline.unref();
            }),
        ]);
    }
}
