# @sigrun/memory-honcho

Honcho persistent-memory extension for [sigrun](https://github.com/sigrun-ai/sigrun) (pi-durable).

Sigrun's memory seam delivers every settled run to this extension, which captures both halves of the turn into a durable on-disk outbox and delivers them to [Honcho](https://github.com/plastic-labs/honcho) — cross-conversation, peer-level memory: Honcho derives a representation of each user from every conversation the agent shared with them, and this extension recalls through tools and renders a per-conversation prompt section from a cached copy of that representation.

Why Honcho over a local file store: derivation (dreams, summaries, peer representations) runs **server-side** — the client's only jobs are capture delivery and representation refresh, both scheduled here; nothing else is ported.

## Install

```jsonc
// settings.json (sigrun config dir) — the UNIFIED extensions list:
// install + load in one place; npm specifiers
// ("@sigrun/memory-honcho@^0.1.0") and the file: form below are the
// same list.
{
	"extensions": ["file:/path/to/sigrun-memory-honcho"]
}
```

## Configuration

**API key** — resolution order, fresh read per use (stored wins without restart):

1. the stored secret: section `api-key` in `<configDir>/secrets.json`, then
2. the `SIGRUN_EXT_MEMORY_HONCHO_API_KEY` environment variable.

With no key configured, captures still append to the outbox and the sweeper delivers them once a key appears — a key added after boot applies at the next event, no restart.

**Settings** — `<configDir>/settings/memory-honcho.json`, all optional (defaults in parentheses), read live per use: `workspaceId` (`"sigrun"`), `agentPeerId` (`"sigrun"`), `baseUrl` (the Honcho SDK default — omit for honcho.dev), `contextTokens` (1200), `maxMessageLength` (8000), `searchLimit` (8), `toolPreviewLength` (500), `representationTtlMs` (600000), `outboxRetentionDays` (30), `deliveredBatchWindow` (200), `anchorWindow` (1000). Operator caution: changing `workspaceId` or `baseUrl` after first capture leaves stale sessions in the old workspace.

## On-disk layout

The host hands the extension three store roots; writes are atomic (temp + rename):

- `data/outbox/capture.jsonl` — the durable outbox, the **only durable copy** of not-yet-delivered conversation content (the backed-up bucket).
- `state/ledger/<conversationId>.json` — per-conversation bookkeeping: the Honcho session mapping, the delivered-batchId window (dedup), and the fork anchors (sigrun entry id → Honcho message id).
- `state/forks/pending/<childId>.json` — fork-mapping records, written by the fork handler with zero network, resolved on clone.
- `state/last-delivery.json` — the persistent newest-delivery marker the status route reads (the sweeper drops delivered records, so the marker is the surviving source in steady state).
- `cache/representations/<conversationId>.json` — the representation snapshots the prompt section renders.

## Capture semantics

Every settled run (answered **and** unanswered) appends one outbox record with the user inputs and the answer, then kicks fire-and-forget delivery; a missing key skips only the kick — the sweeper delivers later. Delivery is per-conversation chain-serialized; the delivered-batchId window in the ledger makes redelivery idempotent.

**Selection gating:** the conversation's per-conversation extension selection is read per settle. The array form (`{extensions: ["…"]}`) selects exactly its members — an array not naming `@sigrun/memory-honcho` skips capture. The object form (`{add, remove}`) edits the host default and does not exclude this extension — a `remove` of us is a no-op, because we are not host-default. Positive verdicts are memoized per conversation (a `false` is re-read on the next event, so a mid-conversation opt-in captures). **Residual, accepted for v1:** an array-form opt-out issued *after* a positive verdict keeps capturing until the process restarts.

**Pending-input visibility:** `runSettled` fires on settle — inputs queued or typed mid-run are invisible to capture until the run settles.

## Recall tools

- **`honcho_search`** (`query`) — workspace-wide search over the calling user's own messages, across conversations. **Author-scoped, stated honestly:** `Peer.search` returns messages with that peer as *author* — user text only, never assistant answers; assistant recall lives in `honcho_chat` and the section representation.
- **`honcho_chat`** (`query`, `reasoningLevel?`) — a dialectic query over the agent peer's full representation of the calling user (no session scope).
- **`honcho_remember`** (`content`) — writes a conclusion about the calling user (`conclusionsOf`), **with no `sessionId`**: a remembered fact is user-level, not conversation-level, matching the cross-conversation recall ruling. **Visibility caveat (not yet live-verified):** whether a session-less conclusion appears in the session-scoped representation the prompt section renders depends on Honcho's default `limitToSession` behavior; if it is scoped out, a remembered fact may not surface in the section — the tool would need to stamp the calling session's id.

**Privacy boundary (qualified):** `honcho_search` is author-scoped — one user's search returns only messages captured under their own peer. `honcho_chat` and representations are **peer-pair-scoped**: the agent peer's representation of a user derives from every session where the agent observed that user — *including shared conversations*, where `observeOthers` derives over co-participants' turns too. In a multi-user deployment with shared conversations, a `honcho_chat` answer can therefore reflect another user's turns from a co-observed session (Honcho's own derivation semantics, not a sigrun leak). Single-user deployments are unaffected. Peer ids ARE the sigrun usernames — stable, not anonymizing.

## Fork semantics

A sigrun fork writes a durable pending-fork record (zero network); the child's first capture establishes its Honcho session as a **clone** of the parent's session, cut at the parent's fork anchor — the child inherits the parent's Honcho history to the fork point.

**What clone buys (honest premise):** the SDK documents `clone` as a copy of the session's *messages* ("up to and including that message"); nothing promises conclusions or derived representations are copied. The child's representations are **re-derived server-side** from the cloned messages. The value is transcript continuity for derivation, not pre-warmed conclusions. (Live verification of what clone copies is outstanding; the design does not depend on the stronger reading.)

**Granularity limit (accepted):** only assistant answers carry Honcho anchors — a fork at a user input entry clones to the answer *before* it, so the child's Honcho history may miss the trailing user input that sigrun's transcript includes.

**Fork precondition:** the pending-fork record must exist when the child first captures — a conversation forked **before** this extension was loaded has no record and starts a fresh session (no history).

## Honcho view

The read-only **Honcho** view shows the calling user's own peer card and conclusions. The **Card** page groups the peer card and summarizes conclusion levels; **Conclusions** provides server-side level, text, semantic, date, session and observer filters with 50-row pages. Searches live in the view params, so they are bookmarkable.

Selecting a conclusion opens its full fields, linked premises (or supporting/conflicting conclusions), conclusions derived from it, and citations for explicit conclusions. Premise and used-by rows drill into further conclusions with Back navigation. At most 10 cited messages are fetched concurrently; message bodies wrap and cap at 2,000 characters. Missing premises or citations are counted without hiding the records that remain. The view never writes to Honcho, never exposes the API key to clients, and renders fetch failures as callouts.

## Jobs and worker

- **Cron job `outbox-sweep`** (`*/15 * * * *`) — the delivery engine of record: resolves pending forks, delivers each conversation's pending records, then compacts (delivered records are dropped; pending records older than `outboxRetentionDays` are dropped with a warning per record). The sweep keeps working when Honcho is down — failures are per-conversation and the next sweep retries.
- **Wake-only worker `honcho-representations`** (`conversationIdle`, `conversationArchived`) — re-refreshes the woken conversation's representation cache, which the two prompt sections (`long-term-memory`, `honcho-memory`) render synchronously. A delivered conversation with no cache also refreshes once at delivery (the leading edge).

## Status route

`GET /v1/ext/memory-honcho/status` (`auth: "user"`): config summary (never key material — the key projects to a `configured` boolean), newest-delivery time (`lastDeliveryAt`, from the persistent marker), pending outbox count, ledger/session counts (session counts make the accepted clone-duplicate window operator-visible), pending-fork count, and the extension's own worker bookkeeping (last-run, last-error — the route cannot read the host's `/v1/meta` worker projection). Caveats: the counts are **global** across users — the route answers for the whole deployment to any authenticated user; and a corrupt store file degrades that bucket's counts to zero rather than failing the request.

## Troubleshooting

- **Honcho down** — captures stay pending in the outbox; the sweeper retries every 15 minutes. Sections render the last-good cache. Tool calls throw a clean error naming the extension.
- **Key added after boot** — nothing to restart: secrets and settings are re-read per use, so the next settled run delivers (and the sweeper drains the backlog).
- **A fork child has no history** — check the fork precondition above: the fork must happen while this extension is loaded.

## Limitations

- `honcho_search` is author-scoped: it returns the user's *own* messages only — assistant answers are reachable through `honcho_chat` and the section representation, not through search.
- Chat and representations are peer-pair-scoped: in a multi-user deployment with shared conversations, a `honcho_chat` answer can reflect another user's turns from a co-observed session (Honcho's derivation semantics). Operators who need a hard boundary would drop `observeOthers` (a future setting).
- Fork clone = transcript continuity: the child inherits the parent's messages to the fork point and Honcho re-derives conclusions and representations from them — conclusions are session-scoped and are *not* copied by the clone.
- `honcho_remember` writes a session-less (global) conclusion; whether it surfaces in the session-scoped representation depends on Honcho's `limitToSession` default — not yet live-verified.
- Pending-input visibility: capture sees a run's inputs only at settle.
- Fork precondition: a conversation forked before this extension was loaded starts with a fresh Honcho session.
- **Queue-overflow capture loss (accepted, host posture):** under host event-queue overflow the oldest queued event is dropped — a dropped settle is a run the extension never sees, so its capture batch is permanently lost (the outbox cannot recover an event it never received).
- **Clone duplicate window (accepted):** a clone that succeeds server-side but crashes before the ledger write retries into a duplicate full-history session — rare, bounded to one duplicate per crash, and non-corrupting (the ledger points at exactly one session); the status route's session count makes duplicates operator-visible.
- **Jobs-posture caveat:** a task-action job whose run dies un-settled (harness close mid-run) leaves the host's job-run record `running` until restart — the host has no staleness sweep; this extension's sweeper is exposed to it like every task-action job.
- **Windows: the `honcho-representations` worker can be frozen.** On Windows, the host's worker scheduling can leave a wake-only worker idle even when conversations are idle/archived (observed in homelab deployments; mechanism not yet root-caused). The representation cache stays fresh through the leading-edge refresh at delivery and the `outbox-sweep` job's deliveries — the worker's idle-wake refresh is a convenience, not the only lane.

## Development

```sh
npm install
npm test            # manifest check + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

`dist/` is committed by design — git-source installs load `dist/index.js` with no build step. Tests own their literals: synthetic users, a fake Honcho SDK, no real keys, no live Honcho.
