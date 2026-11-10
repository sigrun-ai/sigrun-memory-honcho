/**
 * The Honcho view tests (`src/view.ts`, Tasks 3–4: card page, conclusions
 * explorer and conclusion detail): a read-only, per-principal view over the
 * caller's OWN Honcho peer (`sanitize(principal.user)`).
 *
 * The contract under test:
 *
 * - Every render reads the CALLING principal's peer — alice's instance
 *   reads "alice", never "bob"; an anonymous principal gets access
 *   "none" and no fetch at all.
 * - The card page is the default; its stats cost SIX reader calls per
 *   render BY DESIGN (card, four level counts with
 *   `levelCountFilters(peer)` at size 1, and the newest-conclusion
 *   list at size 1) — never replaced with client-side counting.
 * - Every params object (bookmarked AND form-submitted) goes through
 *   `parseViewParams` BEFORE `conclusionFilters` is called: a malformed
 *   form-submitted date falls back to "" instead of building a
 *   422-bound request or a RangeError.
 * - ALL reader failures — `HonchoReadError` AND any other throw (the
 *   reader's 2xx-non-JSON SyntaxError class) — render a `bad` callout
 *   in place of that fetch's block, filters still present; a render
 *   never throws.
 * - No `data()` on the surface (every refetch re-runs render), no
 *   `refreshMs` (no polling), and every fetch signal is
 *   `AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])`.
 * - The api key never appears in the render result; every tree passes
 *   the server's own `validateTree` with the declared action names.
 *
 * Tests own their literals: peers alice/bob, workspace acme, base URL
 * https://honcho.example.invalid, fake key sk-test-view-key.
 */

import { describe, expect, test, vi } from "vitest";
import type {
	Principal,
	SurfaceContext,
} from "@sigrun/sigrun/extension";
import { validateTree } from "@sigrun/sigrun/blocks";

import type {
	ConclusionPage,
	ConclusionRow,
	HonchoReader,
} from "../src/honcho-read.js";
import { HonchoReadError } from "../src/honcho-read.js";
import type { HonchoSettings } from "../src/settings-schema.js";
import {
	conclusionFilters,
	levelCountFilters,
	parseViewParams,
} from "../src/view-query.js";
import { createHonchoView, parseCard } from "../src/view.js";

const ALICE = "alice";
const BOB = "bob";
const FAKE_KEY = "sk-test-view-key";

/** The settings fixture the view's deps resolve. */
function settings(overrides: Partial<HonchoSettings> = {}): HonchoSettings {
	return {
		agentPeerId: "sigrun",
		baseUrl: "https://honcho.example.invalid",
		workspaceId: "acme",
		contextTokens: 1200,
		maxMessageLength: 8000,
		searchLimit: 8,
		toolPreviewLength: 500,
		representationTtlMs: 600_000,
		outboxRetentionDays: 30,
		deliveredBatchWindow: 200,
		anchorWindow: 1000,
		...overrides,
	};
}

/** One signed-in principal fixture. */
function principal(user: string | undefined): Principal {
	return { user, admin: false, service: false, method: "token" };
}

/** The surface context one render/action receives. */
function ctxOf(
	user: string | undefined,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
): SurfaceContext {
	return {
		principal: principal(user),
		params: params as SurfaceContext["params"],
		key: "test",
		signal: signal ?? new AbortController().signal,
	};
}

/** One conclusion row fixture. */
function conclusionRow(
	id: string,
	overrides: Partial<ConclusionRow> = {},
): ConclusionRow {
	return {
		id,
		content: `content of ${id}`,
		observerId: ALICE,
		observedId: ALICE,
		sessionId: "s1",
		createdAt: "2026-11-07T12:00:00Z",
		level: "explicit",
		sourceIds: [],
		sourceMessageIds: null,
		timesDerived: 1,
		...overrides,
	};
}

function conclusionPage(
	items: readonly ConclusionRow[],
	total: number | null = items.length,
	pages: number | null = 1,
): ConclusionPage {
	return { items, total, page: 1, pages };
}

/** A recording fake reader: every call logged, per-method scripts. */
class FakeReader {
	readonly calls: { method: string; args: readonly unknown[] }[] = [];
	cardLines: readonly string[] = ["IDENTITY: Name: Alice"];
	listPage: ConclusionPage = conclusionPage([]);
	queryRows: readonly ConclusionRow[] = [];
	sessionItems: readonly { id: string; createdAt: string }[] = [];
	/** Per-method throw scripts (ANY error class, not just HonchoReadError). */
	throwOn: Partial<Record<string, unknown>> = {};

	private record(method: string, args: readonly unknown[]): void {
		this.calls.push({ method, args });
		const error = this.throwOn[method];
		if (error !== undefined) throw error;
	}

	async card(peer: string, signal?: AbortSignal): Promise<readonly string[]> {
		this.record("card", [peer, signal]);
		return this.cardLines;
	}

