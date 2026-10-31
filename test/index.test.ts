import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "@earendil-works/pi-durable";

import { refreshRepresentation } from "../src/representations.js";
import type { DeliveryEngine } from "../src/delivery.js";
import type { HonchoClient } from "../src/honcho.js";
import type { HonchoSettings } from "../src/config.js";
import type { RunSettledEventLike } from "../src/types.js";
import createHonchoMemory, { type FactoryDeps } from "../src/index.js";

vi.mock("../src/representations.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/representations.js")>();
	return {
		...original,
		refreshRepresentation: vi.fn(original.refreshRepresentation),
	};
});

// -- fake host --------------------------------------------------------------

interface FakeHost {
	readonly stores: {
		readonly secrets: { get(key: string): Promise<string | undefined> };
		readonly settings: { get(): Promise<Record<string, unknown>> };
		readonly paths: {
			readonly data: string;
			readonly state: string;
			readonly cache: string;
		};
	};
}

interface Harness {
	readonly host: FakeHost;
	readonly dirs: string[];
	readonly engine: {
		readonly establishCalls: { conversationId: number; owner: string }[];
		readonly kickCalls: { conversationId: number; owner: string }[];
		readonly drainCalls: number[];
	};
	readonly createEngine: NonNullable<FactoryDeps["createEngine"]>;
	readonly cleanup: () => Promise<void>;
}

