import { describe, expect, it } from "vitest";

import {
	conclusionFilters,
	filtersFromForm,
	levelCountFilters,
	parseViewParams,
	type HonchoViewParams,
} from "../src/view-query.js";

const defaults = parseViewParams(undefined);

function params(overrides: Partial<HonchoViewParams>): HonchoViewParams {
	return { ...defaults, ...overrides };
}

describe("view params", () => {
	it("defaults", () => {
		expect(parseViewParams(undefined)).toEqual({
			page: "card",
			level: "all",
			text: "",
			meaning: "",
			from: "",
			to: "",
			session: "",
			observer: "self",
			order: "newest",
			n: 1,
			selected: "",
			trail: [],
		});
	});

	it("bad params fall back", () => {
		expect(parseViewParams({ level: "nope", from: "yesterday", n: -3, page: "x", order: 7 })).toMatchObject({
			level: "all",
			from: "",
			n: 1,
			page: "card",
			order: "newest",
		});
	});

	it("trail keeps at most 20 ids", () => {
		const ids = Array.from({ length: 25 }, (_, index) => `c${index + 1}`);
		expect(parseViewParams({ trail: ids }).trail).toEqual(ids.slice(-20));
	});
});

describe("conclusion filters", () => {
	it("filters: self + derived + text + dates + session", () => {
		expect(conclusionFilters(params({
			level: "derived",
			text: "kimi",
			from: "2026-11-01",
			to: "2026-11-03",
			session: "repo_acme",
			observer: "self",
		}), "alice")).toEqual({
			observed_id: "alice",
			observer_id: "alice",
			level: { in: ["deductive", "inductive", "contradiction"] },
			content: { icontains: "kimi" },
			created_at: { gte: "2026-11-01T00:00:00Z", lt: "2026-11-04T00:00:00Z" },
			session_id: "repo_acme",
		});
	});

	it("observer others / any", () => {
		expect(conclusionFilters(params({ observer: "others" }), "alice")).toEqual({
			observed_id: "alice",
			observer_id: { ne: "alice" },
		});
		expect(conclusionFilters(params({ observer: "any" }), "alice")).toEqual({
			observed_id: "alice",
		});
	});

	it("text filter is passed verbatim", () => {
		expect(conclusionFilters(params({ text: "50% \"réel\"" }), "alice").content).toEqual({
			icontains: "50% \"réel\"",
		});
	});

	it("level single", () => {
		expect(conclusionFilters(params({ level: "deductive" }), "alice").level).toBe("deductive");
		expect(conclusionFilters(params({ level: "all" }), "alice")).not.toHaveProperty("level");
	});

	it("levelCountFilters covers each Honcho level", () => {
		expect(levelCountFilters("alice")).toEqual({
			explicit: { observed_id: "alice", observer_id: "alice", level: "explicit" },
			deductive: { observed_id: "alice", observer_id: "alice", level: "deductive" },
			inductive: { observed_id: "alice", observer_id: "alice", level: "inductive" },
			contradiction: { observed_id: "alice", observer_id: "alice", level: "contradiction" },
		});
	});
});

describe("form payloads", () => {
	it("form payloads: values envelope and allowOther", () => {
		const values = { session: { other: "repo_acme" }, level: "derived" };
		expect(filtersFromForm({ values })).toEqual({ session: "repo_acme", level: "derived" });
		expect(filtersFromForm(values)).toEqual({ session: "repo_acme", level: "derived" });
	});
});
