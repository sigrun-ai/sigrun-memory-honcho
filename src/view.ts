/**
 * The Honcho view (`src/view.ts`, Task 3: card page + conclusions
 * explorer): a READ-ONLY per-principal view over the caller's OWN
 * Honcho peer. The peer is `sanitize(principal.user)` — the same
 * mapping capture uses — so alice's instance reads alice's memory and
 * an anonymous principal has no instance at all (access "none").
 *
 * Pages (params via `parseViewParams`; EVERY params object — bookmarked
 * AND form-submitted — is parsed BEFORE `conclusionFilters` runs, so a
 * malformed date falls back to "" instead of a 422-bound request or a
 * RangeError in the next-day arithmetic):
 *
 * - `card` (default): the peer card grouped by its `PREFIX: ` lines
 *   (IDENTITY / ATTRIBUTE / RELATIONSHIP first, then others
 *   alphabetically, then "Other" for unprefixed lines), the four level
 *   counts, and the newest conclusion's relative time. The stats cost
 *   SIX reader calls per render BY DESIGN (card, four level counts at
 *   size 1, newest at size 1) — never client-side counting.
 * - `conclusions`: the filter form in the sidebar (level, contains,
 *   meaning, from/to dates, session with a free-entry "Other session",
 *   observer, order) and the results list — 50 per page, newest first
 *   (oldest sets `reverse`), with Previous/Next when `pages > 1`. A
 *   `meaning` filter switches to semantic search (`query`, top 50, no
 *   paging). The session list is read on THIS page only. With `selected`
 *   set, main is the conclusion detail INSTEAD of the results list (never
 *   the page `detail` slot, whose TUI activation would hide premise rows).
 *   Premises and used-by rows keep drilling through `openConclusion`; the
 *   compact back arrow and the Back action pop `trail`. Explicit citations
 *   fetch at most 10 messages concurrently; bodies cap at 2,000 characters.
 *
 * Failure posture: EVERY fetch catches ALL errors — not just
 * `HonchoReadError`: the reader throws a raw SyntaxError when a 2xx
 * body is not JSON (a mistyped baseUrl serving an HTML error page), and
 * that must render the same `bad` callout in place of the failed
 * fetch's block, never a thrown render. The filter form stays present
 * beside a results error. A missing API key renders the not-configured
 * callout without any fetch; a peer with no memory renders the
 * `page.empty` state naming the workspace (the default `sigrun`
 * workspace is a common misconfiguration — the empty state shows it).
 *
 * No `data()` on the surface (every refetch re-runs `render`), no
 * `refreshMs` (no polling: fetches happen in render/actions only).
 * Every fetch's signal is `AbortSignal.any([ctx.signal,
 * AbortSignal.timeout(15_000)])` so an abandoned render aborts its
 * fetches. The API key is used to build the reader and never enters the
 * view's data or tree.
 */

import type {
	ActionResult,
	SigrunHost,
	SurfaceContext,
	SurfaceDef,
	SurfaceRenderResult,
} from "@sigrun/sigrun/extension";

import type { HonchoSettings } from "./config.js";
import type {
	ConclusionPage,
	ConclusionRow,
	HonchoReader,
	MessageRow,
} from "./honcho-read.js";
import { sanitize } from "./honcho.js";
import {
	conclusionFilters,
	filtersFromForm,
	levelCountFilters,
	parseViewParams,
	type HonchoViewParams,
} from "./view-query.js";

/** The results page size (the brief: lists 50; semantic top_k is 50 too). */
const PAGE_SIZE = 50;

/** The session picker's page (newest 100 sessions). */
const SESSION_PAGE_SIZE = 100;

/** The per-fetch deadline (combined with the render's own abort signal). */
const FETCH_TIMEOUT_MS = 15_000;

/** The citation display bounds. */
const CITATION_LIMIT = 10;
const MESSAGE_BODY_LIMIT = 2_000;

/** The not-configured callout body (verbatim — the test pins it). */
const NOT_CONFIGURED =
	"Honcho isn't configured. Set the memory-honcho `api-key` secret or SIGRUN_EXT_MEMORY_HONCHO_API_KEY.";

