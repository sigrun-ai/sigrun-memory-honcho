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
import { createHash } from "node:crypto";
/**
 * Build the outbox record for one settled run, or `undefined` when no
 * non-empty, under-cap text survives. `owner` is pre-resolved by the caller
 * (ownerless conversations arrive as `"user"`).
 */
export function buildCaptureBatch(event, owner, maxMessageLength) {
    const batchId = createHash("sha256")
        .update(`${event.conversationId}:${event.inputs[0] ?? ""}:${event.inputs.length}`)
        .digest("hex");
    const metadata = {
        conversationId: event.conversationId,
        submissionIds: event.inputs,
        batchId,
    };
    const entries = [];
    for (const text of event.inputTexts) {
        if (text === "" || text.length > maxMessageLength)
            continue;
        entries.push({
            peer: "user",
            text,
            metadata: event.outcome.status === "unanswered"
                ? { ...metadata, unanswered: true }
                : metadata,
        });
    }
    let answerEntryId;
    if (event.outcome.status === "answered") {
        const answerText = event.outcome.answer.content
            .filter((block) => block.type === "text")
            .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
            .join("");
        if (answerText !== "" && answerText.length <= maxMessageLength) {
            answerEntryId = event.outcome.answerEntryId;
            entries.push({ peer: "agent", text: answerText, metadata });
        }
    }
    if (entries.length === 0)
        return undefined;
    return {
        type: "capture",
        conversationId: event.conversationId,
        owner,
        ...(answerEntryId === undefined ? {} : { answerEntryId }),
        entries,
        batchId,
        status: "pending",
        createdAt: Date.now(),
    };
}
