import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
	ToolExecutionApi,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Conclusion, Message } from "@honcho-ai/sdk";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";

import type { DeliveryEngine } from "../src/delivery.js";
import type { HonchoClient } from "../src/honcho.js";
import createHonchoMemory from "../src/index.js";
import { HONCHO_SETTINGS_SCHEMA } from "../src/settings-schema.js";

// -- canned literals (tests own their literals) ------------------------------

const OWNER = "casey";
const CONVERSATION_ID = 7;

const LONG_CONTENT = "x".repeat(600);
const SLICED_CONTENT = "x".repeat(500);

const SEARCH_MESSAGES = [
	{
		id: "m-1",
		content: LONG_CONTENT,
		peerId: "alice",
		metadata: { conversationId: 42 },
	},
	{
		id: "m-2",
		content: "short note",
		peerId: "bob",
		metadata: {},
	},
] as unknown as Message[];

// -- fake SDK peers -----------------------------------------------------------

interface SearchCall {
	query: string;
	options: { limit?: number } | undefined;
}

interface ChatCall {
	query: string;
	options: {
		target?: unknown;
		reasoningLevel?: string;
	} | undefined;
}

interface CreateCall {
	params: Record<string, unknown>;
}

interface ConclusionsOfCall {
	target: unknown;
}

class FakePeer {
	lastUserPeerForArg: string | undefined;
	searchCalls: SearchCall[] = [];
	chatCalls: ChatCall[] = [];
	conclusionsOfCalls: ConclusionsOfCall[] = [];
	createCalls: CreateCall[] = [];
	chatResult: string | null = "canned chat answer";
	searchResult: Message[] = SEARCH_MESSAGES;

	async search(query: string, options?: { limit?: number }): Promise<Message[]> {
		this.searchCalls.push({ query, options });
		return this.searchResult;
	}

	async chat(
		query: string,
		options?: { target?: unknown; session?: unknown; reasoningLevel?: string },
	): Promise<string | null> {
		this.chatCalls.push({ query, options });
		return this.chatResult;
	}

	conclusionsOf(target: unknown) {
		this.conclusionsOfCalls.push({ target });
		return {
			create: async (params: Record<string, unknown>): Promise<Conclusion[]> => {
				this.createCalls.push({ params });
				return [] as unknown as Conclusion[];
			},
		};
	}
}

// -- harness ------------------------------------------------------------------

interface ToolHarness {
	readonly dirs: string[];
	readonly ownerPeer: FakePeer;
	readonly agentPeer: FakePeer;
	readonly establishCalls: { conversationId: number; owner: string }[];
	readonly metaCalls: number[];
	readonly tools: readonly ToolRegistration[];
	readonly cleanup: () => Promise<void>;
}

