/** Read-only Honcho REST access for the view. */
export class HonchoReadError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HonchoReadError";
    }
}
function conclusionRow(value) {
    const row = value;
    return {
        id: row.id,
        content: row.content,
        observerId: row.observer_id,
        observedId: row.observed_id,
        sessionId: (row.session_id ?? null),
        createdAt: row.created_at,
        level: (row.level ?? "explicit"),
        sourceIds: (row.source_ids ?? []),
        sourceMessageIds: (row.source_message_ids ?? null),
        timesDerived: (row.times_derived ?? 1),
    };
}
function conclusionPage(value) {
    const page = value;
    return {
        items: (page.items ?? []).map(conclusionRow),
        total: (page.total ?? null),
        page: (page.page ?? 1),
        pages: (page.pages ?? null),
    };
}
export function createHonchoReader(opts) {
    const fetchImpl = opts.fetch ?? fetch;
    const baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const workspace = `/v3/workspaces/${encodeURIComponent(opts.workspaceId)}`;
    async function request(requestOpts) {
        const url = `${baseUrl}${requestOpts.path}`;
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = requestOpts.signal === undefined
            ? timeout
            : AbortSignal.any([requestOpts.signal, timeout]);
        const headers = {};
        if (opts.apiKey !== undefined)
            headers.authorization = `Bearer ${opts.apiKey}`;
        if (requestOpts.body !== undefined)
            headers["content-type"] = "application/json";
        let response;
        try {
            response = await fetchImpl(url, {
                method: requestOpts.method,
                headers,
                ...(requestOpts.body === undefined ? {} : { body: JSON.stringify(requestOpts.body) }),
                signal,
            });
        }
        catch {
            throw new HonchoReadError("network", `${requestOpts.method} ${requestOpts.path} → network`);
        }
        if (!response.ok) {
            throw new HonchoReadError(response.status, `${requestOpts.method} ${requestOpts.path} → ${response.status}`);
        }
        return { response, body: await response.json() };
    }
    async function list(filters, listOpts) {
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
                return (body.peer_card ?? []);
            }
            catch (error) {
                if (error instanceof HonchoReadError && error.status === 404)
                    return [];
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
            return body.map(conclusionRow);
        },
        async byIds(ids, signal) {
            const rows = [];
            for (let offset = 0; offset < ids.length; offset += 100) {
                const page = await list({ id: { in: ids.slice(offset, offset + 100) } }, { page: 1, size: 100, reverse: false, ...(signal === undefined ? {} : { signal }) });
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
            const page = body;
            return {
                items: (page.items ?? []).map((item) => ({
                    id: item.id,
                    createdAt: item.created_at,
                })),
                total: (page.total ?? null),
            };
        },
        async message(sessionId, messageId, signal) {
            const path = `${workspace}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`;
            try {
                const { body } = await request({ method: "GET", path, ...(signal === undefined ? {} : { signal }) });
                const row = body;
                return {
                    id: row.id,
                    peerId: row.peer_id,
                    content: row.content,
                    createdAt: row.created_at,
                };
            }
            catch (error) {
                if (error instanceof HonchoReadError && error.status === 404)
                    return undefined;
                throw error;
            }
        },
    };
}
