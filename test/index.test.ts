import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "@earendil-works/pi-durable";

import type { DeliveryEngine } from "../src/delivery.js";
import type { HonchoClient } from "../src/honcho.js";
import type { RunSettledEventLike } from "../src/types.js";
import createHonchoMemory, { type FactoryDeps } from "../src/index.js";

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
		await harness.cleanup();
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
		expect(result.extension?.tasks).toEqual([]);
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