	async list(
		filters: Record<string, unknown>,
		opts: { page: number; size: number; reverse: boolean; signal?: AbortSignal },
	): Promise<ConclusionPage> {
		this.record("list", [filters, opts]);
		return this.listImpl?.(filters, opts) ?? this.listPage;
	}

	async query(
		query: string,
		filters: Record<string, unknown>,
		topK: number,
		signal?: AbortSignal,
	): Promise<readonly ConclusionRow[]> {
		this.record("query", [query, filters, topK, signal]);
		return this.queryRows;
	}

	byIdRows: readonly ConclusionRow[] = [];
	byIdsImpl?: (ids: readonly string[]) => readonly ConclusionRow[];
	messages: Readonly<Record<string, { id: string; peerId: string; content: string; createdAt: string } | undefined>> = {};
	messageOrder: string[] = [];
	messageResolutionOrder: string[] = [];
	messageGate?: Promise<void>;
	listImpl?: (
		filters: Record<string, unknown>,
		opts: { page: number; size: number; reverse: boolean; signal?: AbortSignal },
	) => ConclusionPage;

	async byIds(ids: readonly string[], signal?: AbortSignal): Promise<readonly ConclusionRow[]> {
		this.record("byIds", [ids, signal]);
		return this.byIdsImpl?.(ids) ?? this.byIdRows;
	}

	async sessions(
		peer: string,
		opts: { page: number; size: number; signal?: AbortSignal },
	): Promise<{ items: readonly { id: string; createdAt: string }[]; total: number | null }> {
		this.record("sessions", [peer, opts]);
		return { items: this.sessionItems, total: this.sessionItems.length };
	}

	async message(
		sessionId: string,
		messageId: string,
		signal?: AbortSignal,
	): Promise<{ id: string; peerId: string; content: string; createdAt: string } | undefined> {
		this.record("message", [sessionId, messageId, signal]);
		this.messageOrder = [...this.messageOrder, messageId];
		await this.messageGate;
		this.messageResolutionOrder.push(messageId);
		return this.messages[messageId];
	}

	callsOf(method: string): { method: string; args: readonly unknown[] }[] {
		return this.calls.filter((call) => call.method === method);
	}
}

/** The view over a fake reader (deps seam; the host is unused by the view). */
function viewOf(
	reader: FakeReader,
	opts: { apiKey?: string; workspaceId?: string; onSettingsRead?: () => void } = {},
) {
	return createHonchoView({
		host: {} as never,
		reader: () => reader as unknown as HonchoReader,
		settings: async () => {
			opts.onSettingsRead?.();
			return settings(opts.workspaceId === undefined ? {} : { workspaceId: opts.workspaceId });
		},
		apiKey: async () => opts.apiKey === undefined ? FAKE_KEY : opts.apiKey,
	});
}

/** Validate the tree the way the server does before serving. */
function expectValidTree(tree: unknown, view: { actions?: object }): void {
	const verdict = validateTree(tree as never, {
		placement: "view",
		handlers: new Set(Object.keys(view.actions ?? {})),
	});
	expect(verdict.ok).toBe(true);
}

describe("parseCard", () => {
	test("parseCard groups and strips prefixes", () => {
		expect(
			parseCard(["IDENTITY: Name: Alice", "ATTRIBUTE: Likes tea", "free text"]),
		).toEqual([
			{ group: "IDENTITY", lines: ["Name: Alice"] },
			{ group: "ATTRIBUTE", lines: ["Likes tea"] },
			{ group: "Other", lines: ["free text"] },
		]);
	});

	test("parseCard orders IDENTITY, ATTRIBUTE, RELATIONSHIP, others alphabetically, Other last", () => {
		expect(
			parseCard([
				"free text",
				"ZEBRA: z",
				"RELATIONSHIP: Knows Bob",
				"IDENTITY: Name: Alice",
				"ALPHA: a",
				"ATTRIBUTE: Likes tea",
			]).map((group) => group.group),
		).toEqual(["IDENTITY", "ATTRIBUTE", "RELATIONSHIP", "ALPHA", "ZEBRA", "Other"]);
	});
});

describe("the Honcho view — identity and wiring", () => {
	test("the surface declares id/title/icon/placement and per-principal instanceKey", () => {
		const view = viewOf(new FakeReader());
		expect(view.id).toBe("honcho");
		expect(view.title).toBe("Honcho");
		expect(view.icon).toBe("user");
		expect(view.placement).toBe("view");
		// No data(): every refetch re-runs render. No refreshMs: no polling.
		expect(view.data).toBeUndefined();
		expect(view.refreshMs).toBeUndefined();
		expect(Object.keys(view.actions ?? {}).sort()).toEqual([
			"applyFilters",
			"back",
			"goPage",
			"openConclusion",
		]);
		// The principal folds into the instance identity (two users, two instances).
		const key = view.instanceKey?.(
			{ page: "conclusions" } as never,
			principal(ALICE),
		);
		expect(key).toBe(JSON.stringify([ALICE, { page: "conclusions" }]));
		expect(
			view.instanceKey?.({} as never, principal(BOB)),
		).not.toBe(key);
	});

	test("anonymous principal gets access none", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(undefined));
		expect(rendered.access).toBe("none");
		expectValidTree(rendered.tree, view);
		// No fetch at all for an anonymous caller.
		expect(reader.calls).toEqual([]);
	});
});

