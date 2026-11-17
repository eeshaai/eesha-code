import { PluginContext, PluginResult } from "../../core/plugins/Plugin";
import { adoAuthHeader } from "../ado/auth";

/**
 * `ado-comment@1` - adds or updates one comment on an Azure DevOps work
 * item, keyed by a marker.
 *
 * The state lives in ADO itself: the `key` rides inside the comment as
 * a `[eesha:key]` line, and each run lists the item's comments looking for
 * it. Found means update, absent means add, so the same task run twice
 * lands on the same comment.
 *
 * Plain REST rather than the ADO MCP server, because the server has no
 * update tool.
 *
 * Auth is `az` by default: a short-lived Entra token from the CLI's own
 * login, no PAT. `auth: pat` reads the env var `patEnv` names through
 * `ctx.secret`, never `process.env` directly.
 */
interface AdoCommentArgs {

    orgUrl: string;

    project: string;

    workItem: number;

    key: string;

    body: string;

    auth?: string;

    patEnv?: string;
}

/**
 * The comments API's version. The comments endpoints have never left
 * preview; asking for plain `7.1` is a 400.
 */
const API_VERSION = "7.1-preview.4";

/** One page of the list call - 200 is the API's own maximum. */
const PAGE_SIZE = 200;

/** Per-request ceiling, so a dead network fails the task rather than hanging it. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A visible one-line token rather than an HTML comment: ADO sanitizes
 * comment HTML, and a stripped marker would turn every update into an
 * add. Matched with `includes`, so the HTML ADO wraps around stored
 * text does not hide it.
 */
function markerFor(key: string): string {

    return `[eesha:${key}]`;
}

/** What a comment row of the list answer carries, as far as this plugin reads it. */
interface AdoComment {

    id: number;

    text?: string;
}

interface CommentList {

    comments?: AdoComment[];

    continuationToken?: string;
}

export async function execute(args: AdoCommentArgs, ctx: PluginContext): Promise<PluginResult> {

    const invalid = validate(args);

    if (invalid)
        return { success: false, message: invalid };

    let header: string;

    try {

        header = await authHeader(args, ctx);

    } catch (error) {

        return {
            success: false,
            message: error instanceof Error ? error.message : String(error)
        };
    }

    const api = new AdoApi(args.orgUrl, args.project, header, ctx);

    const marker = markerFor(args.key.trim());

    const text = `${args.body}\n\n${marker}`;

    try {

        const existing = await api.findComment(args.workItem, marker);

        if (!existing) {

            const added = await api.addComment(args.workItem, text);

            ctx.log(`Added comment ${added.id} on work item ${args.workItem} (${marker}).`, "system");

            return { success: true, artifacts: { commentId: added.id, action: "added" } };
        }

        // Best effort: ADO stores comments as HTML, so reshaped text
        // will not compare equal and simply updates.
        if (existing.text === text) {

            ctx.log(`Comment ${existing.id} on work item ${args.workItem} already says this - nothing written.`, "system");

            return { success: true, artifacts: { commentId: existing.id, action: "unchanged" } };
        }

        await api.updateComment(args.workItem, existing.id, text);

        ctx.log(`Updated comment ${existing.id} on work item ${args.workItem} (${marker}).`, "system");

        return { success: true, artifacts: { commentId: existing.id, action: "updated" } };

    } catch (error) {

        return {
            success: false,
            message: error instanceof Error ? error.message : String(error)
        };
    }
}

/** The Authorization header the chosen auth mode produces - see `adoAuthHeader`. */
function authHeader(args: AdoCommentArgs, ctx: PluginContext): Promise<string> {

    return adoAuthHeader(args.auth, args.patEnv, ctx);
}

