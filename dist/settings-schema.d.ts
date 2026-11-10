/**
 * Shared settings for @sigrun/memory-honcho. The declared checked read
 * applies the old parser's defaults and repairs malformed values live;
 * the API key remains in the secrets store (`api-key`) with env fallback.
 */
import { Type, type Static } from "typebox";
export declare const HONCHO_SETTINGS_SCHEMA: Type.TObject<{
    agentPeerId: Type.TString;
    baseUrl: Type.TOptional<Type.TString>;
    workspaceId: Type.TString;
    contextTokens: Type.TInteger;
    maxMessageLength: Type.TInteger;
    searchLimit: Type.TInteger;
    toolPreviewLength: Type.TInteger;
    representationTtlMs: Type.TInteger;
    outboxRetentionDays: Type.TInteger;
    deliveredBatchWindow: Type.TInteger;
    anchorWindow: Type.TInteger;
}> & Readonly<Record<string, unknown>>;
export type HonchoSettings = Static<typeof HONCHO_SETTINGS_SCHEMA>;
