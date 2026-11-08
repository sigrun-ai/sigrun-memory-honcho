/** Read-only Honcho REST access for the view. */
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export type ConclusionLevel = "explicit" | "deductive" | "inductive" | "contradiction";
export interface ConclusionRow {
    readonly id: string;
    readonly content: string;
    readonly observerId: string;
    readonly observedId: string;
    readonly sessionId: string | null;
    readonly createdAt: string;
    readonly level: ConclusionLevel;
    readonly sourceIds: readonly string[];
    readonly sourceMessageIds: readonly string[] | null;
    readonly timesDerived: number;
}
export interface ConclusionPage {
    readonly items: readonly ConclusionRow[];
    readonly total: number | null;
    readonly page: number;
    readonly pages: number | null;
}
export interface MessageRow {
    readonly id: string;
    readonly peerId: string;
    readonly content: string;
    readonly createdAt: string;
}
export interface HonchoReader {
    card(peer: string, signal?: AbortSignal): Promise<readonly string[]>;
    list(filters: JsonObject, opts: {
        page: number;
        size: number;
        reverse: boolean;
        signal?: AbortSignal;
    }): Promise<ConclusionPage>;
    query(query: string, filters: JsonObject, topK: number, signal?: AbortSignal): Promise<readonly ConclusionRow[]>;
    byIds(ids: readonly string[], signal?: AbortSignal): Promise<readonly ConclusionRow[]>;
    sessions(peer: string, opts: {
        page: number;
        size: number;
        signal?: AbortSignal;
    }): Promise<{
        readonly items: readonly {
            id: string;
            createdAt: string;
        }[];
        readonly total: number | null;
    }>;
    message(sessionId: string, messageId: string, signal?: AbortSignal): Promise<MessageRow | undefined>;
}
export declare class HonchoReadError extends Error {
    readonly status: number | "network";
    constructor(status: number | "network", message: string);
}
type Fetch = typeof fetch;
export declare function createHonchoReader(opts: {
    baseUrl: string;
    workspaceId: string;
    apiKey?: string;
    fetch?: Fetch;
    timeoutMs?: number;
}): HonchoReader;
export {};
