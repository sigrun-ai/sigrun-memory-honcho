# @sigrun/memory-honcho

Honcho persistent-memory extension for [sigrun](https://github.com/sigrun-ai/sigrun) (pi-durable).

Captures settled runs to a durable outbox and delivers them to Honcho for cross-conversation, peer-level memory; recalls through `honcho_search` / `honcho_chat` / `honcho_remember`; renders per-conversation memory prompt sections from a cached representation refreshed by an idle worker and a cron sweeper.

(Scaffold stage — full documentation lands with the first release.)

## Install

```sh
npm install @sigrun/memory-honcho
```
