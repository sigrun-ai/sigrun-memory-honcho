/**
 * The capture batch builder: turn one settled run into one outbox record.
 *
 * Pure — no I/O, no Honcho. The filtering rules (spec §Capture):
 * user texts first, in admission order, skipping empty and over-cap texts;
 * then, when the run answered AND the answer text survives the same filter,
 * one agent entry. Unanswered runs tag their user entries `unanswered: true`
 * and carry no agent entry and no `answerEntryId`. `undefined` when nothing
 * survives the filter (an all-empty batch is pure outbox churn).
 */
import type { OutboxRecord, RunSettledEventLike } from "./types.js";
/**
 * Build the outbox record for one settled run, or `undefined` when no
 * non-empty, under-cap text survives. `owner` is pre-resolved by the caller
 * (ownerless conversations arrive as `"user"`).
 */
export declare function buildCaptureBatch(event: RunSettledEventLike, owner: string, maxMessageLength: number): OutboxRecord | undefined;
