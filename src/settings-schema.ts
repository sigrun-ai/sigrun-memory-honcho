/**
 * Shared settings for @sigrun/memory-honcho. The declared checked read
 * applies the old parser's defaults and repairs malformed values live;
 * the API key remains in the secrets store (`api-key`) with env fallback.
 */

import { Type, type Static } from "typebox";

function asJsonSchema<T>(schema: T): T & Readonly<Record<string, unknown>> {
	return schema as T & Readonly<Record<string, unknown>>;
}

function positiveInteger(title: string, defaultValue: number, description: string) {
	return Type.Integer({
		title,
		minimum: 1,
		default: defaultValue,
		description,
		"x-sigrun-apply": "live",
	});
}

export const HONCHO_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
	agentPeerId: Type.String({
		title: "Agent peer ID",
		minLength: 1,
		default: "sigrun",
		description: "The Honcho peer that observes conversations and answers as this agent.",
		"x-sigrun-apply": "live",
	}),
	baseUrl: Type.Optional(Type.String({
		title: "Honcho base URL",
		minLength: 1,
		description: "Custom Honcho endpoint; absent uses HONCHO_URL or the public Honcho API.",
		"x-sigrun-apply": "live",
	})),
	workspaceId: Type.String({
		title: "Workspace ID",
		minLength: 1,
		default: "sigrun",
		description: "The Honcho workspace containing this agent's sessions and peers.",
		"x-sigrun-apply": "live",
	}),
	contextTokens: positiveInteger("Context tokens", 1200, "Approximate token budget for the injected memory representation."),
	maxMessageLength: positiveInteger("Maximum message length", 8000, "Maximum characters captured from each user or assistant message."),
	searchLimit: positiveInteger("Search limit", 8, "Maximum conclusions returned by the Honcho search tool."),
	toolPreviewLength: positiveInteger("Tool preview length", 500, "Maximum characters shown for each conclusion in tool previews."),
	representationTtlMs: positiveInteger("Representation TTL (ms)", 600_000, "How long a cached representation remains fresh before it may be refreshed."),
	outboxRetentionDays: positiveInteger("Outbox retention (days)", 30, "Days pending capture records remain before the sweeper drops them."),
	deliveredBatchWindow: positiveInteger("Delivered batch window", 200, "Number of delivered batch IDs retained for duplicate delivery suppression."),
	anchorWindow: positiveInteger("Anchor window", 1000, "Number of fork anchors retained per conversation for continuity lookups."),
}));

export type HonchoSettings = Static<typeof HONCHO_SETTINGS_SCHEMA>;
