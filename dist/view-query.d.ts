import type { ConclusionLevel, JsonObject } from "./honcho-read.js";
export type LevelFilter = "all" | "explicit" | "derived" | "deductive" | "inductive" | "contradiction";
export type ObserverFilter = "self" | "others" | "any";
export interface HonchoViewParams {
    readonly page: "card" | "conclusions";
    readonly level: LevelFilter;
    readonly text: string;
    readonly meaning: string;
    readonly from: string;
    readonly to: string;
    readonly session: string;
    readonly observer: ObserverFilter;
    readonly order: "newest" | "oldest";
    readonly n: number;
    readonly selected: string;
    readonly trail: readonly string[];
}
export declare function parseViewParams(raw: unknown): HonchoViewParams;
export declare function filtersFromForm(payload: unknown): Partial<HonchoViewParams>;
export declare function conclusionFilters(params: HonchoViewParams, peer: string): JsonObject;
export declare function levelCountFilters(peer: string): Readonly<Record<ConclusionLevel, JsonObject>>;
