/**
 * Honcho client wrapper.
 *
 * Owns the SDK instance (constructed lazily — no network at construction,
 * each Peer/Session object performs its get-or-create HTTP call on first
 * use and is memoized after), the per-conversation ConversationClients,
 * and the shutdown drain over every conversation's serialization chain.
 */
import { type Peer, type Session } from "@honcho-ai/sdk";
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
export type CreateSdk = (settings: HonchoSettings, apiKey: string | undefined) => HonchoSdk;
/** Map an arbitrary name to a valid Honcho peer/session id. */
export declare function sanitize(name: string): string;
/**
 * Per-conversation handle: its own serial chain plus the established
 * Honcho session (set by the establish flow in a later task).
 */
export declare class ConversationClient {
    #private;
    /** Run work serialized with all other work for this conversation. */
    readonly chain: <T>(work: () => Promise<T>) => Promise<T>;
    constructor(conversationId: string);
    /**
     * The established Honcho session for this conversation. Throws until
     * the establish flow has run (Task 4 wires `markEstablished`).
     */
    established(): Promise<Session>;
    /** Internal: record the establish promise (used by Task 4). */
    markEstablished(session: Promise<Session>): void;
}
export declare class HonchoClient {
    #private;
    constructor(settings: HonchoSettings, apiKey: string | undefined, createSdk?: CreateSdk);
    /** Get-or-create a peer by id, memoized. */
    peer(id: string): Promise<Peer>;
    /** The per-conversation client, memoized. */
    for(conversationId: string): ConversationClient;
    /** The peer for a conversation owner; ownerless conversations map to "user". */
    userPeerFor(owner: string | undefined): Promise<Peer>;
    /** The agent's own peer (settings.agentPeerId). */
    agentPeer(): Promise<Peer>;
    /**
     * Wait for every live chain to settle, giving up after `deadlineMs`.
     * The drain hook `harnessShutdown` awaits.
     */
    drainAll(deadlineMs: number): Promise<void>;
}