describe("the Honcho view — card page", () => {
	test("the default page is the card for the caller's own peer", async () => {
		const reader = new FakeReader();
		reader.cardLines = [
			"IDENTITY: Name: Alice",
			"ATTRIBUTE: Likes tea",
			"free text",
		];
		const newest = conclusionRow("c-new", { createdAt: "2026-11-07T12:00:00Z" });
		const view = viewOf(reader);

		const rendered = await view.render(ctxOf(ALICE));
		expect(rendered.access).toBe("write");
		expectValidTree(rendered.tree, view);

		// card(peer) is the caller's sanitized peer — never bob.
		expect(reader.callsOf("card").map((call) => call.args[0])).toEqual([ALICE]);

		// Four level-count lists, size 1, one per level, exact filters.
		const levelLists = reader.callsOf("list").filter(
			(call) => (call.args[1] as { size: number }).size === 1 &&
				(call.args[0] as { level?: unknown }).level !== undefined,
		);
		expect(levelLists).toHaveLength(4);
		for (const level of ["explicit", "deductive", "inductive", "contradiction"] as const) {
			const expected = levelCountFilters(ALICE)[level];
			const call = levelLists.find(
				(entry) => JSON.stringify(entry.args[0]) === JSON.stringify(expected),
			);
			expect(call, `level count for ${level}`).toBeDefined();
			expect(call?.args[1]).toMatchObject({ page: 1, size: 1, reverse: false });
		}

		// One newest-conclusion list: {observed_id: "alice"}, page 1 size 1.
		const newestCalls = reader.callsOf("list").filter(
			(call) => JSON.stringify(call.args[0]) === JSON.stringify({ observed_id: ALICE }),
		);
		expect(newestCalls).toHaveLength(1);
		expect(newestCalls[0]?.args[1]).toMatchObject({ page: 1, size: 1, reverse: false });

		// The data document carries the grouped card.
		const data = rendered.data as unknown as {
			card: readonly { group: string; lines: readonly string[] }[];
		};
		expect(data.card).toEqual([
			{ group: "IDENTITY", lines: ["Name: Alice"] },
			{ group: "ATTRIBUTE", lines: ["Likes tea"] },
			{ group: "Other", lines: ["free text"] },
		]);

		// The newest row's createdAt renders as "Newest conclusion <relative>".
		reader.listPage = conclusionPage([newest]);
		const withNewest = await view.render(ctxOf(ALICE));
		expectValidTree(withNewest.tree, view);
		const text = JSON.stringify(withNewest.tree);
		expect(text).toMatch(/Newest conclusion (just now|\d+[mhd] ago)/);

		// No other peer is ever read.
		expect(JSON.stringify(reader.calls)).not.toContain(BOB);
	});

	test("card shortcuts navigate to pre-filtered conclusions", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		for (const level of ["deductive", "inductive", "derived"]) {
			expect(text).toContain(`"id":"${level}"`);
			// The navigate params: {"page":"conclusions","level":"<x>"}.
			expect(text).toContain(`"params":{"page":"conclusions","level":"${level}"}`);
		}
		expect(text).toContain('"id":"derived","label":"All derived"');
	});

	test("an empty card with failing stats keeps the error callouts visible", async () => {
		const reader = new FakeReader();
		reader.cardLines = [];
		let lists = 0;
		reader.listImpl = () => {
			lists += 1;
			throw new HonchoReadError(502, "stats unavailable");
		};
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		expect(lists).toBe(5);
		const root = rendered.tree.root as { empty?: unknown };
		// page.empty replaces main wholesale: a stats failure must never
		// masquerade as an empty peer.
		expect(root.empty).toBeUndefined();
		expect(JSON.stringify(root)).toContain("stats unavailable");
	});

	test("each card render resolves settings once", async () => {
		const reader = new FakeReader();
		let settingsReads = 0;
		const view = viewOf(reader, { onSettingsRead: () => { settingsReads += 1; } });
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		expect(settingsReads).toBe(1);
	});

	test("a peer with no memory yet renders the empty state", async () => {
		const reader = new FakeReader();
		reader.cardLines = [];
		// Every count 0 and no newest row (the inert defaults).
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		// The workspace id is named (the default `sigrun` workspace is a
		// common misconfiguration — the empty state must make it visible).
		expect(text).toContain("Honcho has nothing about you yet in workspace acme.");
		// No error callout on the empty path (the level-shortcut callout is
		// neutral, not an error).
		expect(text).not.toContain('"tone":"bad"');

		// The MECHANISM both clients honour (webui Page.tsx isMainEmpty /
		// tui page.ts isMainEmpty): main's FIRST block is a collection whose
		// items is a {$} BINDING resolving to an empty array in the data
		// document. Without that binding, page.empty never renders and the
		// peer gets a normal page instead.
		const root = rendered.tree.root as {
			empty?: unknown;
			main: readonly { type: string; items?: unknown }[];
		};
		expect(root.empty).toBeDefined();
		expect(root.main[0]?.type).toBe("collection");
		expect(root.main[0]?.items).toEqual({ $: "/card" });
		expect((rendered.data as { card: unknown }).card).toEqual([]);
	});
});

