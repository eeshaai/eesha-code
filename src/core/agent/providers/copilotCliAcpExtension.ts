import type { AgentEvent } from "../AgentSession";
import type { AcpPermissionToolCall } from "./acpApproval";
import { compactByCommand } from "./acpCommands";
import type { AcpExtension, AcpExtensionTurn, AcpLocalMcpServer, AcpSessionSetup } from "./acpExtensions";
import { ENGINE_FEATURES } from "./acpNotes";
import type { AcpUsage } from "./AcpProvider";
import { copilotCharge } from "./copilotCharge";

/**
 * GitHub Copilot CLI over ACP (`copilot --acp --stdio`) - the
 * `copilot-cli` extension: the folder boundary, what each turn charged,
 * and the Compact button.
 *
 * Read from Copilot CLI 1.0.85's own ACP code and a no-prompt probe of
 * 1.0.89:
 *
 *   - `allow_all` (on/off) runs every tool without asking when on.
 *   - The Autopilot mode turns `allow_all` on as it is entered.
 *   - Typed `/allow-all`, `/yolo`, `/autopilot`, `/permissions`,
 *     `/add-dir`, `/cwd` and `/sandbox` change the same state, or the
 *     folders Copilot lets a tool reach without a path request.
 *   - A path outside Copilot's own folders is asked about in a request of
 *     its own, titled "Access paths outside trusted directories", always
 *     `kind: "read"` whatever the call does, with every path joined by
 *     ", " into one string.
 *   - Its own events come as `github.com/copilot/sessionEvent`
 *     notifications, only the types a client names in
 *     `clientCapabilities._meta["github.com/copilot"].events` (1.0.81+).
 *     `assistant.usage` is the only place a model call's price is sent;
 *     `usage_update` carries the context window alone.
 *   - The `session/prompt` answer's `usage` is a running total for the
 *     session, and its `inputTokens` already holds the cache reads.
 *   - There is no compact request; `/compact` typed as a message runs it.
 *
 * Seen on Copilot CLI 1.0.110:
 *
 *   - A local tool server sent at `session/new` is refused ("Rejecting
 *     non-http/sse MCP server"), so the session has none of its tools.
 *     `--additional-mcp-config @<file>` at start takes them instead, in
 *     the shape of Copilot's own `mcp-config.json`.
 */
export const COPILOT_AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot";

export const COPILOT_AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";

export const COPILOT_PATH_REQUEST = "Access paths outside trusted directories";

export const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent";

/** The event types asked for - see {@link readCopilotEvent}. */
export const COPILOT_FEED_EVENTS = ["assistant.usage", "session.compaction_start", "session.compaction_complete"];

/** Why `/share` and `/export` are refused - see `blockedReasons`. */
const COPILOT_SHARE_REASON = "it can publish this chat as a GitHub gist, or save it to a file outside this session's folders.";

/** Session notes this file keeps - see `AcpExtensionTurn.note`. */
const USAGE_SO_FAR = "copilot.usageSoFar";

export const copilotCliExtension: AcpExtension = {

    vendor: "GitHub Copilot CLI",

    // Off, as Kiro v3's Autopilot is: the provider answers every request
    // itself, after the folder check.
    permissionOption: { id: "allow_all", value: "off" },

    modeGuard: { hidden: [COPILOT_AUTOPILOT], fallback: COPILOT_AGENT },

    // `/share` (and `/export`, its newer name) saves the chat to a file
    // anywhere or publishes it as a GitHub gist; `/remote` lets the
    // session be used from GitHub.com and GitHub Mobile.
    blockedCommands: ["allow-all", "yolo", "autopilot", "permissions", "add-dir", "cwd", "sandbox", "share", "export", "remote"],

    blockedReasons: {
        share: COPILOT_SHARE_REASON,
        export: COPILOT_SHARE_REASON,
        remote: "it lets this session be used from GitHub.com and GitHub Mobile, outside this chat."
    },

    permissionToolCall: (requested, earlier) => copilotPathRequest(requested, earlier),

    clientMeta: { "github.com/copilot": { events: COPILOT_FEED_EVENTS } },

    notifications: {
        [COPILOT_SESSION_EVENT]: (params, turn) => readCopilotEvent(params, turn)
    },

    turnUsage: (usage, turn) => copilotTurnUsage(usage, turn),

    compact: session => compactByCommand(session, "Copilot"),

    launchArgs: setup => copilotLaunchArgs(setup),

    startMcpServers: servers => ({
        text: copilotMcpConfig(servers),
        args: file => ["--additional-mcp-config", `@${file}`]
    })
};

/**
 * The session's local tool servers as Copilot's own `mcp-config.json`
 * text - the shape `copilot mcp add` writes. Every tool of a server is
 * offered: which ones may run is the permission check's to say.
 *
 * Exported for tests.
 */
export function copilotMcpConfig(servers: readonly AcpLocalMcpServer[]): string {

    const mcpServers = Object.fromEntries(servers.map(server => [server.name, {
        type: "local",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(one => [one.name, one.value])),
        tools: ["*"]
    }]));

    return JSON.stringify({ mcpServers }, null, 2);
}

/**
 * Copilot CLI takes tools away only when it starts: `--excluded-tools`
 * with the names after it (its own `--help`). Put last, so the names
 * cannot run into another option. Copilot has no system prompt over
 * ACP, so the instructions go with the first message instead.
 *
 * Exported for tests.
 */
export function copilotLaunchArgs(setup: AcpSessionSetup): string[] {

    return setup.toolsOff.length ? ["--excluded-tools", ...setup.toolsOff] : [];
}

