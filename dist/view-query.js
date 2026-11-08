const LEVELS = new Set([
    "all",
    "explicit",
    "derived",
    "deductive",
    "inductive",
    "contradiction",
]);
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function stringValue(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function validDate(value) {
    if (typeof value !== "string")
        return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null)
        return "";
    const date = new Date(`${value}T00:00:00Z`);
    return date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() + 1 === Number(match[2])
        && date.getUTCDate() === Number(match[3])
        ? value
        : "";
}
export function parseViewParams(raw) {
    const value = record(raw);
    const level = value?.level;
    const observer = value?.observer;
    const trail = Array.isArray(value?.trail)
        ? value.trail.filter((id) => typeof id === "string").slice(-20)
        : [];
    return {
        page: value?.page === "conclusions" ? "conclusions" : "card",
        level: typeof level === "string" && LEVELS.has(level) ? level : "all",
        text: stringValue(value?.text),
        meaning: stringValue(value?.meaning),
        from: validDate(value?.from),
        to: validDate(value?.to),
        session: stringValue(value?.session),
        observer: observer === "others" || observer === "any" ? observer : "self",
        order: value?.order === "oldest" ? "oldest" : "newest",
        n: typeof value?.n === "number" && Number.isInteger(value.n) && value.n >= 1 ? value.n : 1,
        selected: stringValue(value?.selected),
        trail,
    };
}
export function filtersFromForm(payload) {
    const outer = record(payload);
    const values = record(outer?.values) ?? outer;
    if (values === undefined)
        return {};
    const filters = {};
    for (const key of ["level", "text", "meaning", "from", "to", "session", "observer", "order"]) {
        const raw = values[key];
        const unwrapped = record(raw)?.other ?? raw;
        if (typeof unwrapped === "string") {
            Object.assign(filters, { [key]: unwrapped });
        }
    }
    return filters;
}
export function conclusionFilters(params, peer) {
    const filters = { observed_id: peer };
    if (params.observer === "self")
        filters.observer_id = peer;
    if (params.observer === "others")
        filters.observer_id = { ne: peer };
    if (params.level === "derived") {
        filters.level = { in: ["deductive", "inductive", "contradiction"] };
    }
    else if (params.level !== "all") {
        filters.level = params.level;
    }
    if (params.text !== "")
        filters.content = { icontains: params.text };
    const createdAt = {};
    if (params.from !== "")
        createdAt.gte = `${params.from}T00:00:00Z`;
    if (params.to !== "") {
        const nextDay = new Date(Date.parse(`${params.to}T00:00:00Z`) + 86_400_000);
        createdAt.lt = nextDay.toISOString().replace(".000Z", "Z");
    }
    if (Object.keys(createdAt).length > 0)
        filters.created_at = createdAt;
    if (params.session !== "")
        filters.session_id = params.session;
    return filters;
}
export function levelCountFilters(peer) {
    return {
        explicit: { observed_id: peer, observer_id: peer, level: "explicit" },
        deductive: { observed_id: peer, observer_id: peer, level: "deductive" },
        inductive: { observed_id: peer, observer_id: peer, level: "inductive" },
        contradiction: { observed_id: peer, observer_id: peer, level: "contradiction" },
    };
}