/** One grouped run of peer-card lines. */
export interface CardGroup {
	readonly group: string;
	readonly lines: readonly string[];
}

/**
 * Group a peer card by the `PREFIX: ` before the first `": "` when the
 * prefix is `[A-Z_]+`; the prefix is stripped from the line. Group order
 * is IDENTITY, ATTRIBUTE, RELATIONSHIP, then other prefixes
 * alphabetically, then "Other" for unprefixed lines.
 */
export function parseCard(lines: readonly string[]): readonly CardGroup[] {
	const groups = new Map<string, string[]>();
	for (const line of lines) {
		const match = /^([A-Z_]+): /.exec(line);
		const group = match?.[1] ?? "Other";
		const text = match === null ? line : line.slice(match[0].length);
		const bucket = groups.get(group) ?? [];
		bucket.push(text);
		groups.set(group, bucket);
	}
	const rank = (group: string): [number, string] => {
		if (group === "IDENTITY") return [0, ""];
		if (group === "ATTRIBUTE") return [1, ""];
		if (group === "RELATIONSHIP") return [2, ""];
		if (group === "Other") return [4, ""];
		return [3, group];
	};
	return [...groups.entries()]
		.sort((a, b) => {
			const [ra, na] = rank(a[0]);
			const [rb, nb] = rank(b[0]);
			return ra !== rb ? ra - rb : na < nb ? -1 : na > nb ? 1 : 0;
		})
		.map(([group, groupLines]) => ({ group, lines: groupLines }));
}

/** The view's dependencies (the factory wires the live ones). */
export interface HonchoViewDeps {
	readonly host: SigrunHost;
	readonly reader: (
		settings: HonchoSettings,
		apiKey: string | undefined,
	) => HonchoReader;
	readonly settings: () => Promise<HonchoSettings>;
	readonly apiKey: () => Promise<string | undefined>;
}

/** The per-level count line's lookup key. */
type CountLevel = "explicit" | "deductive" | "inductive" | "contradiction";
const COUNT_LEVELS: readonly CountLevel[] = [
	"explicit",
	"deductive",
	"inductive",
	"contradiction",
];

/** A fetch's outcome: the value, or the error to render as a callout. */
type FetchOutcome<T> =
	| { readonly value: T }
	| { readonly error: unknown };

/** Run one fetch, catching ALL errors (never just HonchoReadError). */
async function attempt<T>(work: () => Promise<T>): Promise<FetchOutcome<T>> {
	try {
		return { value: await work() };
	} catch (error) {
		return { error };
	}
}

/** The callout one failed fetch renders in place of its block. */
function errorCallout(id: string, error: unknown) {
	return {
		type: "callout" as const,
		id,
		tone: "bad" as const,
		title: "Honcho couldn't answer",
		body: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
	};
}

/** The not-configured callout (no fetch happens at all). */
function notConfiguredTree() {
	return {
		v: 1 as const,
		root: {
			type: "page" as const,
			id: "honcho-root",
			title: "Honcho",
			main: [
				{
					type: "callout" as const,
					id: "honcho-not-configured",
					tone: "warn" as const,
					title: "Honcho isn't configured",
					body: NOT_CONFIGURED,
				},
			],
		},
	};
}

/** The signed-out/none-access tree (an empty page; the route 404s it). */
function emptyTree() {
	return {
		v: 1 as const,
		root: {
			type: "page" as const,
			id: "honcho-root",
			title: "Honcho",
			main: [
				{
					type: "markdown" as const,
					text: "Sign in to see what Honcho knows about you.",
				},
			],
		},
	};
}

/** The page actions both pages carry (switcher-free header). */
function pageActions() {
	return [
		{
			id: "page-card",
			label: "Card",
			action: {
				type: "navigate" as const,
				params: { page: "card" },
			},
		},
		{
			id: "page-conclusions",
			label: "Conclusions",
			action: {
				type: "navigate" as const,
				params: { page: "conclusions" },
			},
		},
	];
}

