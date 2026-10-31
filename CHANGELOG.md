# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-31

### Fixed

- `establish` adds session peers via the SDK's tuple form
  (`[[peerId, {observeMe, observeOthers}]]`) instead of the documented
  map form — the SDK's client-side zod union rejects the map form, so
  every first-capture establishment failed against a real server
  (verified live against honcho v3.0.9).

## [0.1.0] - 2026-10-31
### Added
- Honcho persistent-memory extension for sigrun (pi-durable). Every
  settled run (answered and unanswered) appends one capture batch to a
  durable JSONL outbox under a module-level mutex, then kicks
  fire-and-forget delivery; per-conversation selection gating reads the
  conversation's `AgentDoc.extensions` (array-form exclusion skips
  capture; positive verdicts memoized per conversation).
- Delivery engine: per-conversation serialization chains; lazy session
  establishment (get-or-create `sigrun-<conversationId>` with map-form
  peer observation config and `summary`/`dream` enabled); batchId
  dedup via the ledger's delivered-batch window; fork anchors
  (sigrun entry id → Honcho message id) folded on delivery; an
  accepted send-then-crash duplicate window documented.
- Fork continuity: `conversationForked` writes a durable pending-fork
  record with zero network; the child's first delivery clones the
  parent's Honcho session at the newest anchor at-or-before the fork
  point (`pickCloneAnchor`: clone / fresh-session `none-window` /
  `none-empty`), with clone-duplicate mitigation by write-ahead fork
  records and status-route session counts.
- Cron job `outbox-sweep` (`*/15 * * * *`, task action
  `honcho-outbox-sweep`): fork-first establishment, per-conversation
  redelivery, then compaction — delivered records dropped, over-retention
  pending records dropped with a per-record warning.
- Representation cache + two prompt sections (`long-term-memory`,
  `honcho-memory`) rendering synchronously from the cache; leading-edge
  refresh at first delivery; wake-only worker `honcho-representations`
  (`conversationIdle`/`conversationArchived`) re-refreshes the woken
  conversation through the memoized engine client.
- Recall tools `honcho_search` (author-scoped `Peer.search`),
  `honcho_chat` (peer-pair dialectic, no session scope), and
  `honcho_remember` (session-less `conclusionsOf` write — the
  README documents the visibility caveat).
- Status route `GET /v1/ext/memory-honcho/status` (`auth: "user"`):
  config summary with the key projected to a `configured` boolean,
  `lastDeliveryAt` from the persistent `state/last-delivery.json`
  marker (falling back to retained-record derivation), outbox/ledger/
  fork/session counts, and worker bookkeeping — best-effort, degrading
  to zeroed counts on a corrupt file rather than failing the request.
- `userDeleted`: departure notice only — no data movement (peers are
  server-side Honcho state; transfer is Honcho-side or deferred).
- `harnessShutdown` drains delivery chains under a 25s deadline.
- Settings/secret resolution: `resolveSettings` (eleven keys with
  defaults and numeric validation) and `resolveApiKey` (stored
  `api-key` secret, then env `SIGRUN_EXT_MEMORY_HONCHO_API_KEY`) —
  both read live per use, so a key written after boot applies at the
  next event without a restart.
