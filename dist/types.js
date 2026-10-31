/**
 * The memory-seam contract restated structurally.
 *
 * `RunSettledEventLike` and `MemoryEventApiLike` mirror the host contract
 * (sigrun `src/harness/event-bus.ts` / `src/extension.ts`) — declared
 * structurally, with NO core runtime import, so this module compiles against
 * the `@sigrun/sigrun` devDependency's types without pinning a release.
 * The host passes real values; anything satisfying these shapes works.
 */
export {};
