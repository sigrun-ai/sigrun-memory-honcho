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
import type { SigrunHost, SurfaceDef } from "@sigrun/sigrun/extension";
import type { HonchoSettings } from "./config.js";
import type { HonchoReader } from "./honcho-read.js";
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
export declare function parseCard(lines: readonly string[]): readonly CardGroup[];
/** The view's dependencies (the factory wires the live ones). */
export interface HonchoViewDeps {
    readonly host: SigrunHost;
    readonly reader: (settings: HonchoSettings, apiKey: string | undefined) => HonchoReader;
    readonly settings: () => Promise<HonchoSettings>;
    readonly apiKey: () => Promise<string | undefined>;
}
/** The view surface (`SurfaceDef<"view">`), built over the deps. */
export declare function createHonchoView(deps: HonchoViewDeps): SurfaceDef<"view">;