describe("the Honcho view — conclusions page", () => {
	test("conclusions page lists 50, newest first, with total", async () => {
		const reader = new FakeReader();
		reader.listPage = conclusionPage(
			[conclusionRow("c1", { level: "deductive", timesDerived: 3 })],
			123,
			3,
		);
		reader.sessionItems = [{ id: "s1", createdAt: "2026-11-07T11:00:00Z" }];
		const view = viewOf(reader);

		const rendered = await view.render(ctxOf(ALICE, { page: "conclusions", n: 2 }));
		expect(rendered.access).toBe("write");
		expectValidTree(rendered.tree, view);

		const defaults = parseViewParams({ page: "conclusions" });
		const expected = conclusionFilters(defaults, ALICE);
		const listCall = reader.callsOf("list").find(
			(call) => (call.args[1] as { size: number }).size === 50,
		);
		expect(listCall?.args[0]).toEqual(expected);
		expect(listCall?.args[1]).toMatchObject({ page: 2, size: 50, reverse: false });

		// The session list is read on the conclusions page only.
		expect(reader.callsOf("sessions")).toHaveLength(1);
		expect(reader.callsOf("sessions")[0]?.args).toMatchObject([
			ALICE,
			{ page: 1, size: 100 },
		]);

		const text = JSON.stringify(rendered.tree);
		// Count line from the server's total.
		expect(text).toContain("about 123 conclusions");
		// The results collection with openConclusion on activate.
		expect(text).toContain('"display":"list"');
		expect(text).toContain('"name":"openConclusion"');
		// The row carries its level badge and ×3 derivation count.
		expect(text).toContain("deductive");
		expect(text).toContain("×3");
		// The filter form is present, bound at /form.
		expect(text).toContain('"bind":"/form"');
		expect(text).toContain('"onSubmit":"applyFilters"');
		// Session choices carry "Any" plus the free-entry other option.
		expect(text).toContain("Other session");
		// pages 3 > 1 → paging buttons.
		expect(text).toContain("Previous");
		expect(text).toContain("Next");
	});

	test("oldest first sets reverse", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, { page: "conclusions", order: "oldest" }));
		expectValidTree(rendered.tree, view);
		const listCall = reader.callsOf("list").find(
			(call) => (call.args[1] as { size: number }).size === 50,
		);
		expect(listCall?.args[1]).toMatchObject({ reverse: true });
	});

	test("page n is sent and Previous/Next appear by pages", async () => {
		const reader = new FakeReader();
		reader.listPage = conclusionPage([conclusionRow("c2")], 100, 2);
		const view = viewOf(reader);
		const rendered = await view.render(
			ctxOf(ALICE, {
				page: "conclusions",
				n: 1,
				level: "deductive",
				text: "kimi",
				session: "s1",
				order: "oldest",
			}),
		);
		expectValidTree(rendered.tree, view);
		const listCall = reader.callsOf("list").find(
			(call) => (call.args[1] as { size: number }).size === 50,
		);
		expect(listCall?.args[1]).toMatchObject({ page: 1 });

		// The Next button's navigate params carry n + 1 AND preserve the
		// active filters (level/text/session/order) — dropping a filter on
		// paging would silently change the result set.
		const root = rendered.tree.root as {
			main: readonly unknown[];
		};
		const paging = JSON.stringify(root.main).match(
			/"id":"next","label":"Next","action":\{"type":"navigate","params":(\{[^}]*\})/,
		);
		expect(paging).not.toBeNull();
		const nextParams = JSON.parse(paging![1]!) as Record<string, unknown>;
		expect(nextParams).toMatchObject({
			n: 2,
			level: "deductive",
			text: "kimi",
			session: "s1",
			order: "oldest",
		});
		// On page 1 of 2 there is no Previous.
		expect(JSON.stringify(root.main)).not.toContain('"id":"previous"');

		// pages === 1 → no paging block at all.
		reader.listPage = conclusionPage([conclusionRow("c1")], 1, 1);
		const single = await view.render(ctxOf(ALICE, { page: "conclusions" }));
		expectValidTree(single.tree, view);
		const singleText = JSON.stringify(single.tree);
		expect(singleText).not.toContain('"id":"paging"');
		expect(singleText).not.toContain("Previous");
		expect(singleText).not.toContain("Next");
	});

	test("a meaning query uses semantic search, no paging", async () => {
		const reader = new FakeReader();
		reader.queryRows = [conclusionRow("c-q")];
		const view = viewOf(reader);
		const rendered = await view.render(
			ctxOf(ALICE, { page: "conclusions", meaning: "how alice works" }),
		);
		expectValidTree(rendered.tree, view);

		const params = parseViewParams({ page: "conclusions", meaning: "how alice works" });
		const queryCall = reader.callsOf("query")[0];
		expect(queryCall?.args[0]).toBe("how alice works");
		expect(queryCall?.args[1]).toEqual(conclusionFilters(params, ALICE));
		expect(queryCall?.args[2]).toBe(50);
		// No results-page list and no paging buttons in semantic mode.
		expect(reader.callsOf("list")).toHaveLength(0);
		const text = JSON.stringify(rendered.tree);
		expect(text).not.toContain("Previous");
		expect(text).not.toContain("Next");
	});
});

