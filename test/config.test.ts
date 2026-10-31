import { afterEach, describe, expect, it, vi } from "vitest";

import {
	resolveApiKey,
	resolveSettings,
	type SecretsReader,
	type SettingsReader,
} from "../src/config.js";

const DEFAULTS = {
	agentPeerId: "sigrun",
	baseUrl: undefined,
	workspaceId: "sigrun",
	contextTokens: 1200,
	maxMessageLength: 8000,
	searchLimit: 8,
	toolPreviewLength: 500,
	representationTtlMs: 600_000,
	outboxRetentionDays: 30,
	deliveredBatchWindow: 200,
	anchorWindow: 1000,
} as const;

function settingsReader(values: Record<string, unknown>): SettingsReader {
	return { get: async () => values };
}

function secretsReader(values: Record<string, string | undefined>): SecretsReader {
	return { get: async (key) => values[key] };
}

const API_KEY_ENV = "SIGRUN_EXT_MEMORY_HONCHO_API_KEY";

describe("resolveSettings", () => {
	it("applies defaults for all eleven keys on empty settings", async () => {
		const resolved = await resolveSettings(settingsReader({}));
		expect(resolved).toEqual({ ...DEFAULTS });
	});

	it("stored values win over defaults", async () => {
		const resolved = await resolveSettings(
			settingsReader({
				agentPeerId: "hal",
				baseUrl: "https://honcho.example.invalid",
				workspaceId: "lab",
				contextTokens: 2400,
				maxMessageLength: 4000,
				searchLimit: 3,
				toolPreviewLength: 120,
				representationTtlMs: 60_000,
				outboxRetentionDays: 7,
				deliveredBatchWindow: 50,
				anchorWindow: 10,
			}),
		);
		expect(resolved).toEqual({
			agentPeerId: "hal",
			baseUrl: "https://honcho.example.invalid",
			workspaceId: "lab",
			contextTokens: 2400,
			maxMessageLength: 4000,
			searchLimit: 3,
			toolPreviewLength: 120,
			representationTtlMs: 60_000,
			outboxRetentionDays: 7,
			deliveredBatchWindow: 50,
			anchorWindow: 10,
		});
	});

	it("non-string values for string keys fall back to defaults", async () => {
		const resolved = await resolveSettings(
			settingsReader({ agentPeerId: 42, baseUrl: true, workspaceId: null }),
		);
		expect(resolved.agentPeerId).toBe("sigrun");
		expect(resolved.baseUrl).toBeUndefined();
		expect(resolved.workspaceId).toBe("sigrun");
	});

	it("empty-string baseUrl means unset", async () => {
		const resolved = await resolveSettings(settingsReader({ baseUrl: "" }));
		expect(resolved.baseUrl).toBeUndefined();
	});

	it.each([
		["non-numeric", "fast"],
		["zero", 0],
		["negative", -5],
		["non-integer", 1.5],
		["NaN", Number.NaN],
	] as const)("numeric key with %s value falls back to the default", async (_label, bad) => {
		for (const key of [
			"contextTokens",
			"maxMessageLength",
			"searchLimit",
			"toolPreviewLength",
			"representationTtlMs",
			"outboxRetentionDays",
			"deliveredBatchWindow",
			"anchorWindow",
		] as const) {
			const resolved = await resolveSettings(settingsReader({ [key]: bad }));
			expect(resolved[key], key).toBe(DEFAULTS[key]);
		}
	});

	it("reads settings live per call (no module-level cache)", async () => {
		let current: Record<string, unknown> = { workspaceId: "first" };
		const reader: SettingsReader = { get: async () => current };
		expect((await resolveSettings(reader)).workspaceId).toBe("first");
		current = { workspaceId: "second" };
		expect((await resolveSettings(reader)).workspaceId).toBe("second");
	});
});

describe("resolveApiKey", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns the stored secret when present", async () => {
		vi.stubEnv(API_KEY_ENV, "env-key");
		const resolved = await resolveApiKey(secretsReader({ "api-key": "stored-key" }));
		expect(resolved).toBe("stored-key");
	});

	it("falls back to the env var when no stored key", async () => {
		vi.stubEnv(API_KEY_ENV, "env-key");
		const resolved = await resolveApiKey(secretsReader({}));
		expect(resolved).toBe("env-key");
	});

	it("returns undefined when neither stored nor env", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const resolved = await resolveApiKey(secretsReader({}));
		expect(resolved).toBeUndefined();
	});

	it("empty-string env var means unset", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		const resolved = await resolveApiKey(secretsReader({ "api-key": "   " }));
		// empty stored value falls through to env; empty env is unset
		expect(resolved).toBeUndefined();
	});

	it("empty-string stored value falls through to env", async () => {
		vi.stubEnv(API_KEY_ENV, "env-key");
		const resolved = await resolveApiKey(secretsReader({ "api-key": "" }));
		expect(resolved).toBe("env-key");
	});

	it("reads secrets live per call (no memoization)", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		let stored: string | undefined = "first-key";
		const reader: SecretsReader = { get: async () => stored };
		expect(await resolveApiKey(reader)).toBe("first-key");
		stored = undefined;
		expect(await resolveApiKey(reader)).toBeUndefined();
	});
});
