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
type Work<T> = () => Promise<T>;
export declare function chain<T>(label: string, work: Work<T>): Promise<T>;
/**
 * Drain hook for `harnessShutdown`: resolves once every tail live at
 * call time has settled.
 */
export declare function chainTails(): Promise<void[]>;
export {};
