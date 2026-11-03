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

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Peer } from "@honcho-ai/sdk";

import type { HonchoSettings } from "./config.js";
import type { DeliveryEngine } from "./delivery.js";
import type { HonchoClient } from "./honcho.js";

/** The no-memory text returned by search (empty) and chat (null). */
const NO_MEMORY_TEXT = "No relevant memory found.";

/** Structural slice of `host.conversations.meta` the tools read. */
interface MetaReader {
	meta(id: ConversationId): Promise<{ owner?: string }>;
}

/**
 * Test seam: the factory wires the real accessors; tests inject fakes.
 * The accessors are functions (not the values themselves) because the
 * engine/client are lazily constructed and rebuilt on settings/key change.
 */
export interface ToolsDeps {
	readonly host: { conversations: MetaReader };
	readonly client: () => HonchoClient | undefined;
	readonly engine: () => Promise<DeliveryEngine>;
	readonly settings: () => HonchoSettings | undefined;
}

/** Wrap a Honcho failure with the extension's error prefix. */
function honchoError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	// Internal guard errors already carry the extension prefix; wrapping
	// them again would nest it.
	if (message.startsWith("memory-honcho: ")) return new Error(message);
	return new Error(`memory-honcho: Honcho unavailable (${message})`);
}

/** Build the three recall tools. */
export function createTools(deps: ToolsDeps): readonly ToolRegistration[] {
	// Per-conversation owner memo: the owner does not change mid-conversation.
	const ownerMemo = new Map<number, string>();

	async function resolveOwner(conversationId: number): Promise<string> {
		const memoized = ownerMemo.get(conversationId);
		if (memoized !== undefined) return memoized;
		const meta = await deps.host.conversations.meta(
			conversationId as ConversationId,
		);
		const owner = meta.owner ?? "user";
		ownerMemo.set(conversationId, owner);
		return owner;
	}

/** Establish the session, then resolve the user peer. */
async function userPeer(conversationId: number): Promise<Peer> {
	const owner = await resolveOwner(conversationId);
	await deps.engine().then((engine) => engine.establish(conversationId, owner));
	return clientOrThrow().userPeerFor(owner);
}

/** The agent peer, after the client is guaranteed. */
async function agentPeer(): Promise<Peer> {
	return clientOrThrow().agentPeer();
}

/** The client, or a clean error (the factory wires a live accessor). */
function clientOrThrow(): HonchoClient {
	const client = deps.client();
	if (client === undefined) {
		throw new Error("memory-honcho: client not initialized");
	}
	return client;
}

	/** Settings after the engine has resolved (guaranteed initialized). */
	function currentSettings(): HonchoSettings {
		const settings = deps.settings();
		if (settings === undefined) {
			throw new Error("memory-honcho: settings not initialized");
		}
		return settings;
	}

	const search = defineTool({
		name: "honcho_search",
		description:
			"Search the user's Honcho memory for messages relevant to the query. " +
			"Returns matching messages, sliced to the preview length, annotated with " +
			"their source conversation id.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query." }),
		}),
		async execute(args, api, _context) {
			try {
				// Resolve the engine first so settings are initialized.
				await deps.engine();
				const settings = currentSettings();
				const peer = await userPeer(Number(api.conversationId));
				const results = await peer.search(args.query, {
					limit: settings.searchLimit,
				});
				if (results.length === 0) {
					return { output: [{ type: "text" as const, text: NO_MEMORY_TEXT }] };
				}
				const lines = results.map((message) => {
					const slice = message.content.slice(0, settings.toolPreviewLength);
					const conversationId = message.metadata?.conversationId;
					const annotation =
						typeof conversationId === "number" || typeof conversationId === "string"
							? ` (conversation ${conversationId})`
							: "";
					return `[${message.peerId}] ${slice}${annotation}`;
				});
				return { output: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (error) {
				throw honchoError(error);
			}
		},
	});

	const chat = defineTool({
		name: "honcho_chat",
		description:
			"Ask the agent's Honcho representation of the user a natural-language " +
			"question. Returns the answer, or the no-memory text when there is none.",
		parameters: Type.Object({
			query: Type.String({ description: "The question to ask." }),
			reasoningLevel: Type.Optional(
				Type.Union(
					[
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("max"),
					],
					{ description: "Reasoning level for the query; default \"low\"." },
				),
			),
		}),
		async execute(args, api, _context) {
			try {
				const conversationId = Number(api.conversationId);
				const targetPeer = await userPeer(conversationId);
				const agent = await agentPeer();
				const answer = await agent.chat(args.query, {
					target: targetPeer,
					reasoningLevel: args.reasoningLevel ?? "low",
				});
				return {
					output: [
						{ type: "text" as const, text: answer ?? NO_MEMORY_TEXT },
					],
				};
			} catch (error) {
				throw honchoError(error);
			}
		},
	});

	const remember = defineTool({
		name: "honcho_remember",
		description:
			"Record a fact about the user as a Honcho conclusion. " +
			"The fact is user-level (cross-conversation), not conversation-scoped.",
		parameters: Type.Object({
			content: Type.String({ description: "The fact to remember." }),
		}),
		async execute(args, api, _context) {
			try {
				const conversationId = Number(api.conversationId);
				const targetPeer = await userPeer(conversationId);
				const agent = await agentPeer();
				await agent.conclusionsOf(targetPeer).create({
					content: args.content,
				});
				return {
					output: [{ type: "text" as const, text: "Remembered." }],
				};
			} catch (error) {
				throw honchoError(error);
			}
		},
	});

	return [search, chat, remember];
}
