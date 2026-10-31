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
import { pickCloneAnchor } from "./fork-rules.js";
/** The session configuration applied on get-or-create AND on clones. */
const SESSION_CONFIGURATION = {
    summary: { enabled: true },
    dream: { enabled: true },
};
export class DeliveryEngine {
    #client;
    #stores;
    #settings;
    #hooks;
    constructor(client, stores, settings, hooks = {}) {
        this.#client = client;
        this.#stores = stores;
        this.#settings = settings;
        this.#hooks = hooks;
    }
    /**
     * Establish the conversation's Honcho session: plain get-or-create, or
     * a clone-with-mapping when a pending-fork record points at a parent
     * ledger with a usable anchor. Idempotent (chain-serialized).
     */
    establish(conversationId, owner) {
        return this.#client
            .for(String(conversationId))
            .chain(() => this.#establishLocked(conversationId, owner));
    }
    /**
     * The establish body, WITHOUT chain acquisition — call it only from
     * inside the conversation's chain (`establish`, or `deliverPending`'s
     * establish-on-miss). Calling the public `establish` from inside the
     * chain re-enters `chain("conversation:<id>")` and deadlocks (the
     * inner run queues behind the outer one it awaits).
     */
    async #establishLocked(conversationId, owner) {
        {
            const conversation = this.#client.for(String(conversationId));
            const existing = await this.#stores.readLedger(conversationId);
            if (existing?.honchoSessionId !== undefined) {
                conversation.markEstablished(this.#client.session(existing.honchoSessionId));
                return;
            }
            const pendingFork = await this.#stores.readPendingFork(conversationId);
            if (pendingFork !== undefined && pendingFork.resolvedAt === undefined) {
                // The parent id is on the record; no event api needed.
                const parentLedger = await this.#stores.readLedger(pendingFork.parentId);
                if (parentLedger?.honchoSessionId !== undefined) {
                    const parent = await this.#client.session(parentLedger.honchoSessionId);
                    const decision = pickCloneAnchor(parentLedger.anchors, pendingFork.at);
                    if (decision.kind === "clone") {
                        const cloned = await parent.clone(decision.messageId);
                        await cloned.setConfiguration(SESSION_CONFIGURATION);
                        await this.#stores.writeLedger(conversationId, {
                            conversationId,
                            honchoSessionId: cloned.id,
                            clonedFrom: pendingFork.parentId,
                            ownerAtFirstCapture: owner,
                            deliveredBatchIds: [],
                            anchors: [],
                        });
                        await this.#stores.resolvePendingFork(conversationId);
                        conversation.markEstablished(Promise.resolve(cloned));
                        return;
                    }
                    const session = await this.#getOrCreate(conversationId, owner);
                    await this.#stores.writeLedger(conversationId, {
                        conversationId,
                        honchoSessionId: session.id,
                        clonedFrom: pendingFork.parentId,
                        inherit: decision.inherit,
                        ownerAtFirstCapture: owner,
                        deliveredBatchIds: [],
                        anchors: [],
                    });
                    await this.#stores.resolvePendingFork(conversationId);
                    conversation.markEstablished(Promise.resolve(session));
                    return;
                }
                // No parent ledger entry (parent never captured): there is
                // nothing to inherit, so the record can never become resolvable —
                // resolve it now rather than leave it to trip the sweeper's
                // fork-first pass every 15 minutes, then fall through to the
                // plain get-or-create.
                await this.#stores.resolvePendingFork(conversationId);
            }
            const session = await this.#getOrCreate(conversationId, owner);
            await this.#stores.writeLedger(conversationId, {
                conversationId,
                honchoSessionId: session.id,
                ownerAtFirstCapture: owner,
                deliveredBatchIds: [],
                anchors: [],
            });
            conversation.markEstablished(Promise.resolve(session));
        }
    }
    /**
     * Deliver this conversation's pending outbox records, oldest first.
     * Delivered batches flip status, fold their batchId into the ledger's
     * delivered window, and fold a fork anchor ONLY when an agent entry was
     * in the batch — keyed by THAT agent entry's returned `Message.id`
     * (unanswered and user-only batches fold no anchor).
     */
    async deliverPending(conversationId, owner) {
        // Whether this pass flipped at least one batch. Read AFTER the chain
        // settles: the `onDelivered` hook runs OUT of the chain callback —
        // hook implementations (the factory's leading-edge refresh) re-enter
        // `chain("conversation:<id>")` on this same label, so calling the
        // hook inside the callback is a circular wait (the outer run awaits
        // the hook, which queues behind the tail the outer run must settle).
        let delivered = false;
        await this.#client.for(String(conversationId)).chain(async () => {
            const conversation = this.#client.for(String(conversationId));
            // Establish on miss: a rebuilt client (key/settings change) loses
            // its in-memory session marks while the LEDGER survives — a re-read
            // drives re-establishment (Task-5 review forward hazard; the
            // sweeper's normal path on a fresh process lands here too). A
            // rejected mark (a failed get-or-create) is treated as missing.
            // When the ledger is absent too, no caller established this
            // conversation — keep the loud "not established" failure rather
            // than silently creating a session. `#establishLocked` directly:
            // we are INSIDE the chain; re-entering it would deadlock.
            const marked = conversation.hasSession()
                ? await conversation.established().then(() => true, () => false)
                : false;
            if (!marked &&
                (await this.#stores.readLedger(conversationId)) !== undefined) {
                await this.#establishLocked(conversationId, owner);
            }
            const session = await conversation.established();
            const userPeer = await this.#client.userPeerFor(owner);
            const agentPeer = await this.#client.agentPeer();
            await this.#stores.withOutbox(async () => {
                const records = await this.#stores.readOutbox();
                const mine = records.filter((record) => record.conversationId === conversationId);
                if (mine.length === 0)
                    return;
                let ledger = await this.#stores.readLedger(conversationId);
                if (ledger === undefined)
                    return;
                // Delivered-set = the ledger's window plus every batchId sent in
                // this pass: a re-queued copy of an already-delivered batchId is
                // skipped, never re-sent.
                const seen = new Set(ledger.deliveredBatchIds);
                let flipped = false;
                for (const record of mine) {
                    if (record.status === "delivered" || seen.has(record.batchId)) {
                        continue;
                    }
                    const messages = record.entries.map((entry) => {
                        const peer = entry.peer === "agent" ? agentPeer : userPeer;
                        return peer.message(entry.text, { metadata: entry.metadata });
                    });
                    const sent = await session.addMessages(messages);
                    seen.add(record.batchId);
                    if (this.#hooks.failAfterSend === true) {
                        // The accepted crash window: the send landed, the ledger never
                        // learned — the next pass re-sends (documented duplicate).
                        continue;
                    }
                    ledger = fold(ledger, record, sent);
                    flipped = true;
                }
                if (!flipped)
                    return;
                await this.#stores.writeLedger(conversationId, ledger);
                const rewritten = records.map((record) => record.conversationId === conversationId &&
                    record.status === "pending" &&
                    seen.has(record.batchId) &&
                    this.#hooks.failAfterSend !== true
                    ? { ...record, status: "delivered" }
                    : record);
                await this.#stores.rewriteOutbox(rewritten);
                delivered = true;
            });
        });
        // Out of the chain (see the declaration above): the hook's own work
        // (a representation refresh) chains behind the delivery that just
        // settled, never behind itself.
        if (delivered)
            await this.#hooks.onDelivered?.(conversationId);
    }
    /**
     * Fire-and-forget delivery (the capture path's posture): self-catching,
     * logs rather than rejecting. Establishment is LAZY (spec §Capture: the
     * capture path runs the establishment path inside the fire-and-forget
     * attempt) — `establish` inside the attempt is chain-serialized ahead of
     * the delivery, is a no-op when the conversation is already established,
     * and re-marks a rebuilt client that lost its in-memory session promise.
     */
    kick(conversationId, owner) {
        void this.establish(conversationId, owner)
            .then(() => this.deliverPending(conversationId, owner))
            .catch((error) => {
            console.error(`memory-honcho: delivery kick failed for conversation ${conversationId}`, error);
        });
    }
    /** Get-or-create `sigrun-<id>` with the map-form observe config. */
    async #getOrCreate(conversationId, owner) {
        const session = await this.#client.session(`sigrun-${conversationId}`);
        const userPeer = await this.#client.userPeerFor(owner);
        const agentPeer = await this.#client.agentPeer();
        // The SDK's map form carries the per-peer observation config (the
        // array form carries none).
        const peers = {
            [userPeer.id]: { observeMe: true, observeOthers: true },
            [agentPeer.id]: { observeMe: true, observeOthers: true },
        };
        // SAFETY: the runtime accepts the map form (the SDK docs and its own
        // PeerAdditionToApiSchema zod union include it); only the declared
        // PeerAddition type predates it.
        await session.addPeers(peers);
        await session.setConfiguration(SESSION_CONFIGURATION);
        return session;
    }
}
/** Flip one record's bookkeeping into the ledger (batchId + optional anchor). */
function fold(ledger, record, sent) {
    const anchors = [...ledger.anchors];
    const agentIndex = record.entries.findIndex((entry) => entry.peer === "agent");
    const agentMessage = agentIndex >= 0 ? sent[agentIndex] : undefined;
    if (record.answerEntryId !== undefined && agentMessage !== undefined) {
        anchors.push({ entryId: record.answerEntryId, messageId: agentMessage.id });
    }
    return {
        ...ledger,
        deliveredBatchIds: [...ledger.deliveredBatchIds, record.batchId],
        anchors,
    };
}
