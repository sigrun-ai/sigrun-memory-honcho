import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildCaptureBatch } from "../src/capture.js";
import type { RunSettledEventLike } from "../src/types.js";

const CAP = 8;

/** Synthetic answered outcome: one text block carrying `text`. */
function answered(answerText: string, answerEntryId = 42) {
	return {
		status: "answered" as const,
		answerEntryId,
		answer: { content: [{ type: "text" as const, text: answerText }] },
	};
}

function unanswered(reason = "model_error") {
	return { status: "unanswered" as const, reason };
}

function event(
	inputTexts: readonly string[],
	outcome: RunSettledEventLike["outcome"],
	inputs: readonly number[] = inputTexts.map((_, i) => 11 + i),
): RunSettledEventLike {
	return { conversationId: 7, owner: "alice", inputs, inputTexts, outcome };
}

/** The expected batchId, computed from the pinned formula. */
function expectedBatchId(conversationId: number, inputs: readonly number[]): string {
	return createHash("sha256")
		.update(`${conversationId}:${inputs[0] ?? ""}:${inputs.length}`)
		.digest("hex");
}

describe("buildCaptureBatch", () => {
	it("answered run: user texts then one agent entry, in admission order", () => {
		const record = buildCaptureBatch(
			event(["hello", "world"], answered("hi there")),
			"alice",
			CAP,
		);
		expect(record).toBeDefined();
		expect(record?.type).toBe("capture");
		expect(record?.status).toBe("pending");
		expect(record?.conversationId).toBe(7);
		expect(record?.owner).toBe("alice");
		expect(record?.answerEntryId).toBe(42);
		expect(record?.entries.map((e) => [e.peer, e.text])).toEqual([
			["user", "hello"],
			["user", "world"],
			["agent", "hi there"],
		]);
		expect(typeof record?.createdAt).toBe("number");
	});

	it("answered run: empty and over-cap texts are skipped", () => {
		const record = buildCaptureBatch(
			event(["first", "", "0123456789"], answered("answer")),
			"alice",
			CAP,
		);
		expect(record?.entries.map((e) => e.text)).toEqual(["first", "answer"]);
	});

	it("every entry carries the batch-level metadata", () => {
		const record = buildCaptureBatch(
			event(["hello"], answered("answer"), [11, 12, 13]),
			"alice",
			CAP,
		);
		const batchId = expectedBatchId(7, [11, 12, 13]);
		expect(record?.batchId).toBe(batchId);
		for (const entry of record?.entries ?? []) {
			expect(entry.metadata).toEqual({
				conversationId: 7,
				submissionIds: [11, 12, 13],
				batchId,
			});
		}
	});

	it("unanswered run: user entries tagged unanswered, no agent entry, no answerEntryId", () => {
		const record = buildCaptureBatch(
			event(["q1", "q2"], unanswered()),
			"alice",
			CAP,
		);
		expect(record).toBeDefined();
		expect(record?.entries.map((e) => [e.peer, e.text])).toEqual([
			["user", "q1"],
			["user", "q2"],
		]);
		expect(record?.answerEntryId).toBeUndefined();
		for (const entry of record?.entries ?? []) {
			expect(entry.metadata.unanswered).toBe(true);
		}
	});

	it("all-empty texts, unanswered: nothing enqueued", () => {
		expect(buildCaptureBatch(event(["", ""], unanswered()), "alice", CAP)).toBeUndefined();
	});

	it("all-empty texts, answered with a surviving answer: agent entry only", () => {
		const record = buildCaptureBatch(event(["", ""], answered("ok")), "alice", CAP);
		expect(record?.entries).toEqual([
			{
				peer: "agent",
				text: "ok",
				metadata: {
					conversationId: 7,
					submissionIds: [11, 12],
					batchId: expectedBatchId(7, [11, 12]),
				},
			},
		]);
		expect(record?.answerEntryId).toBe(42);
	});

	it("answered run whose answer does not survive the filter: user entries only", () => {
		const record = buildCaptureBatch(
			event(["hello"], answered("")),
			"alice",
			CAP,
		);
		expect(record?.entries.map((e) => e.peer)).toEqual(["user"]);
	});

	it("answered run where nothing survives: undefined", () => {
		expect(buildCaptureBatch(event([""], answered("")), "alice", CAP)).toBeUndefined();
	});

	it("empty inputs: batchId hashes the deterministic empty-array shape", () => {
		const record = buildCaptureBatch(event([], answered("ok"), []), "alice", CAP);
		expect(record?.batchId).toBe(expectedBatchId(7, []));
	});

	it("ownerless: the record carries the resolved 'user' owner (Review Focus 5)", () => {
		const ownerless: RunSettledEventLike = {
			conversationId: 9,
			inputs: [21],
			inputTexts: ["hello"],
			outcome: answered("hi"),
		};
		// The factory resolves `event.owner ?? "user"` before calling; mirror it.
		const record = buildCaptureBatch(ownerless, ownerless.owner ?? "user", CAP);
		expect(record?.owner).toBe("user");
	});

	it("batchId is deterministic for identical events", () => {
		const first = buildCaptureBatch(event(["hello"], answered("ok")), "alice", CAP);
		const second = buildCaptureBatch(event(["hello"], answered("ok")), "alice", CAP);
		expect(first?.batchId).toBe(second?.batchId);
		expect(first?.batchId).toBe(expectedBatchId(7, [11]));
	});
});