async function makeHarness(options?: {
	readonly settings?: Record<string, unknown>;
	readonly apiKey?: string;
}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "memory-honcho-index-"));
	const dirs = {
		data: join(root, "data"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	const settings = options?.settings ?? {};
	const apiKey = options?.apiKey;
	const host: FakeHost = {
		stores: {
			secrets: { get: async () => apiKey },
			settings: { get: async () => settings },
			paths: dirs,
		},
	};
	const establishCalls: { conversationId: number; owner: string }[] = [];
	const kickCalls: { conversationId: number; owner: string }[] = [];
	const drainCalls: number[] = [];
	const createEngine: NonNullable<FactoryDeps["createEngine"]> = () =>
		({
			establish: async (conversationId: number, owner: string) => {
				establishCalls.push({ conversationId, owner });
			},
			deliverPending: async () => {},
			kick: (conversationId: number, owner: string) => {
				kickCalls.push({ conversationId, owner });
			},
		}) as unknown as DeliveryEngine;
	return {
		host,
		dirs: [root],
		engine: { establishCalls, kickCalls, drainCalls },
		createEngine,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** A fake client covering the one surface the factory touches (`drainAll`). */
function fakeClient(harness: Harness): HonchoClient {
	return {
		drainAll: async (deadlineMs: number) => {
			harness.engine.drainCalls.push(deadlineMs);
		},
	} as unknown as HonchoClient;
}

// -- fake event api ----------------------------------------------------------

type DocumentMap = Map<number, AgentState | undefined>;

function fakeEventApi(documents: DocumentMap) {
	return {
		entry: async () => undefined,
		entries: async () => ({ items: [], next: undefined }),
		document: async <T>(_token: unknown, conversationId: number) =>
			documents.get(conversationId) as Readonly<T> | undefined,
	};
}

const CONTEXT = { abortSignal: undefined };

const SETTINGS: HonchoSettings = {
	agentPeerId: "test-agent",
	baseUrl: undefined,
	workspaceId: "test-workspace",
	contextTokens: 1200,
	maxMessageLength: 8000,
	searchLimit: 8,
	toolPreviewLength: 500,
	representationTtlMs: 600_000,
	outboxRetentionDays: 30,
	deliveredBatchWindow: 200,
	anchorWindow: 1000,
};

// -- events ------------------------------------------------------------------

function answeredEvent(overrides?: Partial<RunSettledEventLike>): RunSettledEventLike {
	return {
		conversationId: 7,
		owner: "alice",
		inputs: [42],
		inputTexts: ["hello there"],
		outcome: {
			status: "answered",
			answerEntryId: 43,
			answer: { content: [{ type: "text", text: "hi back" }] },
		},
		...overrides,
	};
}

// -- shared result probes ------------------------------------------------------

const SECTION_KEYS = ["long-term-memory", "honcho-memory"] as const;

async function readOutboxLines(dataDir: string): Promise<unknown[]> {
	const { readFile } = await import("node:fs/promises");
	try {
		const raw = await readFile(join(dataDir, "outbox", "capture.jsonl"), "utf8");
		return raw
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as unknown);
	} catch {
		return [];
	}
}

describe("createHonchoMemory", () => {
	let harness: Harness;

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.cleanup();
	});

	it("declares the host parameter exactly once (loader factory.length gate)", async () => {
		harness = await makeHarness();
		expect(createHonchoMemory.length).toBe(1);
	});

	it("returns the declared result shapes", async () => {
		harness = await makeHarness();
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});

		expect(result.extension?.name).toBe("@sigrun/memory-honcho");
		expect(result.extension?.tools).toEqual([]);
		const tasks = result.extension?.tasks ?? [];
		expect(
			tasks.map(
				(task: { readonly definition: { readonly name: string } }) =>
					task.definition.name,
			),
		).toEqual(["honcho-outbox-sweep"]);
		expect(
			result.extension?.sections?.map(
				(s: { readonly key: string }) => s.key,
			),
		).toEqual([
			...SECTION_KEYS,
		]);
		// Stub renders: they exist, and resolve undefined until Task 8.
		for (const s of result.extension?.sections ?? []) {
			expect(typeof s.render).toBe("function");
		}

		expect(result.workers?.[0]?.name).toBe("honcho-representations");
		expect(result.workers?.[0]?.wakeOn).toEqual([
			"conversationIdle",
			"conversationArchived",
		]);

		expect(result.jobs?.[0]).toEqual({
			name: "outbox-sweep",
			schedule: { cron: "*/15 * * * *" },
			action: { kind: "task", task: "honcho-outbox-sweep" },
		});

		expect(result.routes?.[0]?.method).toBe("GET");
		expect(result.routes?.[0]?.path).toBe("status");
		expect(result.routes?.[0]?.auth).toBe("user");
		expect(typeof result.routes?.[0]?.handler).toBe("function");
	});

	it("answered event appends one pending outbox record and kicks", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const api = fakeEventApi(new Map());

		await result.runSettled?.(answeredEvent() as never, api as never, CONTEXT);

		const records = (await readOutboxLines(harness.host.stores.paths.data)) as {
			type: string;
			conversationId: number;
			owner: string;
			status: string;
			entries: { peer: string; text: string }[];
			answerEntryId?: number;
		}[];
		expect(records).toHaveLength(1);
		expect(records[0]?.type).toBe("capture");
		expect(records[0]?.conversationId).toBe(7);
		expect(records[0]?.owner).toBe("alice");
		expect(records[0]?.status).toBe("pending");
		expect(records[0]?.entries.map((e) => e.peer)).toEqual(["user", "agent"]);
		expect(records[0]?.answerEntryId).toBe(43);
		expect(harness.engine.kickCalls).toEqual([
			{ conversationId: 7, owner: "alice" },
		]);
	});

	it("ownerless conversation captures as 'user'", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		await result.runSettled?.(
			answeredEvent({ owner: undefined }) as never,
			fakeEventApi(new Map()) as never,
			CONTEXT,
		);
		expect(harness.engine.kickCalls).toEqual([
			{ conversationId: 7, owner: "user" },
		]);
	});

	it("a run with no capturable text appends nothing and never kicks", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		await result.runSettled?.(
			answeredEvent({
				inputTexts: [""],
				outcome: {
					status: "answered",
					answerEntryId: 43,
					answer: { content: [{ type: "text", text: "" }] },
				},
			}) as never,
			fakeEventApi(new Map()) as never,
			CONTEXT,
		);
		expect(
			await readOutboxLines(harness.host.stores.paths.data),
		).toHaveLength(0);
		expect(harness.engine.kickCalls).toEqual([]);
	});

	it("missing API key still appends the record but skips the kick (logged once)", async () => {
		harness = await makeHarness({ apiKey: undefined });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const api = fakeEventApi(new Map());

		await result.runSettled?.(answeredEvent() as never, api as never, CONTEXT);
		await result.runSettled?.(answeredEvent({ inputs: [44] }) as never, api as never, CONTEXT);

		const records = await readOutboxLines(harness.host.stores.paths.data);
		expect(records).toHaveLength(2);
		expect(harness.engine.kickCalls).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("array-form selection excluding the extension skips capture entirely", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const documents: DocumentMap = new Map([[7, { extensions: ["other"] }]]);
		await result.runSettled?.(
			answeredEvent() as never,
			fakeEventApi(documents) as never,
			CONTEXT,
		);
		expect(
			await readOutboxLines(harness.host.stores.paths.data),
		).toHaveLength(0);
		expect(harness.engine.kickCalls).toEqual([]);
	});

	it("array-form selection including the extension captures", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const documents: DocumentMap = new Map([
			[7, { extensions: ["@sigrun/memory-honcho"] }],
		]);
		await result.runSettled?.(
			answeredEvent() as never,
			fakeEventApi(documents) as never,
			CONTEXT,
		);
		expect(harness.engine.kickCalls).toHaveLength(1);
	});

	it("object-form and absent selection capture", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const api = fakeEventApi(
			new Map([[7, { extensions: { remove: ["something-else"] } }]]),
		);
		await result.runSettled?.(answeredEvent() as never, api as never, CONTEXT);
		await result.runSettled?.(
			answeredEvent({ conversationId: 8 }) as never,
			fakeEventApi(new Map()) as never,
			CONTEXT,
		);
		expect(harness.engine.kickCalls).toEqual([
			{ conversationId: 7, owner: "alice" },
			{ conversationId: 8, owner: "alice" },
		]);
	});

	it("the selection verdict is memoized per conversation", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		let reads = 0;
		const api = {
			entry: async () => undefined,
			entries: async () => ({ items: [], next: undefined }),
			document: async <T>() => {
				reads += 1;
				return { extensions: ["@sigrun/memory-honcho"] } as unknown as Readonly<T>;
			},
		};
		await result.runSettled?.(answeredEvent() as never, api as never, CONTEXT);
		await result.runSettled?.(answeredEvent({ inputs: [44] }) as never, api as never, CONTEXT);
		expect(reads).toBe(1);
		expect(harness.engine.kickCalls).toHaveLength(2);
	});

	it("conversationForked writes the pending fork with zero engine calls", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		await result.conversationForked?.(
			{ childId: 9, parentId: 7, at: 12 } as never,
			fakeEventApi(new Map()) as never,
			CONTEXT,
		);

		const { readFile } = await import("node:fs/promises");
		const record = JSON.parse(
			await readFile(
				join(harness.host.stores.paths.state, "forks", "pending", "9.json"),
				"utf8",
			),
		) as { childId: number; parentId: number; at: number; createdAt: number };
		expect(record.childId).toBe(9);
		expect(record.parentId).toBe(7);
		expect(record.at).toBe(12);
		expect(typeof record.createdAt).toBe("number");
		expect(harness.engine.kickCalls).toEqual([]);
		expect(harness.engine.establishCalls).toEqual([]);
		expect(harness.engine.drainCalls).toEqual([]);
	});

	it("harnessShutdown drains every chain with the 25s deadline", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
			createClient: () => fakeClient(harness),
		});
		await result.harnessShutdown?.(fakeEventApi(new Map()) as never, CONTEXT);
		expect(harness.engine.drainCalls).toEqual([25_000]);
	});

	it("the worker records start/end bookkeeping in the process map", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const worker = result.workers?.[0];
		expect(worker).toBeDefined();

		const wake = { event: "conversationIdle", conversationId: 7 };
		await worker?.run(CONTEXT, wake as never);
		const map = result.workerStatus;
		expect(map?.get("honcho-representations")?.runs).toBe(1);
		expect(map?.get("honcho-representations")?.lastError).toBeUndefined();
		expect(typeof map?.get("honcho-representations")?.startedAt).toBe("number");
		expect(typeof map?.get("honcho-representations")?.endedAt).toBe("number");
	});

	it("the worker records a failing run's last error", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
			createClient: () => {
				throw new Error("no client");
			},
		});
		const worker = result.workers?.[0];
		await expect(
			worker?.run(CONTEXT, {
				event: "conversationIdle",
				conversationId: 7,
			} as never),
		).rejects.toThrow();
		const status = result.workerStatus?.get("honcho-representations");
		expect(status?.lastError).toContain("no client");
	});

	it("the status route stub answers a Response", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const response = await result.routes?.[0]?.handler(
			new Request("http://localhost/status"),
			{ host: harness.host as never },
		);
		expect(response).toBeInstanceOf(Response);
		expect(response?.status).toBe(200);
	});

	it("a fresh key/settings change rebuilds the engine; an unchanged pair reuses it", async () => {
		// Harness with a MUTABLE secret: key A for the first events, key B after.
		const root = await mkdtemp(join(tmpdir(), "memory-honcho-index-"));
		harness = {
			dirs: [root],
			cleanup: async () => {
				await rm(root, { recursive: true, force: true });
			},
			host: undefined as never,
			engine: { establishCalls: [], kickCalls: [], drainCalls: [] },
			createEngine: () => {
				throw new Error("unused");
			},
		};
		let apiKey: string | undefined = "sk-A";
		const host = {
			stores: {
				secrets: { get: async () => apiKey },
				settings: { get: async () => ({}) },
				paths: {
					data: join(root, "data"),
					state: join(root, "state"),
					cache: join(root, "cache"),
				},
			},
		};
		const clientKeys: (string | undefined)[] = [];
		const kicks: { conversationId: number; owner: string }[] = [];
		const result = createHonchoMemory(host as never, {
			createClient: (_settings, key) => {
				clientKeys.push(key);
				return {} as never;
			},
			createEngine: () =>
				({
					kick: (conversationId: number, owner: string) => {
						kicks.push({ conversationId, owner });
					},
				}) as never,
		});
		const api = fakeEventApi(new Map());

		await result.runSettled?.(answeredEvent() as never, api as never, CONTEXT);
		// Same settings + same key: engine reused (one construction).
		await result.runSettled?.(answeredEvent({ inputs: [44] }) as never, api as never, CONTEXT);
		expect(clientKeys).toEqual(["sk-A"]);

		// The key changed: the engine is rebuilt with the new key.
		apiKey = "sk-B";
		await result.runSettled?.(answeredEvent({ inputs: [45] }) as never, api as never, CONTEXT);
		expect(clientKeys).toEqual(["sk-A", "sk-B"]);
		expect(kicks).toHaveLength(3);
	});

	it("a rejected engine construction is NOT memoized — the next event retries", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		let failures = 0;
		let builds = 0;
		const result = createHonchoMemory(harness.host as never, {
			createEngine: () => {
				builds += 1;
				if (failures > 0) {
					failures -= 1;
					return Promise.reject(new Error("store read failed")) as never;
				}
				return harness.createEngine({} as never, {} as never, {} as never, {});
			},
		});
		const api = fakeEventApi(new Map());

		failures = 1;
		await expect(
			result.runSettled?.(answeredEvent() as never, api as never, CONTEXT),
		).rejects.toThrow("store read failed");
		expect(builds).toBe(1);

		// The failure was not memoized: the next event constructs again and succeeds.
		await result.runSettled?.(answeredEvent({ inputs: [44] }) as never, api as never, CONTEXT);
		expect(builds).toBe(2);
		expect(harness.engine.kickCalls).toEqual([
			{ conversationId: 7, owner: "alice" },
		]);
	});

	it("a false selection verdict is NOT memoized — a later opt-in captures", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		// Event 1: array-form excluding us → skipped (and NOT cached).
		const documents: DocumentMap = new Map([[7, { extensions: ["other"] }]]);
		await result.runSettled?.(
			answeredEvent() as never,
			fakeEventApi(documents) as never,
			CONTEXT,
		);
		expect(harness.engine.kickCalls).toEqual([]);

		// Event 2, same conversation: the selection now includes us → capture.
		documents.set(7, { extensions: ["@sigrun/memory-honcho", "other"] });
		await result.runSettled?.(
			answeredEvent({ inputs: [44] }) as never,
			fakeEventApi(documents) as never,
			CONTEXT,
		);
		expect(harness.engine.kickCalls).toEqual([
			{ conversationId: 7, owner: "alice" },
		]);
	});

	it("the sections render from the representation cache (sync reads)", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const sections = result.extension?.sections ?? [];
		const promptInput = { conversationId: 7 } as never;

		// Stores not yet lazily constructed: nothing to render.
		expect(await sections[0]?.render(promptInput, CONTEXT as never)).toBeUndefined();

		// Let the factory resolve the lazily constructed stores.
		await result.runSettled?.(
			answeredEvent() as never,
			fakeEventApi(new Map()) as never,
			CONTEXT,
		);

		// Before any delivery, nothing is on disk: both sections render nothing.
		expect(await sections[0]?.render(promptInput, CONTEXT as never)).toBeUndefined();
		expect(await sections[1]?.render(promptInput, CONTEXT as never)).toBeUndefined();

		// Write the ledger + snapshot through the real store surface.
		const { ExtensionStores } = await import("../src/stores.js");
		const stores = new ExtensionStores(harness.host.stores.paths, SETTINGS);
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [],
		});
		await stores.writeRepresentation(7, {
			userProfile: "Alice likes tea.",
			projectSummary: "The project ships memory.",
			fetchedAt: 1_000,
		});

		const expected =
			"[Persistent memory]\nUser profile:\nAlice likes tea.\nProject summary:\nThe project ships memory.";
		expect(await sections[0]?.render(promptInput, CONTEXT as never)).toBe(expected);
		expect(await sections[1]?.render(promptInput, CONTEXT as never)).toBe(expected);
	});

	it("the worker refreshes wake.conversationId's representation only, with the ledger owner", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		// No engine seam: the default construction makes the refresh eligible
		// (a custom createEngine skips it — production uses the real engine).
		// A stubbed CLIENT: the conversation's session is pre-established (the
		// refresh's gate) and there is no network surface.
		const { ConversationClient } = await import("../src/honcho.js");
		const conversation = new ConversationClient("7");
		conversation.markEstablished(Promise.resolve({} as never));
		const result = createHonchoMemory(harness.host as never, {
			createClient: () =>
				({
					for: () => conversation,
					drainAll: async () => {},
				}) as never,
		});
		const { ExtensionStores } = await import("../src/stores.js");
		const stores = new ExtensionStores(harness.host.stores.paths, SETTINGS);
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [],
		});

		// Full-stub the refresh itself: the unit under test is the WORKER's
		// wiring (which conversation, which owner) — refreshRepresentation's
		// own behavior is covered in test/representations.test.ts.
		const refresh = vi
			.mocked(refreshRepresentation)
			.mockImplementation(async () => {});
		refresh.mockClear();
		await result.workers?.[0]?.run(CONTEXT as never, {
			event: "conversationIdle",
			conversationId: 7,
		} as never);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh.mock.calls[0]?.[3]).toBe(7);
		expect(refresh.mock.calls[0]?.[4]).toBe("alice");
		expect(result.workerStatus?.get("honcho-representations")?.runs).toBe(1);
	});

	it("the worker skips the refresh for a conversation with no established session", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {});
		const { ExtensionStores } = await import("../src/stores.js");
		const stores = new ExtensionStores(harness.host.stores.paths, SETTINGS);
		await stores.writeLedger(7, {
			conversationId: 7,
			honchoSessionId: "sigrun-7",
			ownerAtFirstCapture: "alice",
			deliveredBatchIds: [],
			anchors: [],
		});

		const refresh = vi.mocked(refreshRepresentation);
		refresh.mockClear();
		// Ledger present but no session was ever established (idle before the
		// first delivery): bookkeeping only, no refresh, no failure.
		await result.workers?.[0]?.run(CONTEXT as never, {
			event: "conversationIdle",
			conversationId: 7,
		} as never);

		expect(refresh).not.toHaveBeenCalled();
		const status = result.workerStatus?.get("honcho-representations");
		expect(status?.runs).toBe(1);
		expect(status?.lastError).toBeUndefined();
	});

	it("the worker is a bookkeeping-only no-op for a ledger-less conversation", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		const refresh = vi.mocked(refreshRepresentation);
		refresh.mockClear();
		await result.workers?.[0]?.run(CONTEXT as never, {
			event: "conversationArchived",
			conversationId: 99,
		} as never);
		expect(refresh).not.toHaveBeenCalled();
		expect(result.workerStatus?.get("honcho-representations")?.runs).toBe(1);
		expect(result.workerStatus?.get("honcho-representations")?.lastError).toBeUndefined();
	});


	it("userDeleted only logs the departure (no data movement)", async () => {
		harness = await makeHarness({ apiKey: "sk-test" });
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const result = createHonchoMemory(harness.host as never, {
			createEngine: harness.createEngine,
		});
		await result.userDeleted?.(
			{ user: "alice", transferTo: "admin" },
			fakeEventApi(new Map()) as never,
			CONTEXT,
		);
		expect(info).toHaveBeenCalledTimes(1);
		expect(String(info.mock.calls[0]?.[0])).toContain("alice");
	});
});
