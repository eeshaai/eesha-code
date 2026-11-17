import { accountOf, ConnectorCache, type CacheKind, type CacheMode, type Tagged } from "./cache";
import type { ConnectorId } from "./config";

/** Where tokens come from - `Tokens` in cliAuth.ts, or a test's own. */
export interface TokenSource {

    get(id: ConnectorId, fresh?: boolean): Promise<string>;

    forget(id: ConnectorId): void;
}

/*
 * One call to the ADO or GitHub web API with the CLI's token. A call
 * refused with 401 asks the CLI for a new token once and tries again.
 *
 * A read whose last answer came with a version tag (ETag or
 * Last-Modified) sends the tag, and "not changed" (304) gives that
 * answer again - see cache.ts. GitHub does not count such a 304 against
 * its hourly limit.
 */

/** How long one web call may take. */
const CALL_MS = 30_000;

/** A refused or failed web call: the service's own words, with the status. */
export class ApiError extends Error {

    constructor(message: string, readonly status: number) {

        super(message);
    }
}

export interface ApiCall {

    method?: "GET" | "POST" | "PATCH" | "PUT";

    body?: unknown;

    /** ADO field changes go as `application/json-patch+json`. */
    contentType?: string;

    /** Read the answer as text, not JSON - a build log, a raw README. */
    text?: boolean;

    accept?: string;
}

export interface Api {

    <T = unknown>(url: string, call?: ApiCall): Promise<T>;

    /** The list kept under `kind` and `key`, or `load`'s answer - see `ConnectorCache.list`. */
    kept<T>(kind: CacheKind, key: string, load: () => Promise<T>): Promise<T>;
}

export interface ApiOptions {

    /** For tests: in place of fetch. */
    fetcher?: typeof fetch;

    /** Where lists and tagged answers are kept. Nothing: a store of its own, in memory. */
    cache?: ConnectorCache;

    /** How a list kept past its time is taken - see `CacheMode`. `wait` when not given. */
    mode?: CacheMode;

    /** Hears when `kept` gave a kept list, with when it was fetched. */
    onSaved?(at: number): void;
}

function headers(id: ConnectorId, token: string, call: ApiCall): Record<string, string> {

    const list: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "User-Agent": "eesha",
        Accept: call.accept ?? (id === "github" ? "application/vnd.github+json" : "application/json")
    };

    if (id === "github")
        list["X-GitHub-Api-Version"] = "2022-11-28";

    if (call.body !== undefined)
        list["Content-Type"] = call.contentType ?? "application/json";

    return list;
}

/** What went wrong, from the answer's body when it says. */
async function problemOf(response: Response): Promise<string> {

    const text = await response.text().catch(() => "");

    try {

        const json = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        const extra = json.errors?.map(one => one.message).filter(Boolean).join(" ");

        if (json.message)
            return extra ? `${json.message} ${extra}` : json.message;

    } catch {

        // Not JSON - the text itself, below.
    }

    return text.trim().slice(0, 300) || response.statusText;
}

/** A caller for one connector's web API, with its tokens. */
export function apiFor(id: ConnectorId, tokens: TokenSource, options: ApiOptions = {}): Api {

    const fetcher = options.fetcher ?? fetch;
    const cache = options.cache ?? new ConnectorCache();

    const request = async <T>(url: string, call: ApiCall = {}): Promise<T> => {

        const read = (call.method ?? "GET") === "GET";

        const send = async (fresh: boolean) => {

            const token = await tokens.get(id, fresh);
            const list = headers(id, token, call);
            const tagKey = read ? `${id}:${accountOf(id, token)}:${list.Accept}:${url}` : undefined;
            const kept: Tagged | undefined = tagKey ? cache.taggedFor(tagKey) : undefined;

            if (kept?.etag)
                list["If-None-Match"] = kept.etag;
            else if (kept?.modified)
                list["If-Modified-Since"] = kept.modified;

            const response = await fetcher(url, {
                method: call.method ?? "GET",
                headers: list,
                ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
                signal: AbortSignal.timeout(CALL_MS),
                redirect: "follow"
            });

            return { response, tagKey, kept };
        };

        let sent = await send(false);
        let response = sent.response;

        // ADO answers a token it does not take with 203 and a sign-in page, not 401.
        if (response.status === 401 || response.status === 203) {

            tokens.forget(id);
            sent = await send(true);
            response = sent.response;
        }

        if (response.status === 401 || response.status === 203)
            throw new ApiError(id === "ado"
                // Also what an organization linked only to personal Microsoft
                // accounts answers: az's tokens never reach one of those.
                ? "Azure DevOps did not take the az sign-in for this organization. Either az is signed in as someone who is not a member (run `az login` as the right account), or the organization is not linked to a Microsoft Entra directory - az cannot reach those."
                : "GitHub did not take the sign-in. Run `gh auth login` again, or Connect on the Connectors page.", 401);

        let body: string;

        if (response.status === 304 && sent.kept)
            body = sent.kept.body;

        else {

            if (!response.ok)
                throw new ApiError(`${response.status}: ${await problemOf(response)}`, response.status);

            body = await response.text();

            const etag = response.headers.get("etag") ?? undefined;
            const modified = response.headers.get("last-modified") ?? undefined;

            if (sent.tagKey && (etag || modified))
                cache.keepTagged(sent.tagKey, { ...(etag ? { etag } : {}), ...(modified ? { modified } : {}), body });
        }

        // GraphQL answers a missing permission with 200. After `gh auth
        // refresh -s ...` the kept token is the old one, so ask gh again once.
        if (id === "github" && url.endsWith("/graphql") && body.includes("\"INSUFFICIENT_SCOPES\"")) {

            tokens.forget(id);
            response = (await send(true)).response;
            body = response.ok ? await response.text() : body;
        }

        if (call.text)
            return body as T;

        // 202 and 204 answers - a run cancelled, a workflow started - often have no body.
        return (body.trim() ? JSON.parse(body) : undefined) as T;
    };

    const kept = async <T>(kind: CacheKind, key: string, load: () => Promise<T>): Promise<T> =>
        cache.list(id, accountOf(id, await tokens.get(id)), kind, key, load, options.mode ?? "wait", options.onSaved);

    return Object.assign(request, { kept }) as Api;
}
