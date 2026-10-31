import { describe, expect, it } from "vitest";

import { pickCloneAnchor } from "../src/fork-rules.js";
import type { LedgerAnchor } from "../src/types.js";

const ANCHORS: LedgerAnchor[] = [
	{ entryId: 1, messageId: "m1" },
	{ entryId: 5, messageId: "m5" },
	{ entryId: 9, messageId: "m9" },
];

describe("pickCloneAnchor", () => {
	it("fork exactly at an anchor clones at that anchor", () => {
		expect(pickCloneAnchor(ANCHORS, 5)).toEqual({
			kind: "clone",
			messageId: "m5",
		});
	});

	it("fork between anchors clones at the newest anchor at-or-before the fork", () => {
		expect(pickCloneAnchor(ANCHORS, 7)).toEqual({
			kind: "clone",
			messageId: "m5",
		});
	});

	it("fork at the newest anchor clones there", () => {
		expect(pickCloneAnchor(ANCHORS, 9)).toEqual({
			kind: "clone",
			messageId: "m9",
		});
	});

	it("fork after the newest anchor (trailing input) clones at the newest anchor", () => {
		expect(pickCloneAnchor(ANCHORS, 10)).toEqual({
			kind: "clone",
			messageId: "m9",
		});
	});

	it("fork before the oldest retained anchor is a fresh window-miss session", () => {
		expect(pickCloneAnchor(ANCHORS, 0)).toEqual({
			kind: "fresh",
			inherit: "none-window",
		});
	});

	it("an empty anchor list is a fresh nothing-delivered session", () => {
		expect(pickCloneAnchor([], 7)).toEqual({
			kind: "fresh",
			inherit: "none-empty",
		});
	});

	it("a single anchor before the fork clones at it", () => {
		expect(pickCloneAnchor([{ entryId: 3, messageId: "m3" }], 12)).toEqual({
			kind: "clone",
			messageId: "m3",
		});
	});

	it("a fork before a single anchor is a window miss", () => {
		expect(pickCloneAnchor([{ entryId: 3, messageId: "m3" }], 2)).toEqual({
			kind: "fresh",
			inherit: "none-window",
		});
	});
});
