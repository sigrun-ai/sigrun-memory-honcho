/**
 * Settings and secret resolution for @sigrun/memory-honcho.
 *
 * Both readers are structural slices of `host.stores`; values are read
 * LIVE per call (never memoized) so setting/key changes apply at next
 * use without a restart.
 */
export interface SettingsReader {
    get(): Promise<Record<string, unknown>>;
}
export interface SecretsReader {
    get(key: string): Promise<string | undefined>;
}
export interface HonchoSettings {
    agentPeerId: string;
    baseUrl: string | undefined;
    workspaceId: string;
    contextTokens: number;
    maxMessageLength: number;
    searchLimit: number;
    toolPreviewLength: number;
    representationTtlMs: number;
    outboxRetentionDays: number;
    deliveredBatchWindow: number;
    anchorWindow: number;
}
export declare function resolveSettings(stores: SettingsReader): Promise<HonchoSettings>;
export declare function resolveApiKey(secrets: SecretsReader): Promise<string | undefined>;
