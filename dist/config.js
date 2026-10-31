/**
 * Settings and secret resolution for @sigrun/memory-honcho.
 *
 * Both readers are structural slices of `host.stores`; values are read
 * LIVE per call (never memoized) so setting/key changes apply at next
 * use without a restart.
 */
const API_KEY_ENV = "SIGRUN_EXT_MEMORY_HONCHO_API_KEY";
function stringSetting(value, fallback) {
    return typeof value === "string" && value !== "" ? value : fallback;
}
function integerSetting(value, fallback) {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}
export async function resolveSettings(stores) {
    const raw = await stores.get();
    return {
        agentPeerId: stringSetting(raw.agentPeerId, "sigrun"),
        baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl !== ""
            ? raw.baseUrl
            : undefined,
        workspaceId: stringSetting(raw.workspaceId, "sigrun"),
        contextTokens: integerSetting(raw.contextTokens, 1200),
        maxMessageLength: integerSetting(raw.maxMessageLength, 8000),
        searchLimit: integerSetting(raw.searchLimit, 8),
        toolPreviewLength: integerSetting(raw.toolPreviewLength, 500),
        representationTtlMs: integerSetting(raw.representationTtlMs, 600_000),
        outboxRetentionDays: integerSetting(raw.outboxRetentionDays, 30),
        deliveredBatchWindow: integerSetting(raw.deliveredBatchWindow, 200),
        anchorWindow: integerSetting(raw.anchorWindow, 1000),
    };
}
export async function resolveApiKey(secrets) {
    const stored = await secrets.get("api-key");
    if (typeof stored === "string" && stored.trim() !== "")
        return stored;
    const env = process.env[API_KEY_ENV];
    if (typeof env === "string" && env !== "")
        return env;
    return undefined;
}