describe("the Honcho view — actions", () => {
	test("applyFilters writes the form values into params and resets n", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const result = await view.actions!["applyFilters"]!(
			ctxOf(ALICE, { page: "conclusions", n: 4 }),
			{
				values: {
					level: "derived",
					text: "kimi",
					meaning: "",
					from: "2026-11-01",
					to: "2026-11-03",
					session: { other: "repo_acme" },
					observer: "others",
					order: "oldest",
				},
			} as never,
		);
		expect(result).toEqual({
			ok: true,
			navigate: {
				type: "navigate",
				params: {
					page: "conclusions",
					level: "derived",
					text: "kimi",
					meaning: "",
					from: "2026-11-01",
					to: "2026-11-03",
					session: "repo_acme",
					observer: "others",
					order: "oldest",
					n: 1,
				},
			},
		});
	});

	test("a malformed form-submitted date never reaches the reader", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		// "yesterday" is not YYYY-MM-DD: parseViewParams must fall it back
		// to "" BEFORE conclusionFilters builds the request (else a 422-bound
		// request or a RangeError from the next-day arithmetic).
		const result = await view.actions!["applyFilters"]!(
			ctxOf(ALICE, { page: "conclusions" }),
			{ values: { from: "yesterday", to: "not-a-date" } } as never,
		);
		expect(result).toMatchObject({ ok: true });
		const navigate = (result as { navigate: { params: Record<string, unknown> } })
			.navigate.params;
		expect(navigate.from).toBe("");
		expect(navigate.to).toBe("");

		// And the render path with the same malformed params sends NO
		// created_at filter to Honcho (a bad value must never reach the wire).
		const rendered = await view.render(ctxOf(ALICE, { page: "conclusions", from: "yesterday" }));
		expectValidTree(rendered.tree, view);
		const listCall = reader.callsOf("list").find(
			(call) => (call.args[1] as { size: number }).size === 50,
		);
		expect(listCall?.args[0]).not.toHaveProperty("created_at");
	});

	test("goPage navigates to the requested page number", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const result = await view.actions!["goPage"]!(
			ctxOf(ALICE, { page: "conclusions", n: 1 }),
			{ n: 2 } as never,
		);
		expect(result).toMatchObject({
			ok: true,
			navigate: { type: "navigate", params: { page: "conclusions", n: 2 } },
		});
	});

	test("anonymous callers' actions are rejected without fetching", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		for (const name of ["applyFilters", "openConclusion", "back", "goPage"]) {
			const result = await view.actions![name]!(ctxOf(undefined), {} as never);
			expect(result.ok).toBe(false);
		}
		expect(reader.calls).toEqual([]);
	});
});

