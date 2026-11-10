/**
 * The memory-honcho shared settings schema (settings rework): the old
 * parser's eleven-key surface, read through the declared checked handle.
 * Defaults and malformed-value repair come from core's checked read; the
 * API key stays in the secrets store with its env fallback.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type { SettingsDeclaration, SigrunHost } from "@sigrun/sigrun/extension";

import createHonchoMemory from "../src/index.js";
import { HONCHO_SETTINGS_SCHEMA, type HonchoSettings } from "../src/settings-schema.js";

interface DeclaredHost {
	declaration: SettingsDeclaration | undefined;
	declared: { get(): Promise<HonchoSettings> } | undefined;
	settingsFile: string;
}

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function declaredHost(): Promise<DeclaredHost> {
	const root = await mkdtemp(join(tmpdir(), "memory-honcho-settings-"));
	dirs.push(root);
	const settingsFile = join(root, "sigrun-memory-honcho.json");
	await mkdir(root, { recursive: true });
	const state = { declaration: undefined, declared: undefined, settingsFile } as DeclaredHost;
	const read = async (): Promise<Record<string, unknown>> => {
		try {
			return JSON.parse(await readFile(settingsFile, "utf8"));
		} catch {
			return {};
		}
	};
	const host = {
		settings: {
			declare: <S, U>(declaration: SettingsDeclaration) => {
				state.declaration = declaration;
				const declared = {
					get: async () => checkStoredSettings(declaration.schema, await read()).value as S,
					user: () => ({ get: async () => ({}) as U }),
				};
				state.declared = declared as unknown as DeclaredHost["declared"];
				return declared as unknown as ReturnType<SigrunHost["settings"]["declare"]>;
			},
		},
		stores: {
			settings: { get: read },
			secrets: { get: async () => undefined },
			paths: { data: join(root, "data"), state: join(root, "state"), cache: join(root, "cache") },
		},
	} as unknown as SigrunHost;
	createHonchoMemory(host);
	return state;
}

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

describe("memory-honcho settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(HONCHO_SETTINGS_SCHEMA);
	});

	test("defaults match the old parser", async () => {
		expect(checkStoredSettings(HONCHO_SETTINGS_SCHEMA, {}).value).toEqual(DEFAULTS);
		const host = await declaredHost();
		expect(await host.declared!.get()).toEqual(DEFAULTS);
	});

	test("an old settings file still loads", async () => {
		// The stored-value fixture from config.test.ts's "stored values win" case.
		const fixture = {
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
		};
		const host = await declaredHost();
		await writeFile(host.settingsFile, JSON.stringify(fixture));
		expect(await host.declared!.get()).toEqual(fixture);
	});

	test("non-string and empty-string values use the old parser's fallbacks", async () => {
		const host = await declaredHost();
		await writeFile(host.settingsFile, JSON.stringify({ agentPeerId: 42, baseUrl: true, workspaceId: null }));
		expect(await host.declared!.get()).toEqual(DEFAULTS);
		await writeFile(host.settingsFile, JSON.stringify({ baseUrl: "" }));
		expect(await host.declared!.get()).toEqual(DEFAULTS);
	});

	test.each([
		["non-numeric", "fast"],
		["zero", 0],
		["negative", -5],
		["non-integer", 1.5],
		["NaN", Number.NaN],
	] as const)("numeric key with %s value falls back to the old default", async (_label, bad) => {
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
			expect(checkStoredSettings(HONCHO_SETTINGS_SCHEMA, { [key]: bad }).value[key], key).toBe(DEFAULTS[key]);
		}
	});

	test("the factory declares the shared schema and no user schema", async () => {
		const host = await declaredHost();
		expect(host.declaration).toEqual({ schema: HONCHO_SETTINGS_SCHEMA });
	});
});