/** The card page's per-level shortcut buttons (pre-filtered conclusions). */
function levelShortcut(level: "deductive" | "inductive" | "derived") {
	return {
		id: level,
		label: level === "derived" ? "All derived" : level[0]!.toUpperCase() + level.slice(1),
		action: {
			type: "navigate" as const,
			params: { page: "conclusions", level },
		},
	};
}

/** Whether the whole card page is empty (the empty state replaces main). */
function cardIsEmpty(
	card: readonly string[],
	counts: Readonly<Record<CountLevel, number>>,
	newest: ConclusionRow | undefined,
): boolean {
	return (
		card.length === 0 &&
		newest === undefined &&
		COUNT_LEVELS.every((level) => counts[level] === 0)
	);
}

/** The view surface (`SurfaceDef<"view">`), built over the deps. */
export function createHonchoView(deps: HonchoViewDeps): SurfaceDef<"view"> {
	/** Reject for a caller with no instance of their own. */
	const noAccess = (): ActionResult => ({
		ok: false,
		error: { message: "sign in to use the Honcho view" },
	});

	/** The caller's peer, or a reject when they have no instance. */
	function peerOf(ctx: SurfaceContext): { peer: string } | { reject: ActionResult } {
		const user = ctx.principal.user;
		if (user === undefined) return { reject: noAccess() };
		return { peer: sanitize(user) };
	}

	/** The signal every fetch of one render shares. */
	function fetchSignal(ctx: SurfaceContext): AbortSignal {
		return AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
	}

	/** The card page's data: card + four level counts + newest, each
	 *  fetched independently so one failure renders one callout. */
	async function cardData(
		ctx: SurfaceContext,
		peer: string,
		settings: HonchoSettings,
		apiKey: string,
	) {
		const reader = deps.reader(settings, apiKey);
		const signal = fetchSignal(ctx);
		const [card, newest, ...counts] = await Promise.all([
			attempt(() => reader.card(peer, signal)),
			attempt(() =>
				reader.list({ observed_id: peer }, { page: 1, size: 1, reverse: false, signal }),
			),
			...COUNT_LEVELS.map((level) =>
				attempt(() =>
					reader.list(levelCountFilters(peer)[level], {
						page: 1,
						size: 1,
						reverse: false,
						signal,
					}),
				),
			),
		]);
		const countValues = Object.fromEntries(
			COUNT_LEVELS.map((level, index) => {
				const outcome = counts[index]!;
				return [level, "value" in outcome ? (outcome.value.total ?? outcome.value.items.length) : 0];
			}),
		) as Record<CountLevel, number>;
		return {
			workspaceId: settings.workspaceId,
			card: "value" in card ? parseCard(card.value) : [],
			cardError: "error" in card ? card.error : undefined,
			counts: countValues,
			newest: "value" in newest ? newest.value.items[0] : undefined,
			newestError: "error" in newest ? newest.error : undefined,
			countErrors: counts
				.map((outcome, index) =>
					"error" in outcome ? { level: COUNT_LEVELS[index]!, error: outcome.error } : undefined,
				)
				.filter((entry) => entry !== undefined),
		};
	}

	/** The conclusions page's data: the results (list or semantic query)
	 *  and the session picker options. */
	async function conclusionsData(
		ctx: SurfaceContext,
		peer: string,
		params: HonchoViewParams,
		settings: HonchoSettings,
		apiKey: string,
	) {
		const reader = deps.reader(settings, apiKey);
		const signal = fetchSignal(ctx);
		const filters = conclusionFilters(params, peer);
		const [results, sessions] = await Promise.all([
			params.meaning !== ""
				? attempt(() => reader.query(params.meaning, filters, PAGE_SIZE, signal))
				: attempt(() =>
						reader.list(filters, {
							page: params.n,
							size: PAGE_SIZE,
							reverse: params.order === "oldest",
							signal,
						}),
					),
			attempt(() =>
				reader.sessions(peer, { page: 1, size: SESSION_PAGE_SIZE, signal }),
			),
		]);
		return { params, results, sessions };
	}

	/** The card page's tree. */
	function cardTree(data: Awaited<ReturnType<typeof cardData>>) {
		const empty =
			data.cardError === undefined &&
			data.countErrors.length === 0 &&
			data.newestError === undefined &&
			cardIsEmpty(
				data.card.flatMap((group) => group.lines),
				data.counts,
				data.newest,
			);
		return {
			v: 1 as const,
			root: {
				type: "page" as const,
				id: "honcho-root",
				title: "Honcho",
				subtitle: `What Honcho knows about you (workspace ${data.workspaceId})`,
				actions: pageActions(),
				...(empty
					? {
							empty: {
								icon: "user" as const,
								title: `Honcho has nothing about you yet in workspace ${data.workspaceId}.`,
								hint: "Talk to sigrun — Honcho builds this card as you go.",
							},
						}
					: {}),
			main: [
				// The peer card, grouped by prefix. On the EMPTY path main's
				// first block is a COLLECTION bound to /card: both clients'
				// isMainEmpty (webui Page.tsx, tui page.ts) honours page.empty
				// ONLY when the first collection's items binding resolves to a
				// missing/null/empty array — without it the empty state never
				// renders and the peer gets a normal page.
				data.cardError !== undefined
					? errorCallout("card-error", data.cardError)
					: empty
						? {
								type: "collection" as const,
								id: "peer-card",
								display: "list" as const,
								items: { $: "/card" },
								item: { title: { $: "./group" } },
							}
						: {
								type: "section" as const,
								id: "peer-card",
								title: "Peer card",
								children: data.card.map((group) => ({
									type: "markdown" as const,
									id: `card-${group.group}`,
									text: `**${group.group}**\n\n${group.lines.map((line) => `- ${line}`).join("\n")}`,
								})),
							},
					// The level stats + pre-filtered shortcuts.
					{
						type: "section" as const,
						id: "level-counts",
						title: "Conclusions by level",
						children: [
							...data.countErrors.map((entry) =>
								errorCallout(`count-error-${entry.level}`, entry.error),
							),
							{
								type: "markdown" as const,
								id: "level-count-line",
								text: COUNT_LEVELS.map(
									(level) => `**${level}**: ${data.counts[level]}`,
								).join(" · "),
							},
							// The pre-filtered conclusions shortcuts are real
							// action BUTTONS on the stats callout (the block set
							// has no standalone button block; callout.actions is
							// where free-standing buttons live).
							{
								type: "callout" as const,
								id: "level-shortcuts",
								tone: "neutral" as const,
								title: "Explore by level",
								actions: (["deductive", "inductive", "derived"] as const).map(levelShortcut),
							},
						],
					},
					// The newest conclusion's relative time.
					data.newestError !== undefined
						? errorCallout("newest-error", data.newestError)
						: {
								type: "markdown" as const,
								id: "newest-conclusion",
								text:
									data.newest === undefined
										? "No conclusions yet."
										: `Newest conclusion ${relativeTime(data.newest.createdAt)}`,
							},
				],
			},
		};
	}

	/** The selected conclusion's data: the row, premises, used-by and citations. */
	async function detailData(
		ctx: SurfaceContext,
		peer: string,
		params: HonchoViewParams,
		settings: HonchoSettings,
		apiKey: string,
	) {
		const reader = deps.reader(settings, apiKey);
		const signal = fetchSignal(ctx);
		const selected = await attempt(() => reader.byIds([params.selected], signal));
		const candidate = "value" in selected ? selected.value[0] : undefined;
		const conclusion = candidate?.observedId === peer ? candidate : undefined;
		if ("error" in selected || conclusion === undefined) return { selected, params };
		const [premises, usedBy] = await Promise.all([
			conclusion.sourceIds.length === 0
				? Promise.resolve({ value: [] as readonly ConclusionRow[] } as FetchOutcome<readonly ConclusionRow[]>)
				: attempt(() => reader.byIds(conclusion.sourceIds, signal)),
			attempt(() => reader.list(
				{ source_ids: [conclusion.id], observed_id: peer },
				{ page: 1, size: PAGE_SIZE, reverse: false, signal },
			)),
		]);
		let citations: FetchOutcome<readonly (MessageRow | undefined)[]> | undefined;
		if (conclusion.level === "explicit" && conclusion.sourceMessageIds !== null && conclusion.sourceMessageIds.length > 0 && conclusion.sessionId !== null) {
			// Start all capped fetches before awaiting any one response.
			const messageIds = [...new Set(conclusion.sourceMessageIds)].slice(0, CITATION_LIMIT);
			citations = await attempt(() => Promise.all(
				messageIds.map(
					(messageId) => reader.message(conclusion.sessionId!, messageId, signal),
				),
			));
		}
		return { selected, params, conclusion, premises, usedBy, citations };
	}

	/** The level-specific premise title; unknown levels stay neutral. */
	function premiseTitle(level: ConclusionRow["level"]): string {
		switch (level) {
			case "deductive": return "Premises";
			case "inductive": return "Supporting observations";
			case "contradiction": return "Conflicting conclusions";
			default: return "Linked conclusions";
		}
	}

	/** One linked conclusion list (premises or used-by). */
	function conclusionCollection(id: string, rows: readonly ConclusionRow[]) {
		return {
			type: "collection" as const,
			id,
			display: "list" as const,
			items: rows.map((row) => ({ id: row.id, content: row.content })),
			item: { title: { $: "./content" } },
			onActivate: { type: "edit" as const, name: "openConclusion" },
		};
	}

	/** The selected conclusion's tree (the results collection is absent). */
	function detailTree(peer: string, data: Awaited<ReturnType<typeof detailData>>) {
		const params = data.params;
		const backParams = {
			...params,
			selected: params.trail.at(-1) ?? "",
			trail: params.trail.slice(0, -1),
		};
		const conclusion = "conclusion" in data ? data.conclusion : undefined;
		if ("error" in data.selected || conclusion === undefined) {
			return {
				v: 1 as const,
				root: {
					type: "page" as const,
					id: "honcho-root",
					title: "Honcho",
					subtitle: "Conclusions",
					actions: [
						{ id: "back", label: "Back", action: { type: "submit" as const, name: "back" } },
						...pageActions(),
					],
					selection: { selected: true, back: backParams },
					...("error" in data.selected
						? {}
						: { empty: { icon: "info" as const, title: "Conclusion not found" } }),
					main: [
						"error" in data.selected
							? errorCallout("detail-error", data.selected.error)
							: {
								type: "collection" as const,
								id: "conclusion-detail-empty",
								display: "list" as const,
								// Webui isMainEmpty requires a binding to an empty
								// array; a literal works only on the TUI.
								items: { $: "/notFound" },
								item: { title: { $: "./content" } },
							},
					],
				},
			};
		}
		const premises = data.premises!;
		const usedBy = data.usedBy!;
		const citations = data.citations;
		const citationRows = citations !== undefined && "value" in citations
			? citations.value
			: [];
		const missingCitations = citationRows.filter((message) => message === undefined).length;
		const premiseRows = "value" in premises
			? premises.value.filter((row) => row.observedId === peer)
			: [];
		const missingPremises = conclusion.sourceIds.length - premiseRows.length;
		const usedByRows = "value" in usedBy
			? usedBy.value.items.filter((row) => row.observedId === peer)
			: [];
		return {
			v: 1 as const,
			root: {
				type: "page" as const,
				id: "honcho-root",
				title: "Honcho",
				subtitle: "Conclusions",
				actions: [
					{ id: "back", label: "Back", action: { type: "submit" as const, name: "back" } },
					...pageActions(),
				],
				selection: { selected: true, back: backParams },
				main: [
					{
						type: "section" as const,
						id: "conclusion-detail",
						title: "Conclusion",
						children: [
							{ type: "markdown" as const, id: "conclusion-content", text: conclusion.content },
							{
								type: "fields" as const,
								id: "conclusion-fields",
								rows: [
									{ label: "Level", value: conclusion.level },
									{ label: "Observer → observed", value: `${conclusion.observerId} → ${conclusion.observedId}` },
									{ label: "Session", value: conclusion.sessionId ?? "None" },
									{ label: "Created", value: conclusion.createdAt },
									{ label: "Times derived", value: conclusion.timesDerived },
									{ label: "ID", value: conclusion.id },
								],
							},
							{
								type: "callout" as const,
								id: "conclusion-id-actions",
								tone: "neutral" as const,
								title: "Conclusion ID",
								actions: [{
									id: "copy-conclusion-id",
									label: "Copy ID",
									action: { type: "copy" as const, text: conclusion.id },
								}],
							},
						],
					},
					...(conclusion.sourceIds.length === 0
						? []
						: [{
							type: "section" as const,
							id: "premises-section",
							title: premiseTitle(conclusion.level),
							children: [
								...("error" in premises
									? [errorCallout("premises-error", premises.error)]
									: [
										conclusionCollection("premises", premiseRows),
										...(missingPremises > 0
											? [{
												type: "markdown" as const,
												id: "premises-missing",
												text: `${missingPremises} source conclusion${missingPremises === 1 ? " is" : "s are"} no longer available.`,
											}]
											: []),
									]),
							],
						}]),
					...(usedByRows.length > 0
						? [{
							type: "section" as const,
							id: "used-by-section",
							title: "Used by",
							children: [conclusionCollection("used-by", usedByRows)],
						}]
						: "error" in usedBy
							? [errorCallout("used-by-error", usedBy.error)]
							: []),
					...(conclusion.level !== "explicit" || conclusion.sourceMessageIds?.length === 0
						? []
						: [{
							type: "section" as const,
							id: "citations-section",
							title: "Cited messages",
							children: conclusion.sourceMessageIds === null
								? [{
									type: "markdown" as const,
									id: "citations-not-recorded",
									text: "Citations were not recorded for conclusions derived before 2026-11-07.",
								}]
								: conclusion.sessionId === null
									? [{
										type: "markdown" as const,
										id: "citations-no-session",
										text: "The cited messages can't be looked up (no session recorded).",
									}]
									: citations !== undefined && "error" in citations
										? [errorCallout("citations-error", citations.error)]
										: [
											...citationRows.flatMap((message, index) => message === undefined
												? []
												: [{
													type: "section" as const,
													id: `citation-${message.id}`,
													title: `${message.peerId} · ${message.createdAt}`,
													children: [{
														type: "markdown" as const,
														id: `citation-body-${index}`,
														text: message.content.length > MESSAGE_BODY_LIMIT
															? `${message.content.slice(0, MESSAGE_BODY_LIMIT)}…`
															: message.content,
													}],
												}]),
											...(missingCitations > 0
												? [{
													type: "markdown" as const,
													id: "citations-missing",
													text: `${missingCitations} cited message${missingCitations === 1 ? " is" : "s are"} no longer available.`,
												}]
												: []),
											...(conclusion.sourceMessageIds.length > CITATION_LIMIT
												? [{
													type: "markdown" as const,
													id: "citations-capped",
													text: `${conclusion.sourceMessageIds.length - CITATION_LIMIT} more cited messages not shown.`,
												}]
												: []),
										],
						}]),
				],
			},
		};
	}

	/** The conclusions page's tree: filter form sidebar + results main. */
	function conclusionsTree(data: Awaited<ReturnType<typeof conclusionsData>>) {
		const params = data.params;
		const results = data.results;
		const isQuery = params.meaning !== "";
		const page: ConclusionPage | undefined =
			!isQuery && "value" in results
				? (results.value as ConclusionPage)
				: undefined;
		const rows: readonly ConclusionRow[] =
			"value" in results
				? isQuery
					? (results.value as readonly ConclusionRow[])
					: (results.value as { items: readonly ConclusionRow[] }).items
				: [];
		const sessionOptions = [
			{ id: "", label: "Any" },
			...("value" in data.sessions
				? data.sessions.value.items.map((session) => ({
						id: session.id,
						label: session.id,
					}))
				: []),
		];
		const total = page?.total;
		const pages = page?.pages ?? null;
		return {
			v: 1 as const,
			root: {
				type: "page" as const,
				id: "honcho-root",
				title: "Honcho",
				subtitle: "Conclusions",
				actions: pageActions(),
				sidebar: [
					{
						type: "form" as const,
						id: "filters",
						mode: "submit" as const,
						onSubmit: "applyFilters",
						bind: "/form",
						submitLabel: "Apply filters",
						children: [
							{
								type: "choice" as const,
								name: "level",
								label: "Level",
								options: [
									{ id: "all", label: "All" },
									{ id: "explicit", label: "Explicit" },
									{ id: "derived", label: "Derived" },
									{ id: "deductive", label: "Deductive" },
									{ id: "inductive", label: "Inductive" },
									{ id: "contradiction", label: "Contradiction" },
								],
							},
							{
								type: "text" as const,
								name: "text",
								label: "Contains",
								kind: "search" as const,
							},
							{ type: "text" as const, name: "meaning", label: "Meaning" },
							{
								type: "text" as const,
								name: "from",
								label: "From",
								placeholder: "YYYY-MM-DD",
							},
							{
								type: "text" as const,
								name: "to",
								label: "To",
								placeholder: "YYYY-MM-DD",
							},
							{
								type: "choice" as const,
								name: "session",
								label: "Session",
								options: sessionOptions,
								allowOther: { label: "Other session" },
							},
							{
								type: "choice" as const,
								name: "observer",
								label: "Observer",
								options: [
									{ id: "self", label: "Self" },
									{ id: "others", label: "Others" },
									{ id: "any", label: "Any" },
								],
							},
							{
								type: "choice" as const,
								name: "order",
								label: "Order",
								options: [
									{ id: "newest", label: "Newest" },
									{ id: "oldest", label: "Oldest" },
								],
							},
						],
					},
				],
				main: [
					"error" in results
						? errorCallout("results-error", results.error)
						: {
								type: "section" as const,
								id: "results-section",
								children: [
									...(total === undefined || total === null
										? []
										: [
												{
													type: "markdown" as const,
													id: "results-count",
													text: `about ${total} conclusions`,
												},
											]),
									{
										type: "collection" as const,
										id: "results",
										display: "list" as const,
										items: rows.map((row) => ({
											id: row.id,
											content: row.content,
											level: row.level,
											timesDerived: row.timesDerived,
											session: row.sessionId ?? "",
											createdAt: row.createdAt,
											derived:
												row.timesDerived > 1 ? ` ×${row.timesDerived}` : "",
										})),
										item: {
											title: { $: "./content" },
											badges: [{ text: { $: "./level" } }],
											subtitle: { $: "./derived" },
											meta: [
												{ text: { $: "./session" } },
												{ time: { $: "./createdAt" }, format: "relative" as const },
											],
										},
										onActivate: { type: "edit" as const, name: "openConclusion" },
									},
									...(pages !== null && pages > 1
										? [
												{
													type: "callout" as const,
													id: "paging",
													tone: "neutral" as const,
													title: `Page ${page?.page ?? params.n} of ${pages}`,
													// A block-set submit button dispatches a NULL payload,
													// so the target page rides the NAVIGATE params
													// (client-side navigation, no fetch). `goPage` is
													// the same transition for programmatic {n} dispatch.
													actions: [
														...(params.n > 1
															? [
																	{
																		id: "previous",
																		label: "Previous",
																		action: {
																			type: "navigate" as const,
																			params: { ...params, trail: [...params.trail], n: params.n - 1 },
																	},
																},
															]
															: []),
														...(params.n < pages
															? [
																	{
																		id: "next",
																		label: "Next",
																		action: {
																			type: "navigate" as const,
																			params: { ...params, trail: [...params.trail], n: params.n + 1 },
																	},
																},
															]
															: []),
													],
												},
											]
										: []),
								],
							},
				],
			},
		};
	}

	return {
		id: "honcho",
		title: "Honcho",
		icon: "user",
		placement: "view",
		// A principal-owned surface: the principal folds into the instance
		// identity so two users' views are two instances.
		instanceKey: (params, principal) =>
			JSON.stringify([principal.user ?? "", params]),
		render: async (ctx: SurfaceContext): Promise<SurfaceRenderResult> => {
			const who = peerOf(ctx);
			if ("reject" in who) {
				return { tree: emptyTree(), data: {}, access: "none" };
			}
			// The not-configured state never fetches.
			const apiKey = await deps.apiKey();
			if (apiKey === undefined) {
				return { tree: notConfiguredTree(), data: {}, access: "write" };
			}
			const settings = await deps.settings();
			const params = parseViewParams(ctx.params);
			if (params.page === "conclusions") {
				if (params.selected !== "") {
					const data = await detailData(ctx, who.peer, params, settings, apiKey);
					return {
						tree: detailTree(who.peer, data),
						data: "error" in data.selected || !("conclusion" in data)
							? { notFound: [] }
							: {},
						access: "write",
					};
				}
				const data = await conclusionsData(ctx, who.peer, params, settings, apiKey);
				return {
					tree: conclusionsTree(data),
					data: {
						form: {
							level: params.level,
							text: params.text,
							meaning: params.meaning,
							from: params.from,
							to: params.to,
							session: params.session,
							observer: params.observer,
							order: params.order,
						},
					},
					access: "write",
				};
			}
			const data = await cardData(ctx, who.peer, settings, apiKey);
			return {
				tree: cardTree(data),
				// SAFETY: the data document is a JSON mirror (literal fields);
				// the interfaces lack JsonObject's index signature, so the cast
				// only restores that erased identity (curator's view pattern).
				data: {
					card: data.card,
					counts: data.counts,
				} as unknown as SurfaceRenderResult["data"],
				access: "write",
			};
		},
		actions: {
			applyFilters: async (ctx, payload): Promise<ActionResult> => {
				const who = peerOf(ctx);
				if ("reject" in who) return who.reject;
				// Form-submitted values go through parseViewParams too: a
				// malformed date falls back to "" before conclusionFilters
				// could build a 422-bound request (or throw a RangeError).
				const params = parseViewParams({
					...ctx.params,
					...filtersFromForm(payload),
					page: "conclusions",
					n: 1,
				});
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: {
							page: "conclusions",
							level: params.level,
							text: params.text,
							meaning: params.meaning,
							from: params.from,
							to: params.to,
							session: params.session,
							observer: params.observer,
							order: params.order,
							n: 1,
						},
					},
				};
			},
			openConclusion: async (ctx, payload): Promise<ActionResult> => {
				const who = peerOf(ctx);
				if ("reject" in who) return who.reject;
				const itemId =
					typeof payload === "object" && payload !== null && !Array.isArray(payload)
						? (payload as Record<string, unknown>).itemId
						: undefined;
				if (typeof itemId !== "string" || itemId === "") {
					return { ok: false, error: { message: "openConclusion expects {itemId}" } };
				}
				const params = parseViewParams(ctx.params);
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: {
							...params,
							selected: itemId,
							trail: params.selected === "" ? [...params.trail] : [...params.trail, params.selected],
						},
					},
				};
			},
			back: async (ctx): Promise<ActionResult> => {
				const who = peerOf(ctx);
				if ("reject" in who) return who.reject;
				const params = parseViewParams(ctx.params);
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: {
							...params,
							selected: params.trail.at(-1) ?? "",
							trail: params.trail.slice(0, -1),
						},
					},
				};
			},
			goPage: async (ctx, payload): Promise<ActionResult> => {
				const who = peerOf(ctx);
				if ("reject" in who) return who.reject;
				const n =
					typeof payload === "object" && payload !== null && !Array.isArray(payload)
						? (payload as Record<string, unknown>).n
						: undefined;
				if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
					return { ok: false, error: { message: "goPage expects {n} (1-based)" } };
				}
				const params = parseViewParams(ctx.params);
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: { ...params, trail: [...params.trail], n },
					},
				};
			},
		},
	};
}

/** A relative-time phrase ("3h ago") for the newest-conclusion line. */
function relativeTime(iso: string): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return iso;
	const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