describe("the Honcho view — failure and lifecycle states", () => {
	test("Honcho error renders a callout", async () => {
		const reader = new FakeReader();
		reader.throwOn = {
			card: new HonchoReadError(502, "GET /card → 502"),
		};
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain('"type":"callout"');
		expect(text).toContain('"tone":"bad"');
		expect(text).toContain("502");
	});

	test("a non-Honcho reader failure (2xx HTML body SyntaxError) renders the same callout", async () => {
		const reader = new FakeReader();
		// The reader throws a raw SyntaxError when a 2xx body is not JSON
		// (a mistyped baseUrl serving an HTML error page). The view catches
		// ALL errors — never just HonchoReadError — so this still renders.
		reader.throwOn = { card: new SyntaxError("Unexpected token '<'") };
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain('"tone":"bad"');
		expect(text).toContain("SyntaxError");
	});

	test("a conclusions-page list failure keeps the filter form", async () => {
		const reader = new FakeReader();
		reader.throwOn = {
			list: new HonchoReadError(502, "POST /conclusions/list → 502"),
		};
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, { page: "conclusions" }));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain('"tone":"bad"');
		expect(text).toContain("502");
		// The filters are still present beside the error.
		expect(text).toContain('"onSubmit":"applyFilters"');
	});

	test("no API key renders the not-configured state without fetching", async () => {
		const reader = new FakeReader();
		const view = createHonchoView({
			host: {} as never,
			reader: () => reader as unknown as HonchoReader,
			settings: async () => settings(),
			apiKey: async () => undefined,
		});
		const rendered = await view.render(ctxOf(ALICE));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain(
			"Honcho isn't configured. Set the memory-honcho `api-key` secret or SIGRUN_EXT_MEMORY_HONCHO_API_KEY.",
		);
		expect(reader.calls).toEqual([]);
	});

	test("an abandoned render aborts its fetches", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const abort = new AbortController();
		// Abort BEFORE the render: every fetch's signal must already be
		// aborted when the reader observes it (AbortSignal.any of the ctx
		// signal and the 15s timeout).
		abort.abort();
		const rendered = await view.render(ctxOf(ALICE, {}, abort.signal));
		expectValidTree(rendered.tree, view);
		expect(reader.calls.length).toBeGreaterThan(0);
		for (const call of reader.calls) {
			const signal = call.args.find((arg) => arg instanceof AbortSignal) ??
				(call.args[1] as { signal?: AbortSignal } | undefined)?.signal;
			expect(signal, `${call.method} saw a signal`).toBeInstanceOf(AbortSignal);
			expect((signal as AbortSignal).aborted).toBe(true);
		}
	});

	test("view data never contains the api key", async () => {
		const reader = new FakeReader();
		reader.listPage = conclusionPage([conclusionRow("c1")], 1, 1);
		const view = viewOf(reader);
		const card = await view.render(ctxOf(ALICE));
		expectValidTree(card.tree, view);
		expect(JSON.stringify(card)).not.toContain(FAKE_KEY);
		const conclusions = await view.render(ctxOf(ALICE, { page: "conclusions" }));
		expectValidTree(conclusions.tree, view);
		expect(JSON.stringify(conclusions)).not.toContain(FAKE_KEY);
	});
});

