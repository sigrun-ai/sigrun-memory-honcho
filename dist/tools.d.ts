/**
 * The three recall tools: `honcho_search`, `honcho_chat`, `honcho_remember`.
 *
 * All three:
 * - resolve the calling conversation's owner from `host.conversations.meta`
 *   (memoized in-process per conversation; ownerless conversations → `"user"`);
 * - await `engine.establish(conversationId, owner)` first (the spec's second
 *   clone trigger — a rebuilt client re-establishes from the ledger);
 * - convert Honcho failures to `memory-honcho: Honcho unavailable (<message>)`.
 *
 * `honcho_remember` passes NO `sessionId` in v1: a remembered fact is a
 * user-level conclusion, matching the cross-conversation recall ruling.
 * The README documents the visibility caveat.
 */
import { type ToolRegistration } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { HonchoSettings } from "./config.js";
import type { DeliveryEngine } from "./delivery.js";
import type { HonchoClient } from "./honcho.js";
/** Structural slice of `host.conversations.meta` the tools read. */
interface MetaReader {
    meta(id: ConversationId): Promise<{
        owner?: string;
    }>;
}
/**
 * Test seam: the factory wires the real accessors; tests inject fakes.
 * The accessors are functions (not the values themselves) because the
 * engine/client are lazily constructed and rebuilt on settings/key change.
 */
export interface ToolsDeps {
    readonly host: {
        conversations: MetaReader;
    };
    readonly client: () => HonchoClient | undefined;
    readonly engine: () => Promise<DeliveryEngine>;
    readonly settings: () => HonchoSettings | undefined;
}
/** Build the three recall tools. */
export declare function createTools(deps: ToolsDeps): readonly ToolRegistration[];
export {};
