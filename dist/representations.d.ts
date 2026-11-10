/**
 * The representation cache and the prompt sections that render it.
 *
 * `refreshRepresentation` is the WRITER: inside the conversation's
 * serialization chain it asks the established Honcho session for its
 * curated context (summary + the user peer's representation, as seen by
 * the agent peer) and writes the snapshot to
 * `cache/representations/<conversationId>.json` — the SDK's
 * `peerRepresentation` / `summary.content` fields normalized into the
 * cache's `userProfile` / `projectSummary` names.
 *
 * `renderMemorySection` is the READER: SYNCHRONOUS (the prompt-section
 * render posture), reading the ledger and cache straight off disk. A
 * conversation with no ledger (never captured) renders nothing; a
 * ledgered conversation with no cache file yet (refresh still pending)
 * renders nothing; a stale-beyond-TTL cache renders its LAST snapshot
 * anyway (last-good — only ABSENT renders nothing). A snapshot with both
 * parts null renders nothing.
 */
import type { HonchoSettings } from "./settings-schema.js";
import type { HonchoClient } from "./honcho.js";
import type { ExtensionStores } from "./stores.js";
/**
 * Refresh the conversation's cached representation snapshot.
 *
 * Runs INSIDE the conversation's chain (`client.for(id).chain`), so the
 * `context()` call is serialized with delivery and establishment (the
 * spec's one-chain-per-conversation rule). The owner resolves the user
 * peer whose representation is fetched; callers pass the ledger's
 * `ownerAtFirstCapture`.
 */
export declare function refreshRepresentation(client: HonchoClient, stores: ExtensionStores, settings: HonchoSettings, conversationId: number, owner: string): Promise<void>;
/**
 * Render the `[Persistent memory]` prompt section for a conversation.
 *
 * Sync reads only (see the module comment). `now` is the caller's clock,
 * kept as a parameter so staleness is decided against an explicit
 * instant; the current posture renders the last snapshot regardless of
 * age (last-good), so `now` is reserved for the TTL comparison and does
 * not gate output.
 */
export declare function renderMemorySection(stores: ExtensionStores, conversationId: number, now: number): string | undefined;
