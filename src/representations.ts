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

import type { HonchoSettings } from "./config.js";
import type { HonchoClient } from "./honcho.js";
import type { ExtensionStores } from "./stores.js";
import type { RepresentationSnapshot } from "./types.js";

const SECTION_HEADER = "[Persistent memory]";

/**
 * Refresh the conversation's cached representation snapshot.
 *
 * Runs INSIDE the conversation's chain (`client.for(id).chain`), so the
 * `context()` call is serialized with delivery and establishment (the
 * spec's one-chain-per-conversation rule). The owner resolves the user
 * peer whose representation is fetched; callers pass the ledger's
 * `ownerAtFirstCapture`.
 */
export async function refreshRepresentation(
	client: HonchoClient,
	stores: ExtensionStores,
	settings: HonchoSettings,
	conversationId: number,
	owner: string,
): Promise<void> {
	await client.for(String(conversationId)).chain(async () => {
		const conversation = client.for(String(conversationId));
		const session = await conversation.established();
		// Peer OBJECTS, exactly as Task 2's accessors return them — the SDK
		// accepts `string | Peer` here, and the peers resolve inside the
		// chain so a transient peer failure cannot stick.
		const [agentPeer, userPeer] = await Promise.all([
			client.agentPeer(),
			client.userPeerFor(owner),
		]);
		const context = await session.context({
			summary: true,
			peerPerspective: agentPeer,
			peerTarget: userPeer,
			tokens: settings.contextTokens,
		});
		const snapshot: RepresentationSnapshot = {
			userProfile: context.peerRepresentation ?? null,
			projectSummary: context.summary?.content ?? null,
			fetchedAt: Date.now(),
		};
		await stores.writeRepresentation(conversationId, snapshot);
	});
}

/**
 * Render the `[Persistent memory]` prompt section for a conversation.
 *
 * Sync reads only (see the module comment). `now` is the caller's clock,
 * kept as a parameter so staleness is decided against an explicit
 * instant; the current posture renders the last snapshot regardless of
 * age (last-good), so `now` is reserved for the TTL comparison and does
 * not gate output.
 */
export function renderMemorySection(
	stores: ExtensionStores,
	conversationId: number,
	now: number,
): string | undefined {
	if (stores.readLedgerSync(conversationId) === undefined) return undefined;
	const snapshot = stores.readRepresentationSync(conversationId);
	if (snapshot === undefined) return undefined;
	void now; // staleness never suppresses: the last snapshot is last-good.
	const parts: string[] = [SECTION_HEADER];
	if (snapshot.userProfile !== null) {
		parts.push(`User profile:\n${snapshot.userProfile}`);
	}
	if (snapshot.projectSummary !== null) {
		parts.push(`Project summary:\n${snapshot.projectSummary}`);
	}
	if (parts.length === 1) return undefined;
	return parts.join("\n");
}
