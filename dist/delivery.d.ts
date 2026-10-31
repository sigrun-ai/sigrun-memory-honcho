/**
 * The delivery engine: session establishment (with the fork clone rules)
 * and outbox delivery.
 *
 * Every public method runs inside the conversation's serialization chain
 * (`client.for(id).chain`) — the spec's one-chain-per-conversation rule,
 * so establishment and delivery never race and the double-clone race
 * cannot happen.
 *
 * `deliverPending` acquires the outbox mutex exactly once per flow
 * (`withOutbox` around the read → ledger flip → rewrite cycle); it never
 * nests a second `withOutbox` inside it (the mutex is not re-entrant),
 * and the sweeper (Task 7) calls it per conversation OUTSIDE any outbox
 * lock — lock acquisition lives in one place per flow.
 */
import type { HonchoSettings } from "./config.js";
import type { HonchoClient } from "./honcho.js";
import type { ExtensionStores } from "./stores.js";
export interface DeliveryHooks {
    /** Leading-edge hook (Task 8 injects the refresh kick); default no-op. */
    onDelivered?(conversationId: number): Promise<void> | void;
    /**
     * Test seam: deliver the batch but skip the ledger write — the accepted
     * crash window between a successful `addMessages` and the ledger flip,
     * whose cost is a re-sent (duplicate) batch on the next pass.
     */
    failAfterSend?: boolean;
}
export declare class DeliveryEngine {
    #private;
    constructor(client: HonchoClient, stores: ExtensionStores, settings: HonchoSettings, hooks?: DeliveryHooks);
    /**
     * Establish the conversation's Honcho session: plain get-or-create, or
     * a clone-with-mapping when a pending-fork record points at a parent
     * ledger with a usable anchor. Idempotent (chain-serialized).
     */
    establish(conversationId: number, owner: string): Promise<void>;
    /**
     * Deliver this conversation's pending outbox records, oldest first.
     * Delivered batches flip status, fold their batchId into the ledger's
     * delivered window, and fold a fork anchor ONLY when an agent entry was
     * in the batch — keyed by THAT agent entry's returned `Message.id`
     * (unanswered and user-only batches fold no anchor).
     */
    deliverPending(conversationId: number, owner: string): Promise<void>;
    /**
     * Fire-and-forget delivery (the capture path's posture): self-catching,
     * logs rather than rejecting. Establishment is LAZY (spec §Capture: the
     * capture path runs the establishment path inside the fire-and-forget
     * attempt) — `establish` inside the attempt is chain-serialized ahead of
     * the delivery, is a no-op when the conversation is already established,
     * and re-marks a rebuilt client that lost its in-memory session promise.
     */
    kick(conversationId: number, owner: string): void;
}
