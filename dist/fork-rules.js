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
export function pickCloneAnchor(anchors, at) {
    if (anchors.length === 0)
        return { kind: "fresh", inherit: "none-empty" };
    let newest;
    for (const anchor of anchors) {
        if (anchor.entryId <= at && (newest === undefined || anchor.entryId > newest.entryId)) {
            newest = anchor;
        }
    }
    if (newest !== undefined)
        return { kind: "clone", messageId: newest.messageId };
    const oldest = anchors.reduce((min, anchor) => anchor.entryId < min.entryId ? anchor : min);
    if (at > oldest.entryId) {
        // `at` precedes no anchor yet isn't before the oldest ⇒ it sits after
        // the newest: clone at the newest retained anchor.
        const latest = anchors.reduce((max, anchor) => anchor.entryId > max.entryId ? anchor : max);
        return { kind: "clone", messageId: latest.messageId };
    }
    return { kind: "fresh", inherit: "none-window" };
}