/** The args a run cannot proceed without, each failure naming its field. */
function validate(args: AdoCommentArgs): string | undefined {

    if (typeof args.orgUrl !== "string" || !/^https:\/\//.test(args.orgUrl.trim()))
        return "'orgUrl' must be the organization's https URL - https://dev.azure.com/{org}.";

    if (typeof args.project !== "string" || !args.project.trim())
        return "'project' must name the Azure DevOps project.";

    if (!Number.isInteger(Number(args.workItem)) || Number(args.workItem) <= 0)
        return `'workItem' must be a work item id - got '${String(args.workItem)}'.`;

    if (typeof args.key !== "string" || !args.key.trim())
        return "'key' must be a non-empty marker - it is what decides add vs update.";

    // `]` would end the marker early and match a different key's comment.
    if (/[\[\]]/.test(args.key))
        return "'key' must not contain '[' or ']' - it is wrapped in them to form the marker.";

    if (typeof args.body !== "string" || !args.body.trim())
        return "'body' must be the comment text.";

    if (args.auth !== undefined && args.auth !== "az" && args.auth !== "pat")
        return `'auth' must be 'az' or 'pat' - got '${String(args.auth)}'.`;

    return undefined;
}

/**
 * The three comment calls, with the same auth, timeout and error shape.
 * Failures name the operation, the work item and the HTTP status, never
 * the token.
 */
class AdoApi {

    private readonly base: string;

    constructor(
        orgUrl: string,
        project: string,
        /** The ready Authorization header - see {@link authHeader}. */
        private readonly auth: string,
        private readonly ctx: PluginContext
    ) {

        this.base = `${orgUrl.trim().replace(/\/+$/, "")}/${encodeURIComponent(project.trim())}/_apis/wit/workItems`;
    }

    /** The comment carrying `marker`, wherever it sits in the item's pages of comments. */
    async findComment(workItem: number, marker: string): Promise<AdoComment | undefined> {

        let continuation: string | undefined;

        do {

            const token = continuation ? `&continuationToken=${encodeURIComponent(continuation)}` : "";

            const page = await this.call<CommentList>(
                "GET",
                `${workItem}/comments?api-version=${API_VERSION}&$top=${PAGE_SIZE}${token}`,
                undefined,
                `list comments on work item ${workItem}`);

            const found = page.comments?.find(comment => comment.text?.includes(marker));

            if (found)
                return found;

            continuation = page.continuationToken;

        } while (continuation);

        return undefined;
    }

    addComment(workItem: number, text: string): Promise<AdoComment> {

        return this.call<AdoComment>(
            "POST",
            `${workItem}/comments?api-version=${API_VERSION}`,
            { text },
            `add a comment on work item ${workItem}`);
    }

    updateComment(workItem: number, commentId: number, text: string): Promise<AdoComment> {

        return this.call<AdoComment>(
            "PATCH",
            `${workItem}/comments/${commentId}?api-version=${API_VERSION}`,
            { text },
            `update comment ${commentId} on work item ${workItem}`);
    }

    private async call<T>(
        method: string,
        pathAndQuery: string,
        body: unknown,
        what: string
    ): Promise<T> {

        const controller = new AbortController();

        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        this.ctx.onCancel(() => controller.abort());

        try {

            const response = await fetch(`${this.base}/${pathAndQuery}`, {
                method,
                headers: {
                    "Authorization": this.auth,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok)
                throw new Error(
                    `Could not ${what}: HTTP ${response.status}.` +
                    (response.status === 401 || response.status === 403
                        ? " An expired 'az login' and a PAT without Work Items (Read & Write) scope both land here."
                        : response.status === 404
                            ? " Check 'orgUrl', 'project' and the work item id."
                            : ""));

            return await response.json() as T;

        } catch (error) {

            if (controller.signal.aborted)
                throw new Error(this.ctx.cancelled
                    ? `Stopped while trying to ${what}.`
                    : `Timed out trying to ${what} after ${REQUEST_TIMEOUT_MS / 1000}s.`);

            throw error;

        } finally {

            clearTimeout(timer);
        }
    }
}
