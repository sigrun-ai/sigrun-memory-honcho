import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApiKey, type SecretsReader } from "../src/secrets.js";

function secretsReader(values: Record<string, string | undefined>): SecretsReader {
	return { get: async (key) => values[key] };
}

const API_KEY_ENV = "SIGRUN_EXT_MEMORY_HONCHO_API_KEY";

describe("resolveApiKey", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns the stored secret when present", async () => {
		vi.stubEnv(API_KEY_ENV, "env-key");
		expect(await resolveApiKey(secretsReader({ "api-key": "stored-key" }))).toBe("stored-key");
	});

	it("falls back to the env var when no stored key", async () => {
		vi.stubEnv(API_KEY_ENV, "env-key");
		expect(await resolveApiKey(secretsReader({}))).toBe("env-key");
	});

	it("returns undefined when neither stored nor env", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		expect(await resolveApiKey(secretsReader({}))).toBeUndefined();
	});

	it("empty-string env var means unset", async () => {
		vi.stubEnv(API_KEY_ENV, "");
		expect(await resolveApiKey(secretsReader({ "api-key": "   " }))).toBeUndefined();
	});

	it("empty-string stored value falls through to env", async () => {
		vi.stubEnv(API_KEY_ENV, "env-key");
		expect(await resolveApiKey(secretsReader({ "api-key": "" }))).toBe("env-key");
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
