import { describe, expect, it } from "vitest";

import {
	createHonchoReader,
	HonchoReadError,
	type ConclusionRow,
} from "../src/honcho-read.js";

type RecordedCall = {
	readonly url: string;
	readonly init: RequestInit;
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fakeFetch(
	responses: Response | readonly Response[] | ((url: string, init: RequestInit) => Response | Promise<Response>),
): {
	readonly fetch: typeof globalThis.fetch;
	readonly calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let next = 0;
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		const request = init ?? {};
		calls.push({ url, init: request });
		if (responses instanceof Response) return responses;
		if (Array.isArray(responses)) {
			const response = responses[next++];
			if (response === undefined) throw new Error("missing canned response");
			return response;
		}
		return (responses as (url: string, init: RequestInit) => Response | Promise<Response>)(url, request);
	};
	return { fetch, calls };
}

function readerWith(
	responses: Response | readonly Response[] | ((url: string, init: RequestInit) => Response | Promise<Response>),
	apiKey?: string,
) {
	const fake = fakeFetch(responses);
	const reader = createHonchoReader({
		baseUrl: "https://honcho.example.invalid",
		workspaceId: "acme",
		...(apiKey === undefined ? {} : { apiKey }),
		fetch: fake.fetch,
	});
	return { reader, calls: fake.calls };
}

function conclusion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		content: "Alice likes tea",
		observer_id: "alice",
		observed_id: "bob",
		session_id: "s1",
		created_at: "2026-11-07T12:00:00Z",
		level: "deductive",
		source_ids: ["p1", "p2"],
		source_message_ids: ["m1"],
		times_derived: 2,
		...overrides,
	};
}

function expectConclusion(row: ConclusionRow, expected: ConclusionRow): void {
	expect(row).toEqual(expected);
}

describe("Honcho REST reader", () => {
	it("card returns peer_card lines and [] for null", async () => {
		const first = readerWith(jsonResponse({ peer_card: ["IDENTITY: Alice", "ATTRIBUTE: Likes tea"] }));
		await expect(first.reader.card("alice")).resolves.toEqual([
			"IDENTITY: Alice",
			"ATTRIBUTE: Likes tea",
		]);
		expect(first.calls[0]).toMatchObject({
			url: "https://honcho.example.invalid/v3/workspaces/acme/peers/alice/card",
			init: { method: "GET" },
		});

		const second = readerWith(jsonResponse({ peer_card: null }));
		await expect(second.reader.card("alice")).resolves.toEqual([]);
	});

	it("list posts filters and paging", async () => {
		const { reader, calls } = readerWith(
			jsonResponse({
				items: [
					conclusion({ level: undefined, times_derived: undefined }),
				],
				total: 1,
				page: 2,
				pages: 3,
			}),
		);
		const page = await reader.list(
			{ observed_id: "alice", level: "deductive" },
			{ page: 2, size: 50, reverse: true },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://honcho.example.invalid/v3/workspaces/acme/conclusions/list?page=2&size=50&reverse=true",
		);
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.body).toBe(
			'{"filters":{"observed_id":"alice","level":"deductive"}}',
		);
		expectConclusion(page.items[0] as ConclusionRow, {
			id: "c1",
			content: "Alice likes tea",
			observerId: "alice",
			observedId: "bob",
			sessionId: "s1",
			createdAt: "2026-11-07T12:00:00Z",
			level: "explicit",
			sourceIds: ["p1", "p2"],
			sourceMessageIds: ["m1"],
			timesDerived: 1,
		});
		expect(page).toMatchObject({ total: 1, page: 2, pages: 3 });
	});

	it("query posts query, top_k and filters", async () => {
		const { reader, calls } = readerWith(jsonResponse([conclusion()]));
		await expect(
			reader.query("q", { observed_id: "alice" }, 50),
		).resolves.toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://honcho.example.invalid/v3/workspaces/acme/conclusions/query",
		);
		expect(calls[0]?.init.body).toBe(
			'{"query":"q","top_k":50,"filters":{"observed_id":"alice"}}',
		);
	});

	it("byIds chunks ids over 100", async () => {
		const ids = Array.from({ length: 150 }, (_, index) => `id-${index + 1}`);
		const { reader, calls } = readerWith([
			jsonResponse({ items: [], total: 0, page: 1, pages: 0 }),
			jsonResponse({ items: [], total: 0, page: 1, pages: 0 }),
		]);
		await expect(reader.byIds(ids)).resolves.toEqual([]);
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
			{ filters: { id: { in: ids.slice(0, 100) } } },
			{ filters: { id: { in: ids.slice(100) } } },
		]);
	});

	it("bearer header only when a key resolves", async () => {
		const withoutKey = readerWith(jsonResponse({ peer_card: [] }));
		await withoutKey.reader.card("alice");
		expect(new Headers(withoutKey.calls[0]?.init.headers).has("authorization")).toBe(false);

		const withKey = readerWith(jsonResponse({ peer_card: [] }), "acme-secret");
		await withKey.reader.card("alice");
		expect(new Headers(withKey.calls[0]?.init.headers).get("authorization")).toBe(
			"Bearer acme-secret",
		);
	});

	it("message 404 is undefined; 500 throws HonchoReadError(500)", async () => {
		const missing = readerWith(new Response("not found", { status: 404 }));
		await expect(missing.reader.message("s1", "m1")).resolves.toBeUndefined();

		const failure = readerWith(new Response("secret response", { status: 500 }));
		const error = await failure.reader.message("s1", "m1").catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(HonchoReadError);
		expect(error).toMatchObject({ status: 500 });
		expect(String(error)).toContain("GET /v3/workspaces/acme/sessions/s1/messages/m1");
	});

	it("card 404 is []", async () => {
		const { reader } = readerWith(new Response("not found", { status: 404 }));
		await expect(reader.card("alice")).resolves.toEqual([]);
	});

	it("error messages never carry the key", async () => {
		const { reader } = readerWith(
			new Response("acme-secret in the response", { status: 500 }),
			"acme-secret",
		);
		const error = await reader
			.list({}, { page: 1, size: 50, reverse: false })
			.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(HonchoReadError);
		expect(String(error)).toContain("POST /v3/workspaces/acme/conclusions/list");
		expect(String(error)).toContain("500");
		expect(String(error)).not.toContain("acme-secret");
	});

	it("sessions asks for newest first", async () => {
		const { reader, calls } = readerWith(
			jsonResponse({
				items: [{ id: "s1", created_at: "2026-11-07T12:00:00Z" }],
				total: 1,
				page: 1,
				pages: 1,
			}),
		);
		await expect(reader.sessions("alice", { page: 1, size: 100 })).resolves.toEqual({
			items: [{ id: "s1", createdAt: "2026-11-07T12:00:00Z" }],
			total: 1,
		});
		expect(calls[0]?.url).toContain("reverse=true");
		expect(calls[0]?.init.method).toBe("POST");
	});

	it("a timeout throws HonchoReadError('network')", async () => {
		const fake = fakeFetch((_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			}),
		);
		const reader = createHonchoReader({
			baseUrl: "https://honcho.example.invalid",
			workspaceId: "acme",
			fetch: fake.fetch,
			timeoutMs: 1,
		});
		const error = await reader.card("alice").catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(HonchoReadError);
		expect(error).toMatchObject({ status: "network" });
	});
});
