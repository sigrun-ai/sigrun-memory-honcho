import { describe, expect, it, vi } from "vitest";
import type { Peer, Session } from "@honcho-ai/sdk";

import { chain, chainTails } from "../src/chains.js";
import {
	HonchoClient,
	sanitize,
	type HonchoSdk,
} from "../src/honcho.js";
import type { HonchoSettings } from "../src/settings-schema.js";

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

/** Deferred promise whose fate the test controls. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Flush queued microtasks so chained callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Fake SDK with no network: peer()/session() calls are recorded. */
function fakeSdk(): {
	sdk: HonchoSdk;
	calls: { kind: string; id: string }[];
} {
	const calls: { kind: string; id: string }[] = [];
	const sdk: HonchoSdk = {
		async peer(id: string) {
			calls.push({ kind: "peer", id });
			return { id } as unknown as Peer;
		},
		async session(id: string) {
			calls.push({ kind: "session", id });
			return { id } as unknown as Session;
		},
	};
	return { sdk, calls };
}

describe("sanitize", () => {
	it("leaves a clean name alone", () => {
		expect(sanitize("alice")).toBe("alice");
	});

	it("replaces disallowed characters with underscores", () => {
		expect(sanitize("user@example.com")).toBe("user_example_com");
	});

	it("keeps hyphens and underscores", () => {
		expect(sanitize("agent_one-2")).toBe("agent_one-2");
	});

	it("turns an empty name into a single underscore", () => {
		expect(sanitize("")).toBe("_");
	});
});