describe("the Honcho view — conclusion detail", () => {
	function detailParams(selected = "c1") {
		return { page: "conclusions", selected, trail: [] };
	}

	test("openConclusion pushes the current selection onto trail", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const opened = await view.actions!["openConclusion"]!(
			ctxOf(ALICE, {
				page: "conclusions",
				selected: "c1",
				trail: [],
				level: "deductive",
				text: "kimi",
				n: 2,
			}),
			{ itemId: "c2" } as never,
		);
		expect(opened).toMatchObject({
			ok: true,
			navigate: {
				type: "navigate",
				params: {
					page: "conclusions",
					selected: "c2",
					trail: ["c1"],
					level: "deductive",
					text: "kimi",
					n: 2,
				},
			},
		});
		const popped = await view.actions!["back"]!(
			ctxOf(ALICE, {
				page: "conclusions",
				selected: "c2",
				trail: ["c1"],
				level: "deductive",
				text: "kimi",
				n: 2,
			}),
			{} as never,
		);
		expect(popped).toMatchObject({
			ok: true,
			navigate: {
				type: "navigate",
				params: {
					page: "conclusions",
					selected: "c1",
					trail: [],
					level: "deductive",
					text: "kimi",
					n: 2,
				},
			},
		});
	});

	test("detail shows fields", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", {
			content: "Alice likes loose-leaf tea",
			level: "deductive",
			observerId: "sigrun",
			observedId: "alice",
			sessionId: "s1",
			createdAt: "2026-11-07T12:34:56Z",
			timesDerived: 3,
		})];
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		expect(reader.callsOf("byIds")[0]?.args[0]).toEqual(["c1"]);
		const text = JSON.stringify(rendered.tree);
		for (const expected of [
			"Alice likes loose-leaf tea",
			"deductive",
			"sigrun → alice",
			"s1",
			"2026-11-07T12:34:56Z",
			"3",
			"c1",
			"Times derived",
		]) expect(text).toContain(expected);
		// The id is copyable through the block set's copy action.
		expect(text).toContain('"id":"copy-conclusion-id","label":"Copy ID","action":{"type":"copy","text":"c1"}');
		// The detail replaces main, not the page detail slot or results.
		const root = rendered.tree.root as { detail?: unknown; selection?: unknown };
		expect(root.detail).toBeUndefined();
		expect(text).not.toContain('"id":"results"');
		expect(root.selection).toEqual({
			selected: true,
			back: { ...parseViewParams(detailParams()), selected: "", trail: [] },
		});
	});

	test("premises section is titled by level", async () => {
		for (const [level, title] of [
			["deductive", "Premises"],
			["inductive", "Supporting observations"],
			["contradiction", "Conflicting conclusions"],
		] as const) {
			const reader = new FakeReader();
			reader.byIdRows = [
				conclusionRow("c1", { level, sourceIds: ["p1", "p2"] }),
				conclusionRow("p1"),
				conclusionRow("p2"),
			];
			const view = viewOf(reader);
			const rendered = await view.render(ctxOf(ALICE, detailParams()));
			expectValidTree(rendered.tree, view);
			const text = JSON.stringify(rendered.tree);
			expect(text).toContain(`"title":"${title}"`);
			expect(reader.callsOf("byIds").map((call) => call.args[0])).toEqual([
				["c1"],
				["p1", "p2"],
			]);
			const premises = text.match(/"id":"premises",[\s\S]*?"onActivate":\{"type":"edit","name":"openConclusion"\}/);
			expect(premises).not.toBeNull();
			expect(premises?.[0]).toContain('"id":"p1"');
			expect(premises?.[0]).toContain('"id":"p2"');
		}
	});

	test("missing premises are counted", async () => {
		const reader = new FakeReader();
		reader.byIdsImpl = (ids) => JSON.stringify(ids) === JSON.stringify(["c1"])
			? [conclusionRow("c1", { level: "deductive", sourceIds: ["p1", "p2", "p3"] })]
			: [conclusionRow("p1"), conclusionRow("p3")];
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		const premisesCall = reader.callsOf("byIds").find(
			(call) => JSON.stringify(call.args[0]) === JSON.stringify(["p1", "p2", "p3"]),
		);
		expect(premisesCall).toBeDefined();
		// The source-id response omits p2; it is counted, not rendered as a row.
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain("1 source conclusion is no longer available.");
		expect(text).not.toContain('"id":"p2"');
	});

	test("used by lists conclusions derived from this one", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1")];
		const usedByFilters = { source_ids: ["c1"], observed_id: ALICE };
		reader.listImpl = (filters) => JSON.stringify(filters) === JSON.stringify(usedByFilters)
			? conclusionPage([conclusionRow("c2")])
			: conclusionPage([]);
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		const usedBy = reader.callsOf("list").find(
			(call) => JSON.stringify(call.args[0]) === JSON.stringify(usedByFilters),
		);
		expect(usedBy).toBeDefined();
		expect(usedBy?.args[1]).toMatchObject({ page: 1, size: 50, reverse: false });
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain('"title":"Used by"');
		expect(text).toContain('"id":"c2"');
		reader.listImpl = () => conclusionPage([]);
		const empty = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(empty.tree, view);
		expect(JSON.stringify(empty.tree)).not.toContain('"title":"Used by"');
	});

	test("explicit with citations shows the messages", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", {
			sourceMessageIds: ["m1", "m2"],
			sessionId: "s1",
		})];
		reader.messages = {
			m1: {
				id: "m1",
				peerId: "alice",
				content: "first cited body",
				createdAt: "2026-11-07T10:00:00Z",
			},
			m2: undefined,
		};
		let releaseMessages!: () => void;
		reader.messageGate = new Promise<void>((resolve) => { releaseMessages = resolve; });
		const view = viewOf(reader);
		const renderPromise = view.render(ctxOf(ALICE, detailParams()));
		// A serial implementation records m1 and waits forever for its gated
		// response before recording m2, so this wait fails instead of passing.
		await vi.waitFor(() => {
			expect(reader.messageOrder).toEqual(["m1", "m2"]);
		});
		expect(reader.messageResolutionOrder).toEqual([]);
		releaseMessages();
		const rendered = await renderPromise;
		expectValidTree(rendered.tree, view);
		expect(reader.callsOf("message").map((call) => call.args.slice(0, 2))).toEqual([
			["s1", "m1"],
			["s1", "m2"],
		]);
		expect(reader.messageResolutionOrder).toEqual(["m1", "m2"]);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain("first cited body");
		expect(text).toContain("1 cited message is no longer available.");
	});

	test("duplicate citation ids fetch once and produce unique block ids", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", { sourceMessageIds: ["m1", "m1"] })];
		reader.messages = {
			m1: {
				id: "m1",
				peerId: "alice",
				content: "cited once",
				createdAt: "2026-11-07T10:00:00Z",
			},
		};
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		expect(reader.callsOf("message").map((call) => call.args[1])).toEqual(["m1"]);
		expect(JSON.stringify(rendered.tree).match(/"id":"citation-m1"/g)).toHaveLength(1);
	});

	test("cited messages are capped at 10", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", {
			sourceMessageIds: Array.from({ length: 14 }, (_, index) => `m${index + 1}`),
		})];
		reader.messages = Object.fromEntries(
			Array.from({ length: 14 }, (_, index) => [`m${index + 1}`, {
				id: `m${index + 1}`,
				peerId: "alice",
				content: `body ${index + 1}`,
				createdAt: "2026-11-07T10:00:00Z",
			}]),
		);
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		expect(reader.callsOf("message")).toHaveLength(10);
		expect(JSON.stringify(rendered.tree)).toContain("4 more cited messages not shown.");
	});

	test("cited message bodies cap at 2,000 characters", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", { sourceMessageIds: ["m1"] })];
		reader.messages = {
			m1: {
				id: "m1",
				peerId: "alice",
				content: "x".repeat(2_001),
				createdAt: "2026-11-07T10:00:00Z",
			},
		};
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain(`${"x".repeat(2_000)}…`);
		expect(text).not.toContain("x".repeat(2_001));
	});

	test("citations with no session", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", {
			sessionId: null,
			sourceMessageIds: ["m1"],
		})];
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		expect(reader.callsOf("message")).toEqual([]);
		expect(JSON.stringify(rendered.tree)).toContain(
			"The cited messages can't be looked up (no session recorded).",
		);
	});

	test("explicit without citations shows the not-recorded line", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [conclusionRow("c1", { sourceMessageIds: null })];
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		expect(JSON.stringify(rendered.tree)).toContain(
			"Citations were not recorded for conclusions derived before 2026-11-07.",
		);
	});

	test("foreign conclusions and linked rows are hidden from the caller's peer", async () => {
		const reader = new FakeReader();
		reader.byIdsImpl = (ids) => JSON.stringify(ids) === JSON.stringify(["foreign"])
			? [conclusionRow("foreign", { observedId: BOB, content: "Bob's private conclusion" })]
			: [];
		const view = viewOf(reader);
		const foreign = await view.render(ctxOf(ALICE, detailParams("foreign")));
		expectValidTree(foreign.tree, view);
		const foreignRoot = foreign.tree.root as { empty?: { title: string } };
		expect(foreignRoot.empty?.title).toBe("Conclusion not found");
		expect(JSON.stringify(foreign.tree)).not.toContain("Bob's private conclusion");
		expect(reader.callsOf("list")).toHaveLength(0);
		expect(reader.callsOf("message")).toHaveLength(0);

		reader.byIdsImpl = (ids) => JSON.stringify(ids) === JSON.stringify(["c1"])
			? [conclusionRow("c1", { level: "deductive", sourceIds: ["p1", "p2", "p3"] })]
			: [conclusionRow("p1"), conclusionRow("p2", { observedId: BOB })];
		reader.listImpl = () => conclusionPage([
			conclusionRow("used-alice"),
			conclusionRow("used-bob", { observedId: BOB }),
		]);
		const linked = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(linked.tree, view);
		const text = JSON.stringify(linked.tree);
		expect(text).toContain('"id":"p1"');
		expect(text).toContain('"id":"used-alice"');
		expect(text).not.toContain('"id":"p2"');
		expect(text).not.toContain('"id":"used-bob"');
		// The foreign p2 and the unresolved p3 both count as unavailable.
		expect(text).toContain("2 source conclusions are no longer available.");
	});

	test("a non-empty source list with an unrecognized level uses a neutral title", async () => {
		const reader = new FakeReader();
		reader.byIdRows = [
			conclusionRow("c1", { sourceIds: ["p1"] }),
			conclusionRow("p1"),
		];
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams()));
		expectValidTree(rendered.tree, view);
		expect(JSON.stringify(rendered.tree)).toContain('"title":"Linked conclusions"');
		expect(JSON.stringify(rendered.tree)).not.toContain('"title":"Conflicting conclusions"');
	});

	test("selected id not found renders an empty detail with Back", async () => {
		const reader = new FakeReader();
		const view = viewOf(reader);
		const rendered = await view.render(ctxOf(ALICE, detailParams("missing")));
		expectValidTree(rendered.tree, view);
		expect(reader.callsOf("byIds")[0]?.args[0]).toEqual(["missing"]);
		const root = rendered.tree.root as {
			empty?: { title: string };
			actions?: readonly { id: string; label: string }[];
			main: readonly { type: string; items?: unknown }[];
		};
		expect(root.empty?.title).toBe("Conclusion not found");
		expect(root.actions?.some((action) => action.id === "back" && action.label === "Back")).toBe(true);
		expect(JSON.stringify(rendered.tree)).toContain('"type":"submit","name":"back"');
		// Webui isMainEmpty requires a bound empty collection, not a literal.
		expect(root.main[0]?.type).toBe("collection");
		expect(root.main[0]?.items).toEqual({ $: "/notFound" });
		expect((rendered.data as { notFound?: unknown }).notFound).toEqual([]);
	});
});