/**
 * One event off Copilot's feed. A model call's price goes on the turn's
 * bill, the same way ghcp prices it (see `copilotCharge`), and Copilot's
 * own compaction - it compacts by itself near a full window - is said in
 * the chat. Anything else is left alone.
 *
 * Exported for tests.
 */
export function readCopilotEvent(params: unknown, turn: AcpExtensionTurn): AgentEvent | undefined {

    const event = params as { type?: unknown; data?: unknown } | undefined;
    const data = (event?.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;

    switch (event?.type) {

        case "assistant.usage": {

            // The flag is on by default - see `FEATURE_FLAGS`.
            const features = turn.noted(ENGINE_FEATURES) as { hideCopilotPremiumRequests?: boolean } | undefined;
            const charge = copilotCharge(data, features?.hideCopilotPremiumRequests ?? true);

            // Counted even when it priced nothing: one event is one
            // model call.
            turn.charge(charge, undefined, 1);

            return undefined;
        }

        case "session.compaction_start":

            return { name: COPILOT_SESSION_EVENT, raw: params, kind: "notice", progress: true, text: "Copilot is compacting the conversation." };

        case "session.compaction_complete": {

            if (data.success === false)
                return {
                    name: COPILOT_SESSION_EVENT,
                    raw: params,
                    kind: "error",
                    message: `Compaction failed: ${typeof data.error === "string" && data.error ? data.error : "no reason given."}`
                };

            const removed = [
                typeof data.messagesRemoved === "number" ? `${data.messagesRemoved} message${data.messagesRemoved === 1 ? "" : "s"}` : "",
                typeof data.tokensRemoved === "number" && data.tokensRemoved > 0 ? `${data.tokensRemoved} tokens` : ""
            ].filter(Boolean);

            // A short chat's summary can be longer than what it replaced
            // (observed on CLI 1.0.89: -601 tokens "removed").
            const grew = typeof data.tokensRemoved === "number" && data.tokensRemoved < 0
                ? ` The summary is ${-data.tokensRemoved} tokens longer than what it replaced.`
                : "";

            return {
                name: COPILOT_SESSION_EVENT,
                raw: params,
                kind: "notice",
                text: `Conversation compacted${removed.length ? ` - ${removed.join(", ")} removed.` : "."}${grew}`
            };
        }

        default:

            return undefined;
    }
}

/**
 * This turn's token counts, from Copilot's running total: the total now,
 * less the total at the last turn's end. A total smaller than the last -
 * a new process under a resumed conversation - is taken as this turn's
 * own. ACP's cache fields are dropped, since `inputTokens` already holds
 * them: a saved session's figures show `inputTokens` 36,445 as 4 plain,
 * 26,242 cache reads and 10,199 cache writes. The cache reads are kept
 * as `cachedInsideTokens`, which nothing adds to "in".
 *
 * Exported for tests.
 */
export function copilotTurnUsage(usage: AcpUsage | undefined, turn: AcpExtensionTurn): AcpUsage | undefined {

    if (!usage)
        return usage;

    const before = turn.noted(USAGE_SO_FAR) as AcpUsage | undefined;

    turn.note(USAGE_SO_FAR, usage);

    const grew = before !== undefined && (usage.totalTokens ?? 0) >= (before.totalTokens ?? 0);

    const less = (now: number | null | undefined, then: number | null | undefined): number | undefined =>
        typeof now === "number" ? Math.max(0, now - (grew && typeof then === "number" ? then : 0)) : undefined;

    const own: AcpUsage = {};

    const input = less(usage.inputTokens, before?.inputTokens);
    const output = less(usage.outputTokens, before?.outputTokens);
    const total = less(usage.totalTokens, before?.totalTokens);
    const thought = less(usage.thoughtTokens, before?.thoughtTokens);
    const cached = less(usage.cachedReadTokens, before?.cachedReadTokens);

    if (input !== undefined) own.inputTokens = input;
    if (output !== undefined) own.outputTokens = output;
    if (total !== undefined) own.totalTokens = total;
    if (thought !== undefined) own.thoughtTokens = thought;

    // Kept apart from ACP's own cache field, which would be added to
    // "in" again - these are already inside `inputTokens`.
    if (cached) own.cachedInsideTokens = cached;

    return own;
}

/**
 * Copilot's path request, as what it really asks: each path on its own,
 * and the kind of the call that needs them (a `view` reads, an `edit` or a
 * shell command counts as a write). The request carries the call's own id,
 * so `earlier` is that call's `tool_call`. Without one, the kind is
 * `other`, which the boundary treats as a write.
 *
 * Undefined for any other request.
 *
 * Exported for tests.
 */
export function copilotPathRequest(
    requested: AcpPermissionToolCall | undefined,
    earlier: AcpPermissionToolCall | undefined
): AcpPermissionToolCall | undefined {

    if (requested?.title !== COPILOT_PATH_REQUEST)
        return undefined;

    const joined = (requested.rawInput as { path?: unknown } | undefined)?.path;
    const listed = typeof joined === "string"
        ? [joined]
        : (requested.locations ?? []).map(location => location.path);

    // A path with ", " in its own name is split too. Each piece is then
    // checked on its own, so the worst case is a refusal, never a pass.
    const paths = listed
        .flatMap(one => one.split(", "))
        .map(one => one.trim())
        .filter(Boolean);

    return {
        ...requested,
        kind: earlier?.kind ?? "other",
        locations: paths.map(path => ({ path })),
        rawInput: { paths }
    };
}