async function makeHarness(options?: {
	readonly owner?: string;
	readonly settings?: Record<string, unknown>;
}): Promise<ToolHarness> {
	const root = await mkdtemp(join(tmpdir(), "memory-honcho-tools-"));
	const dirs = {
		data: join(root, "data"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	// The fake client: `userPeerFor` returns the owner peer (and records the
	// argument it was given), `agentPeer` returns the agent peer.
	const ownerPeer = new FakePeer();
	const agentPeer = new FakePeer();
	const client = {
		userPeerFor: async (owner: string | undefined) => {
			ownerPeer.lastUserPeerForArg = owner;
			return ownerPeer;
		},
		agentPeer: async () => agentPeer,
	} as unknown as HonchoClient;

	const establishCalls: { conversationId: number; owner: string }[] = [];
	const engine = {
		establish: async (conversationId: number, owner: string) => {
			establishCalls.push({ conversationId, owner });
		},
		deliverPending: async () => {},
		kick: () => {},
	} as unknown as DeliveryEngine;

	const metaCalls: number[] = [];
	const host = {
		settings: {
			declare: () => ({
				get: async () =>
					checkStoredSettings(HONCHO_SETTINGS_SCHEMA, options?.settings ?? {}).value,
			}),
		},
		stores: {
			secrets: { get: async () => "test-key" },
			settings: { get: async () => options?.settings ?? {} },
			paths: dirs,
		},
		conversations: {
			meta: async (id: unknown) => {
				metaCalls.push(Number(id));
				return options?.owner === undefined
					? {}
					: { owner: options.owner };
			},
		},
	} as never;

	const result = createHonchoMemory(host, {
		createClient: () => client,
		createEngine: () => engine,
	});

	return {
		dirs: [root],
		ownerPeer,
		agentPeer,
		establishCalls,
		metaCalls,
		tools: result.extension?.tools ?? [],
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

// -- tool-call helper -----------------------------------------------------------

const CONTEXT = { abortSignal: undefined } as unknown as Context;

function toolApi(conversationId: number): ToolExecutionApi {
	return { conversationId } as unknown as ToolExecutionApi;
}

async function callTool(
	harness: ToolHarness,
	name: string,
	conversationId: number,
	args: Record<string, unknown>,
): Promise<{ text: string }> {
	const found = harness.tools.find((t) => t.name === name);
	if (found === undefined) throw new Error(`tool ${name} is not registered`);
	const result = await found.execute(args as never, toolApi(conversationId), CONTEXT);
	const blocks = result.output ?? [];
	const text = blocks
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
	return { text };
}

// -- tests ---------------------------------------------------------------------

describe("honcho tools", () => {
	let harness: ToolHarness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("search passes query+limit, slices content to toolPreviewLength, annotates conversation ids", async () => {
		harness = await makeHarness({ owner: OWNER });
		const { text } = await callTool(harness, "honcho_search", CONVERSATION_ID, {
			query: "what does alice like",
		});
		expect(harness.ownerPeer.searchCalls).toHaveLength(1);
		expect(harness.ownerPeer.searchCalls[0]).toEqual({
			query: "what does alice like",
			options: { limit: 8 },
		});
		expect(text).toContain(`[alice] ${SLICED_CONTENT}`);
		expect(text).toContain("(conversation 42)");
		expect(text).toContain("[bob] short note");
	});

	it("search annotates conversation id only when metadata carries one", async () => {
		harness = await makeHarness({ owner: OWNER });
		const { text } = await callTool(harness, "honcho_search", CONVERSATION_ID, {
			query: "anything",
		});
		const lines = text.split("\n").filter((l) => l.length > 0);
		expect(lines[0]).toContain("(conversation 42)");
		expect(lines[1]).not.toContain("(conversation");
	});

	it("search returns the no-memory text when no results", async () => {
		harness = await makeHarness({ owner: OWNER });
		harness.ownerPeer.searchResult = [];
		const { text } = await callTool(harness, "honcho_search", CONVERSATION_ID, {
			query: "nothing",
		});
		expect(text).toBe("No relevant memory found.");
	});

	it("chat defaults reasoningLevel to \"low\", passes the owner peer as target", async () => {
		harness = await makeHarness({ owner: OWNER });
		const { text } = await callTool(harness, "honcho_chat", CONVERSATION_ID, {
			query: "what do I like",
		});
		expect(harness.agentPeer.chatCalls).toHaveLength(1);
		const call = harness.agentPeer.chatCalls[0];
		expect(call.query).toBe("what do I like");
		expect(call.options?.reasoningLevel).toBe("low");
		expect(call.options?.target).toBe(harness.ownerPeer);
		expect(text).toBe("canned chat answer");
	});

	it("chat forwards an explicit reasoningLevel", async () => {
		harness = await makeHarness({ owner: OWNER });
		await callTool(harness, "honcho_chat", CONVERSATION_ID, {
			query: "deeper",
			reasoningLevel: "high",
		});
		expect(harness.agentPeer.chatCalls[0].options?.reasoningLevel).toBe("high");
	});

	it("chat returns the no-memory text when the answer is null", async () => {
		harness = await makeHarness({ owner: OWNER });
		harness.agentPeer.chatResult = null;
		const { text } = await callTool(harness, "honcho_chat", CONVERSATION_ID, {
			query: "anything",
		});
		expect(text).toBe("No relevant memory found.");
	});

	it("remember creates a conclusion with content and NO sessionId key", async () => {
		harness = await makeHarness({ owner: OWNER });
		await callTool(harness, "honcho_remember", CONVERSATION_ID, {
			content: "I like tea",
		});
		expect(harness.agentPeer.conclusionsOfCalls).toHaveLength(1);
		expect(harness.agentPeer.conclusionsOfCalls[0].target).toBe(harness.ownerPeer);
		expect(harness.agentPeer.createCalls).toHaveLength(1);
		const params = harness.agentPeer.createCalls[0].params;
		expect(params).toHaveProperty("content", "I like tea");
		expect(params).not.toHaveProperty("sessionId");
		expect(Object.keys(params)).toEqual(["content"]);
	});

	it("ownerless conversation resolves to the \"user\" peer", async () => {
		harness = await makeHarness(); // no owner
		await callTool(harness, "honcho_search", CONVERSATION_ID, { query: "q" });
		expect(harness.ownerPeer.searchCalls).toHaveLength(1);
		expect(harness.metaCalls).toEqual([CONVERSATION_ID]);
		expect(harness.ownerPeer.lastUserPeerForArg).toBe("user");
	});

	it("establish is called on first tool use, awaited before the Honcho call", async () => {
		harness = await makeHarness({ owner: OWNER });
		expect(harness.establishCalls).toHaveLength(0);
		await callTool(harness, "honcho_search", CONVERSATION_ID, { query: "q" });
		expect(harness.establishCalls).toEqual([
			{ conversationId: CONVERSATION_ID, owner: OWNER },
		]);
		expect(harness.ownerPeer.searchCalls).toHaveLength(1);
	});

	it("owner is memoized per conversation — meta is read once", async () => {
		harness = await makeHarness({ owner: OWNER });
		await callTool(harness, "honcho_search", CONVERSATION_ID, { query: "q1" });
		await callTool(harness, "honcho_chat", CONVERSATION_ID, { query: "q2" });
		expect(harness.metaCalls).toEqual([CONVERSATION_ID]);
	});

	it("Honcho failure throws with the memory-honcho: prefix", async () => {
		harness = await makeHarness({ owner: OWNER });
		harness.ownerPeer.search = async () => {
			throw new Error("connection refused");
		};
		await expect(
			callTool(harness, "honcho_search", CONVERSATION_ID, { query: "q" }),
		).rejects.toThrow(/^memory-honcho: Honcho unavailable \(connection refused\)$/);
	});
});
