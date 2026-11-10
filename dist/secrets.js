/** API-key resolution: the scoped secrets store wins, then the env fallback. */
const API_KEY_ENV = "SIGRUN_EXT_MEMORY_HONCHO_API_KEY";
export async function resolveApiKey(secrets) {
    const stored = await secrets.get("api-key");
    if (typeof stored === "string" && stored.trim() !== "")
        return stored;
    const env = process.env[API_KEY_ENV];
    if (typeof env === "string" && env !== "")
        return env;
    return undefined;
}
