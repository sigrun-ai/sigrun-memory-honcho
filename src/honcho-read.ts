/** Read-only Honcho REST access for the view. */

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

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
	list(
		filters: JsonObject,
		opts: { page: number; size: number; reverse: boolean; signal?: AbortSignal },
	): Promise<ConclusionPage>;
	query(
		query: string,
		filters: JsonObject,
		topK: number,
		signal?: AbortSignal,
	): Promise<readonly ConclusionRow[]>;
	byIds(ids: readonly string[], signal?: AbortSignal): Promise<readonly ConclusionRow[]>;
	sessions(
		peer: string,
		opts: { page: number; size: number; signal?: AbortSignal },
	): Promise<{
		readonly items: readonly { id: string; createdAt: string }[];
		readonly total: number | null;
	}>;
	message(sessionId: string, messageId: string, signal?: AbortSignal): Promise<MessageRow | undefined>;
}

export class HonchoReadError extends Error {
	constructor(
		readonly status: number | "network",
		message: string,
	) {
		super(message);
		this.name = "HonchoReadError";
	}
}

type Fetch = typeof fetch;

type RequestOptions = {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly body?: JsonObject;
	readonly signal?: AbortSignal;
};

function conclusionRow(value: unknown): ConclusionRow {
	const row = value as Record<string, unknown>;
	return {
		id: row.id as string,
		content: row.content as string,
		observerId: row.observer_id as string,
		observedId: row.observed_id as string,
		sessionId: (row.session_id ?? null) as string | null,
		createdAt: row.created_at as string,
		level: (row.level ?? "explicit") as ConclusionLevel,
		sourceIds: (row.source_ids ?? []) as readonly string[],
		sourceMessageIds: (row.source_message_ids ?? null) as readonly string[] | null,
		timesDerived: (row.times_derived ?? 1) as number,
	};
}

function conclusionPage(value: unknown): ConclusionPage {
	const page = value as Record<string, unknown>;
	return {
		items: ((page.items ?? []) as unknown[]).map(conclusionRow),
		total: (page.total ?? null) as number | null,
		page: (page.page ?? 1) as number,
		pages: (page.pages ?? null) as number | null,
	};
}

export function createHonchoReader(opts: {
	baseUrl: string;
	workspaceId: string;
	apiKey?: string;
	fetch?: Fetch;
	timeoutMs?: number;
}): HonchoReader {
	const fetchImpl = opts.fetch ?? fetch;
	const baseUrl = opts.baseUrl.replace(/\/+$/, "");
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const workspace = `/v3/workspaces/${encodeURIComponent(opts.workspaceId)}`;

	async function request(requestOpts: RequestOptions): Promise<{ response: Response; body: unknown }> {
		const url = `${baseUrl}${requestOpts.path}`;
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = requestOpts.signal === undefined
			? timeout
			: AbortSignal.any([requestOpts.signal, timeout]);
		const headers: Record<string, string> = {};
		if (opts.apiKey !== undefined) headers.authorization = `Bearer ${opts.apiKey}`;
		if (requestOpts.body !== undefined) headers["content-type"] = "application/json";

		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: requestOpts.method,
				headers,
				...(requestOpts.body === undefined ? {} : { body: JSON.stringify(requestOpts.body) }),
				signal,
			});
		} catch {
			throw new HonchoReadError("network", `${requestOpts.method} ${requestOpts.path} → network`);
		}

		if (!response.ok) {
			throw new HonchoReadError(
				response.status,
				`${requestOpts.method} ${requestOpts.path} → ${response.status}`,
			);
		}
		return { response, body: await response.json() };
	}

	async function list(
		filters: JsonObject,
		listOpts: { page: number; size: number; reverse: boolean; signal?: AbortSignal },
	): Promise<ConclusionPage> {
		const query = new URLSearchParams({
			page: String(listOpts.page),
			size: String(listOpts.size),
			reverse: String(listOpts.reverse),
		});
		const { body } = await request({
			method: "POST",
			path: `${workspace}/conclusions/list?${query}`,
			body: { filters },
			...(listOpts.signal === undefined ? {} : { signal: listOpts.signal }),
		});
		return conclusionPage(body);
	}

	return {
		async card(peer, signal) {
			const path = `${workspace}/peers/${encodeURIComponent(peer)}/card`;
			try {
				const { body } = await request({ method: "GET", path, ...(signal === undefined ? {} : { signal }) });
				return ((body as Record<string, unknown>).peer_card ?? []) as readonly string[];
			} catch (error) {
				if (error instanceof HonchoReadError && error.status === 404) return [];
				throw error;
			}
		},

		list,

		async query(queryText, filters, topK, signal) {
			const { body } = await request({
				method: "POST",
				path: `${workspace}/conclusions/query`,
				body: { query: queryText, top_k: topK, filters },
				...(signal === undefined ? {} : { signal }),
			});
			return (body as unknown[]).map(conclusionRow);
		},

		async byIds(ids, signal) {
			const rows: ConclusionRow[] = [];
			for (let offset = 0; offset < ids.length; offset += 100) {
				const page = await list(
					{ id: { in: ids.slice(offset, offset + 100) } },
					{ page: 1, size: 100, reverse: false, ...(signal === undefined ? {} : { signal }) },
				);
				rows.push(...page.items);
			}
			return rows;
		},

		async sessions(peer, sessionOpts) {
			const query = new URLSearchParams({
				page: String(sessionOpts.page),
				size: String(sessionOpts.size),
				reverse: "true",
			});
			const { body } = await request({
				method: "POST",
				path: `${workspace}/peers/${encodeURIComponent(peer)}/sessions?${query}`,
				body: {},
				...(sessionOpts.signal === undefined ? {} : { signal: sessionOpts.signal }),
			});
			const page = body as Record<string, unknown>;
			return {
				items: ((page.items ?? []) as Record<string, unknown>[]).map((item) => ({
					id: item.id as string,
					createdAt: item.created_at as string,
				})),
				total: (page.total ?? null) as number | null,
			};
		},

		async message(sessionId, messageId, signal) {
			const path = `${workspace}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`;
			try {
				const { body } = await request({ method: "GET", path, ...(signal === undefined ? {} : { signal }) });
				const row = body as Record<string, unknown>;
				return {
					id: row.id as string,
					peerId: row.peer_id as string,
					content: row.content as string,
					createdAt: row.created_at as string,
				};
			} catch (error) {
				if (error instanceof HonchoReadError && error.status === 404) return undefined;
				throw error;
			}
		},
	};
}
