/**
 * Fork clone-anchor selection (spec §Forks, the five-branch table).
 *
 * Pure — no I/O, no Honcho. The "no pending-fork record" branch lives in
 * `establish` (src/delivery.ts): `pickCloneAnchor` sees only a ledger's
 * anchors and never decides whether a fork happened at all.
 *
 * A whole-session `clone()` is NEVER selected (it would import post-fork
 * content — the anti-goal); a clone always names a message id.
 */
import type { LedgerAnchor } from "./types.js";
export type CloneAnchorDecision = {
    readonly kind: "clone";
    readonly messageId: string;
} | {
    readonly kind: "fresh";
    /** Why a fresh session was started instead of a clone. */
    readonly inherit: "none-window" | "none-empty";
};
/**
 * Pick the clone anchor for a fork at entry id `at`:
 *
 * 1. Newest anchor with `entryId <= at` → clone at that anchor's message.
 * 2. `at` after the newest retained anchor (a trailing user input, or
 *    delivery lag while a batch is still pending) → clone at the newest
 *    anchor; bounded under-inclusion only, never past-fork content.
 * 3. `at` before the oldest retained anchor (the window moved past the
 *    fork point) → fresh, `inherit: "none-window"`.
 * 4. Empty anchor list (ledger exists, nothing ever delivered) → fresh,
 *    `inherit: "none-empty"`.
 */
export declare function pickCloneAnchor(anchors: readonly LedgerAnchor[], at: number): CloneAnchorDecision;
