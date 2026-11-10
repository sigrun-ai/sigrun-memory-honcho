/** API-key resolution: the scoped secrets store wins, then the env fallback. */
export interface SecretsReader {
    get(key: string): Promise<string | undefined>;
}
export declare function resolveApiKey(secrets: SecretsReader): Promise<string | undefined>;
