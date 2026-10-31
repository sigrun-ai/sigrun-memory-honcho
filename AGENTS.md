# AGENTS.md — sigrun-memory-honcho

Guidance for coding agents working in this repository.

## What this is

Honcho persistent-memory extension for [sigrun](https://github.com/sigrun-ai/sigrun)
(pi-durable loader contract): a default-export factory consumed by sigrun's
extension loader. Capture via `runSettled` + a durable outbox, clone-with-mapping
fork continuity, cross-conversation peer-level recall, per-conversation prompt
sections, an idle-worker representation refresh, and a cron sweeper job. Small,
single-purpose, no cross-extension coupling.

## Layout

- `src/index.ts` — public surface (the factory).
- `src/config.ts` — settings/secret resolution (`resolveSettings`, `resolveApiKey`).
- `test/` — vitest suites.
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # manifest check + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design (see the `.gitignore` comment). If
  `git status` shows `dist/` changes after a build, those belong in the
  same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- Tests own their literals: synthetic users, stubbed Honcho (fake SDK),
  no real keys, no live Honcho in fixtures.
- Secrets: stored `secrets.json` section `api-key` first, then env
  `SIGRUN_EXT_MEMORY_HONCHO_API_KEY`; fresh read per use, never in settings.