describe("chain", () => {
	it("runs work in order: later work starts after earlier work resolves", async () => {
		const order: string[] = [];
		const gate = deferred<void>();
		const first = chain("test-order", async () => {
			await gate.promise;
			order.push("first");
			return 1;
		});
		const second = chain("test-order", async () => {
			order.push("second");
			return 2;
		});
		await flush();
		expect(order).toEqual([]);
		gate.resolve();
		expect(await first).toBe(1);
		expect(await second).toBe(2);
		expect(order).toEqual(["first", "second"]);
	});

	it("independent labels do not serialize against each other", async () => {
		const order: string[] = [];
		const slow = deferred<void>();
		const a = chain("test-independent-a", async () => {
			await slow.promise;
			order.push("a");
		});
		const b = chain("test-independent-b", async () => {
			order.push("b");
		});
		await b;
		slow.resolve();
		await a;
		expect(order).toEqual(["b", "a"]);
	});

	it("a rejecting work item settles for its caller and does not poison the tail", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const failure = new Error("synthetic chain failure");
			await expect(
				chain("test-poison", async () => {
					throw failure;
				}),
			).rejects.toBe(failure);
			await expect(chain("test-poison", async () => "recovered")).resolves.toBe(
				"recovered",
			);
			const labeled = errorSpy.mock.calls.some((args) =>
				args.some(
					(arg) => typeof arg === "string" && arg.includes("test-poison"),
				),
			);
			expect(labeled).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("chainTails", () => {
	it("resolves immediately when no tails are live", async () => {
		await expect(chainTails()).resolves.toBeInstanceOf(Array);
	});

	it("resolves after every live tail settles", async () => {
		const gate = deferred<void>();
		const done: string[] = [];
		void chain("test-drain", async () => {
			await gate.promise;
			done.push("work");
		});
		let drained = false;
		const drain = chainTails().then(() => {
			drained = true;
		});
		await flush();
		expect(drained).toBe(false);
		gate.resolve();
		await drain;
		expect(drained).toBe(true);
		expect(done).toEqual(["work"]);
	});
});

describe("ConversationClient", () => {
	it("chain serializes work for that conversation", async () => {
		const { sdk } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const conversation = client.for("conversation-one");
		const order: string[] = [];
		const gate = deferred<void>();
		const first = conversation.chain(async () => {
			await gate.promise;
			order.push("first");
		});
		const second = conversation.chain(async () => {
			order.push("second");
		});
		await flush();
		expect(order).toEqual([]);
		gate.resolve();
		await first;
		await second;
		expect(order).toEqual(["first", "second"]);
	});

	it("established() throws until Task 4 establishes the session", async () => {
		const { sdk } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const conversation = client.for("conversation-one");
		await expect(conversation.established()).rejects.toThrow(
			"memory-honcho: session not established",
		);
	});
});

describe("HonchoClient", () => {
	it("for() memoizes per conversation id", () => {
		const { sdk } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		expect(client.for("conversation-one")).toBe(client.for("conversation-one"));
		expect(client.for("conversation-one")).not.toBe(
			client.for("conversation-two"),
		);
	});

	it("userPeerFor(undefined) asks the SDK for peer id 'user'", async () => {
		const { sdk, calls } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const peer = await client.userPeerFor(undefined);
		expect(peer).toEqual({ id: "user" });
		expect(calls).toEqual([{ kind: "peer", id: "user" }]);
	});

	it("userPeerFor(owner) sanitizes the owner into the peer id", async () => {
		const { sdk, calls } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const peer = await client.userPeerFor("alice@example.com");
		expect(peer).toEqual({ id: "alice_example_com" });
		expect(calls).toEqual([{ kind: "peer", id: "alice_example_com" }]);
	});

	it("memoizes peer get-or-create per peer id", async () => {
		const { sdk, calls } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const first = await client.userPeerFor(undefined);
		const second = await client.userPeerFor(undefined);
		expect(first).toBe(second);
		expect(calls).toEqual([{ kind: "peer", id: "user" }]);
	});

	it("does NOT memoize a peer rejection: the next call retries the SDK", async () => {
		let attempts = 0;
		const sdk: HonchoSdk = {
			async peer(id: string) {
				attempts++;
				if (attempts === 1) throw new Error("synthetic transient failure");
				return { id } as unknown as Peer;
			},
			async session(id: string) {
				return { id } as unknown as Session;
			},
		};
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		await expect(client.userPeerFor(undefined)).rejects.toThrow(
			"synthetic transient failure",
		);
		await expect(client.userPeerFor(undefined)).resolves.toEqual({ id: "user" });
		expect(attempts).toBe(2);
	});

	it("agentPeer() asks the SDK for the configured agentPeerId", async () => {
		const { sdk, calls } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const peer = await client.agentPeer();
		expect(peer).toEqual({ id: "test-agent" });
		expect(calls).toEqual([{ kind: "peer", id: "test-agent" }]);
	});

	it("a missing api key constructs a sdk with no apiKey (anonymous)", async () => {
		let seenConfig: Record<string, unknown> | undefined;
		const sdk = fakeSdk().sdk;
		const client = new HonchoClient(SETTINGS, undefined, (config: unknown) => {
			seenConfig = config as Record<string, unknown>;
			return sdk;
		});
		await client.agentPeer();
		expect(seenConfig).toBeDefined();
		expect(seenConfig && "apiKey" in seenConfig).toBe(false);
	});

	it("construction performs no sdk work (lazy)", () => {
		const { sdk, calls } = fakeSdk();
		new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		expect(calls).toEqual([]);
	});
});

describe("drainAll", () => {
	it("resolves once live chains settle before the deadline", async () => {
		const { sdk } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const gate = deferred<void>();
		const done: string[] = [];
		void client.for("conversation-one").chain(async () => {
			await gate.promise;
			done.push("work");
		});
		const drain = client.drainAll(5000);
		gate.resolve();
		await drain;
		expect(done).toEqual(["work"]);
	});

	it("returns when the deadline passes with work still stuck", async () => {
		const { sdk } = fakeSdk();
		const client = new HonchoClient(SETTINGS, "synthetic-key", () => sdk);
		const never = new Promise<void>(() => {});
		void client.for("conversation-stuck").chain(() => never);
		const start = Date.now();
		await client.drainAll(50);
		expect(Date.now() - start).toBeLessThan(5000);
	});
});
