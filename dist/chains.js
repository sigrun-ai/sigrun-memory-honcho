/**
 * Per-label serialization chains (the pi port's `enqueue` pattern).
 *
 * Work appended under a label runs strictly after the previously queued
 * work for that label settles, so Honcho saves for one conversation
 * happen in order without racing. The caller's promise settles with the
 * work's own result; the internal TAIL promise never rejects (it
 * self-catches and reports via `console.error` labeled with the chain
 * name), so one failing save cannot poison the conversation's queue.
 */
const tails = new Map();
export function chain(label, work) {
    const run = (tails.get(label) ?? Promise.resolve()).then(work);
    // The tail self-catches: a rejection is reported once here and never
    // propagates into the next queued item (which would re-report it).
    const tail = run.then(() => undefined, (error) => {
        console.error(`memory-honcho: chain "${label}" work failed`, error);
    });
    tails.set(label, tail);
    void tail.then(() => {
        // Drop the tail once settled, unless newer work already extended it.
        if (tails.get(label) === tail)
            tails.delete(label);
    });
    return run;
}
/**
 * Drain hook for `harnessShutdown`: resolves once every tail live at
 * call time has settled.
 */
export function chainTails() {
    return Promise.all([...tails.values()]);
}
