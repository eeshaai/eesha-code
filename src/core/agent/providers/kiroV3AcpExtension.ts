import type { ContextPart, McpServerState } from "../../models/run";
import type { AgentEvent } from "../AgentSession";
import type { AcpPermissionToolCall } from "./acpApproval";
import type { AcpExtension, AcpExtensionSession, AcpExtensionTurn, AcpSessionSetup } from "./acpExtensions";
import { accountNotice, kiroAccount, kiroCharges, kiroDuration, kiroParts } from "./kiroShared";

/**
 * Kiro CLI's v3 engine (`kiro-cli acp --agent-engine v3 --auth-method
 * cli`, "KAS") - the `kiro-v3` extension.
 *
 * This is the only Kiro engine Eesha Code runs: the `kiro-cli` runtime.
 *
 * Observed on KAS 0.66.8. None of it is in Kiro's public ACP docs, and
 * the engine is a beta, so every field is read as optional.
 *
 * What the usage card needs rides on standard `session/update`s - a
 * `session_info_update` whose `_meta.kiro.kind` says what it is:
 *
 *   - `context_usage`: `usagePercentage` (0-100), several times a turn.
 *     Most also carry `breakdown` - the parts of the window, tokens
 *     only, with tools as `builtin` and `mcp` totals and no per-tool
 *     list.
 *   - `turn_completion`: `promptTurnSummaries` - a list of
 *     `{ usage, unit, unitPlural }` (unit `credit`) - and `elapsedTime`
 *     in milliseconds. What that turn charged, before the
 *     `session/prompt` response.
 *
 * No window size is worked out. v3's token counts do not
 * match its own percentage - "Your prompts" read 0 tokens as 1.9%, and
 * the size they implied ran from 149k to 1M within one session - so the
 * share is Kiro's own and the parts are token counts beside it.
 *
 * On `session/load`, v3 replays each old turn's updates, `replay: true`
 * on each. They arrive before the load answers, when nothing is
 * listening yet; they are skipped here as well, so a replay can never
 * charge a turn twice.
 *
 * The account's usage is `_kiro/account/getUsage`, asked after each turn.
 *
 * Kiro's warnings, one log line each (read from KAS 0.66.70's own code,
 * kiro-cli 3.0.0) - see {@link kiroV3SystemText} and the readers below:
 * its own notices (a model swapped for one the account has, MCP servers
 * still starting), running out of model capacity, a model switched
 * mid-turn, a turn waiting for another session, and a mode Kiro does not
 * have. One that comes before the first message is held until then,
 * like the MCP line.
 */
export const KIRO_V3_INFO = "session_info_update";

export const KIRO_V3_USAGE = "_kiro/account/getUsage";

export const KIRO_V3_MCP_STATUS = "_kiro/mcp/status";

export const KIRO_V3_MCP_GOVERNANCE = "_kiro/mcp/governance_disabled";

export const KIRO_V3_SYSTEM_NOTIFY = "_kiro/system/notify";

export const KIRO_V3_RATE_LIMIT = "_kiro/error/rate_limit";

export const KIRO_V3_MODE_NOT_FOUND = "_kiro/customAgent/not_found";

export const KIRO_V3_AGENT_FILE_ERROR = "_kiro/customAgent/config_error";

export const KIRO_V3_STEER = "_session/steer";

/** Session notes this file keeps - see `AcpExtensionTurn.note`. */
const HELD = "kiro.v3.held";
const PARTS = "kiro.v3.parts";
const NO_USAGE = "kiro.v3.noUsage";
const MCP_LAST = "kiro.v3.mcp.last";
const MCP_SHOWN = "kiro.v3.mcp.shown";
const MCP_LIST = "kiro.v3.mcp.list";
const GOVERNANCE_LAST = "kiro.v3.mcp.governance.last";
const GOVERNANCE_SHOWN = "kiro.v3.mcp.governance.shown";
const STARTED = "kiro.v3.started";
const STEERING = "kiro.v3.steering";

export const kiroV3Extension: AcpExtension = {

    vendor: "Kiro (v3 engine)",

    updates: {
        [KIRO_V3_INFO]: (update, turn) => readKiroV3Info(update, turn)
    },

    notifications: {
        [KIRO_V3_MCP_STATUS]: (params, turn) => readKiroV3McpStatus(params, turn),
        [KIRO_V3_MCP_GOVERNANCE]: (params, turn) => readKiroV3McpGovernance(params, turn),
        [KIRO_V3_SYSTEM_NOTIFY]: (params, turn) => warning(KIRO_V3_SYSTEM_NOTIFY, params, kiroV3SystemText(params), turn),
        [KIRO_V3_RATE_LIMIT]: (params, turn) => warning(KIRO_V3_RATE_LIMIT, params, kiroV3RateLimitText(params), turn),
        [KIRO_V3_MODE_NOT_FOUND]: (params, turn) => warning(KIRO_V3_MODE_NOT_FOUND, params, kiroV3ModeNotFoundText(params), turn),
        [KIRO_V3_AGENT_FILE_ERROR]: (params, turn) => warning(KIRO_V3_AGENT_FILE_ERROR, params, kiroV3AgentFileErrorText(params), turn)
    },

    steer: (session, text) => steerKiroV3(session, text),

    afterTurn: async session => {

        const event = await askKiroV3Usage(session);

        return event ? [event] : [];
    },

    // The same ask at the start, so the account shows before the first
    // turn ends. And the MCP servers' state as it stood when the session
    // opened - reported before anything was listening. The org turning
    // MCP off comes first: it is why the status line may say nothing.
    // Then Kiro's warnings from before the first message, in the order
    // they came.
    atStart: async session => {

        const governance = heldMcpGovernance(session);
        const mcp = heldMcpStatus(session);
        const warnings = heldWarnings(session);
        const event = await askKiroV3Usage(session);

        return [...(governance ? [governance] : []), ...(mcp ? [mcp] : []), ...warnings, ...(event ? [event] : [])];
    },

    modelMultiplier: choice => kiroV3RateMultiplier(choice),

    permissionAnswer: params => kiroV3TurnApproval(params),

    compact: session => compactKiroV3(session),

    // kiro-cli 2.24.1: `autopilot` "on" runs tools without asking, "off"
    // asks before file changes. Off: a tool call Kiro never
    // asks about never reaches our folder boundary. The provider answers
    // every request itself, after the boundary check.
    permissionOption: { id: "autopilot", value: "off" },

    sessionMeta: setup => kiroV3SessionMeta(setup),

    toolName: toolCall => kiroV3ToolName(toolCall)
};

/** The steering entry our standing instructions go in - see {@link kiroV3SessionMeta}. */
export const KIRO_V3_STEERING_NAME = "eesha";

/**
 * The standing instructions as one steering file Kiro is handed with the
 * session: `_meta.kiro.steering` on `session/new` and `session/load`,
 * `{ name, inclusion, content }` each (read from kiro-cli 3.2.1's own
 * code). Kiro puts steering into its system prompt beside its own
 * default one, so it holds after a compact. Nothing for empty
 * instructions.
 *
 * Kiro v3 has no way to take a tool away short of its own agent, which
 * replaces Kiro's default prompt - so the tools are refused at the
 * permission request instead (see {@link kiroV3ToolName}).
 *
 * Kiro drops the whole `_meta.kiro` when one field in it is wrong, so
 * only `steering` is sent, inside its limit of 1,000,000 characters.
 *
 * Exported for tests.
 */
export function kiroV3SessionMeta(setup: AcpSessionSetup): Record<string, unknown> {

    const content = setup.instructions.trim().slice(0, KIRO_STEERING_LIMIT);

    return content
        ? { kiro: { steering: [{ name: KIRO_V3_STEERING_NAME, inclusion: "always", content }] } }
        : {};
}

const KIRO_STEERING_LIMIT = 1_000_000;

/** Kiro v3's own tool titles, by tool name (kiro-cli 3.2.1's own code). */
const KIRO_V3_TITLES: Readonly<Record<string, string>> = {
    "replace in file": "str_replace",
    "write file": "fs_write",
    "append to file": "fs_append"
};

/**
 * Kiro v3's own name for the tool behind a permission request. Its
 * request carries a title, and its call's input: `str_replace` takes
 * `oldStr` and `newStr` (kiro-cli 3.2.1's own code), so that input is
 * named `str_replace` whatever the title says. Otherwise a title that
 * is one of Kiro's own tool titles ("Replace in File") gives the name.
 * Not observed yet.
 *
 * Exported for tests.
 */
export function kiroV3ToolName(toolCall: AcpPermissionToolCall | undefined): string | undefined {

    const input = toolCall?.rawInput;

    if (input && typeof input === "object" && "oldStr" in input && "newStr" in input)
        return "str_replace";

    const title = toolCall?.title?.trim().toLowerCase();

    return title ? KIRO_V3_TITLES[title] : undefined;
}

export const KIRO_V3_COMPACT = "_kiro/session/compact";

/**
 * `_kiro/session/compact` - Kiro writes a summary of the conversation
 * and carries on from it. Read from KAS 2.24.1's own code: params are
 * `{ sessionId }`, the answer `{ success }`. It says `success: false`
 * without a reason when a turn is running, when a compact is already
 * going, or while a message is still being saved; `success: true` also
 * covers "nothing to compact yet".
 *
 * Exported for tests.
 */
export async function compactKiroV3(session: AcpExtensionSession): Promise<{ ok: boolean; reason?: string }> {

    try {

        const result = await session.request(KIRO_V3_COMPACT, { sessionId: session.sessionId }) as { success?: unknown } | undefined;

        return result?.success === true
            ? { ok: true }
            : { ok: false, reason: "Kiro did not compact - it is busy with a turn or already compacting. Try again once it is idle." };

    } catch (error) {

        return { ok: false, reason: `Kiro could not compact: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/**
 * Kiro v3's end-of-turn "Review changes" request, accepted.
 *
 * With Autopilot off, Kiro asks for each write ("Write File"), and then,
 * as the turn ends, once more for every file the turn changed - a
 * `session/request_permission` whose `_meta.kiro.type` is `turn_approval`
 * and whose `_meta.kiro.files` lists them (kiro-cli 2.24.1, observed).
 * Each write was already allowed on its own card, so the second yes is
 * given here and the files are named in the log instead.
 *
 * Undefined for any other request, or one without an accepting option.
 *
 * Exported for tests.
 */
export function kiroV3TurnApproval(params: unknown): { optionId: string; paths: string[]; line: string } | undefined {

    const request = params as {
        options?: { optionId?: unknown; kind?: unknown }[];
        _meta?: { kiro?: { type?: unknown; files?: unknown } };
    } | undefined;

    const kiro = request?._meta?.kiro;

    if (kiro?.type !== "turn_approval")
        return undefined;

    const accept = (request?.options ?? []).find(option => option?.kind === "allow_once" && typeof option.optionId === "string");

    if (!accept)
        return undefined;

    const paths = Array.isArray(kiro.files)
        ? kiro.files.flatMap(file => typeof (file as { path?: unknown })?.path === "string" ? [(file as { path: string }).path] : [])
        : [];

    const names = paths.map(one => one.split(/[\\/]/).pop() || one);

    return {
        optionId: accept.optionId as string,
        paths,
        line: `Kiro asked to review this turn's changes${names.length ? ` (${names.join(", ")})` : ""}`
            + " - accepted, since each change was already allowed when it was made."
    };
}

/**
 * A model choice's credit rate, from `_meta.kiro.rateMultiplier` on the
 * model config option (kiro-cli 2.24.1: Auto 1, Claude Sonnet 4.5 1.3,
 * Claude Haiku 4.5 0.4). Undefined when it is not a number.
 *
 * Exported for tests.
 */
export function kiroV3RateMultiplier(choice: unknown): number | undefined {

    const rate = (choice as { _meta?: { kiro?: { rateMultiplier?: unknown } } } | undefined)?._meta?.kiro?.rateMultiplier;

    return typeof rate === "number" && Number.isFinite(rate) ? rate : undefined;
}

/**
 * `_kiro/mcp/status` - every MCP server the session has and how it
 * stands, sent each time one changes. Read from KAS 2.24.1's own code:
 * `servers` is a list of `{ name, status }`, status `connecting`,
 * `connected` (with `tools`), `failed` (with `errorMessage`, and
 * `failedAuthorization` / `authorizationUrl` when it needs a sign-in)
 * or `disabled`. With an org MCP registry, `accessModeFilteredServers`
 * and `unresolvedRegistryServers` name servers the org's policy kept out.
 *
 * One line in the chat, only when it says something new, and not while
 * a server is still connecting - so a start-up reads as one line, not
 * one per server per step. Until the first message goes out nothing is
 * listening, so the line is kept and {@link heldMcpStatus} shows it then.
 *
 * Exported for tests.
 */
export function readKiroV3McpStatus(params: unknown, turn: AcpExtensionTurn): AgentEvent | undefined {

    const text = kiroV3McpText(params);

    if (!text || text === turn.noted(MCP_SHOWN))
        return undefined;

    const mcp = kiroV3McpList(params);

    turn.note(MCP_LAST, text);
    turn.note(MCP_LIST, mcp);

    if (turn.noted(STARTED) !== true)
        return undefined;

    turn.note(MCP_SHOWN, text);

    return { name: KIRO_V3_MCP_STATUS, raw: params, kind: "notice", text, mcp };
}

/**
 * The MCP line kept from before the first message, if it was not shown
 * yet - see {@link readKiroV3McpStatus}. Marks the session started, so
 * later changes show as they come.
 */
function heldMcpStatus(session: AcpExtensionTurn): AgentEvent | undefined {

    session.note(STARTED, true);

    const text = session.noted(MCP_LAST);

    if (typeof text !== "string" || text === session.noted(MCP_SHOWN))
        return undefined;

    session.note(MCP_SHOWN, text);

    const mcp = session.noted(MCP_LIST);

    return { name: KIRO_V3_MCP_STATUS, raw: { text }, kind: "notice", text, ...(Array.isArray(mcp) ? { mcp: mcp as McpServerState[] } : {}) };
}

/**
 * `_kiro/mcp/governance_disabled` - the org's Kiro settings turned MCP
 * off, so Kiro starts no MCP server at all, including every one sent on
 * `session/new`. Read from KAS 2.24.1's own code: sent once, straight
 * after `session/new`, as `{ sessionId, reason }`. `reason` is
 * `admin_disabled` (the admin switched MCP off) or `api_failure` (Kiro
 * could not read the org's settings, and turned MCP off to be safe).
 *
 * Without this line the chat shows nothing - no server is started, so
 * no `_kiro/mcp/status` names one - and the model just says it has no
 * MCP. Held until the first message, the same way as the status line.
 *
 * Exported for tests.
 */
export function readKiroV3McpGovernance(params: unknown, turn: AcpExtensionTurn): AgentEvent | undefined {

    const text = kiroV3GovernanceText(params);

    if (text === turn.noted(GOVERNANCE_SHOWN))
        return undefined;

    turn.note(GOVERNANCE_LAST, text);

    if (turn.noted(STARTED) !== true)
        return undefined;

    turn.note(GOVERNANCE_SHOWN, text);

    return { name: KIRO_V3_MCP_GOVERNANCE, raw: params, kind: "notice", text };
}

/** The governance line kept from before the first message, if it was not shown yet. */
function heldMcpGovernance(session: AcpExtensionTurn): AgentEvent | undefined {

    session.note(STARTED, true);

    const text = session.noted(GOVERNANCE_LAST);

    if (typeof text !== "string" || text === session.noted(GOVERNANCE_SHOWN))
        return undefined;

    session.note(GOVERNANCE_SHOWN, text);

    return { name: KIRO_V3_MCP_GOVERNANCE, raw: { text }, kind: "notice", text };
}

/**
 * The governance notice as one line, naming the reason in plain words
 * and Kiro's own code after it. A reason this build does not know is
 * shown as Kiro sent it.
 *
 * Exported for tests.
 */
export function kiroV3GovernanceText(params: unknown): string {

    const reason = (params as { reason?: unknown } | undefined)?.reason;

    const code = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;

    const why = code === "admin_disabled"
        ? "your org's Kiro admin turned MCP off"
        : code === "api_failure"
            ? "Kiro could not read your org's Kiro settings, so it turned MCP off to be safe"
            : "your org's Kiro settings turned MCP off";

    return `MCP: off - ${why}. No MCP server was started, including the ones sent from settings.json`
        + `${code ? ` (reason: ${code})` : ""}.`;
}

/**
 * The status as one line: `MCP: ado connected (12 tools) · github failed
 * - token expired`. Undefined while a server is still connecting, and
 * when there is nothing to say (no servers, none kept out).
 *
 * Exported for tests.
 */
export function kiroV3McpText(params: unknown): string | undefined {

    const status = params as {
        servers?: unknown;
        accessModeFilteredServers?: unknown;
        unresolvedRegistryServers?: unknown;
    } | undefined;

    const servers = Array.isArray(status?.servers) ? status.servers as Record<string, unknown>[] : [];

    if (servers.some(server => server?.status === "connecting"))
        return undefined;

    const parts = servers.flatMap(server => {

        const name = typeof server?.name === "string" ? server.name : undefined;

        if (!name)
            return [];

        switch (server.status) {

            case "connected": {

                const tools = Array.isArray(server.tools) ? server.tools.length : undefined;

                return [`${name} connected${tools !== undefined ? ` (${tools} tool${tools === 1 ? "" : "s"})` : ""}`];
            }

            case "failed": {

                const why = server.failedAuthorization === true
                    ? `needs sign-in${typeof server.authorizationUrl === "string" ? ` at ${server.authorizationUrl}` : ""}`
                    : typeof server.errorMessage === "string" && server.errorMessage.trim()
                        ? clipLine(server.errorMessage)
                        : "no reason given";

                return [`${name} failed - ${why}`];
            }

            case "disabled":

                return [`${name} turned off`];

            default:

                return [];
        }
    });

    const blocked = [...namesOf(status?.accessModeFilteredServers), ...namesOf(status?.unresolvedRegistryServers)];

    if (blocked.length)
        parts.push(`kept out by your org's MCP policy: ${[...new Set(blocked)].join(", ")}`);

    return parts.length ? `MCP: ${parts.join(" · ")}` : undefined;
}

/**
 * The same `_kiro/mcp/status` as data, for the Session panel: one row
 * per named server, in Kiro's order, with its status word as Kiro sent
 * it. Servers the org's policy kept out are left out here; the line
 * from {@link kiroV3McpText} still names them.
 *
 * Exported for tests.
 */
export function kiroV3McpList(params: unknown): McpServerState[] {

    const servers = (params as { servers?: unknown } | undefined)?.servers;

    if (!Array.isArray(servers))
        return [];

    return (servers as Record<string, unknown>[]).flatMap(server => {

        const name = typeof server?.name === "string" ? server.name : undefined;
        const status = typeof server?.status === "string" ? server.status : undefined;

        if (!name || !status)
            return [];

        const tools = status === "connected" && Array.isArray(server.tools) ? server.tools.length : undefined;
        const needsSignIn = status === "failed" && server.failedAuthorization === true;
        const reason = status === "failed" && typeof server.errorMessage === "string" && server.errorMessage.trim()
            ? clipLine(server.errorMessage)
            : undefined;

        return [{
            name,
            status,
            ...(tools !== undefined ? { tools } : {}),
            ...(reason ? { reason } : {}),
            ...(needsSignIn ? { needsSignIn } : {})
        }];
    });
}

/** Server names from a list of names or of `{ name }` - the shape is not in Kiro's code we could read. */
function namesOf(list: unknown): string[] {

    return Array.isArray(list)
        ? list.flatMap(one => typeof one === "string" ? [one]
            : typeof (one as { name?: unknown })?.name === "string" ? [(one as { name: string }).name] : [])
        : [];
}

/** An error message on one line, short enough to sit in the chat. */
function clipLine(text: string, max = 160): string {

    const line = text.replace(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * One of Kiro's warnings as a log line - shown at once after the first
 * message, kept until then (see {@link heldWarnings}). Nothing when the
 * text is empty.
 */
function warning(name: string, raw: unknown, text: string | undefined, turn: AcpExtensionTurn): AgentEvent | undefined {

    if (!text)
        return undefined;

    const event: AgentEvent = { name, raw, kind: "notice", text };

    if (turn.noted(STARTED) === true)
        return event;

    const held = turn.noted(HELD);

    turn.note(HELD, [...(Array.isArray(held) ? held : []), event]);

    return undefined;
}

/** The warnings kept from before the first message, in order, once. Marks the session started. */
function heldWarnings(session: AcpExtensionTurn): AgentEvent[] {

    session.note(STARTED, true);

    const held = session.noted(HELD);

    session.note(HELD, []);

    return Array.isArray(held) ? held as AgentEvent[] : [];
}

/** A non-empty, trimmed string, or undefined. */
function textOf(value: unknown): string | undefined {

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * `_kiro/system/notify` - `{ level, message }`, a notice Kiro shows in its
 * own UI. Seen in KAS 0.66.70's code: "Model X isn't available for the
 * current account. Switched to Y." (level `info`), MCP servers still
 * connecting or failing to connect (level `warning`). It names no
 * session; the process serves one.
 *
 * Exported for tests.
 */
export function kiroV3SystemText(params: unknown): string | undefined {

    const { level, message } = (params ?? {}) as { level?: unknown; message?: unknown };

    const text = textOf(message);

    if (!text)
        return undefined;

    const label = level === "warning" ? "Kiro warning" : level === "error" ? "Kiro error" : "Kiro";

    return `${label}: ${clipLine(text, 400)}`;
}

/**
 * `_kiro/error/rate_limit` - `{ sessionId, message }`, sent when the
 * model has no capacity or the service is under high load. Kiro also
 * puts the same message in the chat when it stops the turn; this line
 * says what kind of failure it was.
 *
 * Exported for tests.
 */
export function kiroV3RateLimitText(params: unknown): string {

    const text = textOf((params as { message?: unknown } | undefined)?.message);

    return `Kiro is overloaded - the model has no capacity right now${text ? `: ${clipLine(text, 400)}` : "."}`;
}

/**
 * `_kiro/customAgent/not_found` - `{ sessionId, requestedAgent,
 * fallbackAgent, skipped? }`, sent when the mode asked for is not one
 * Kiro has (or is not allowed), so it runs another one instead - `vibe`,
 * which Kiro calls Default. `skipped` is the agent file Kiro could not
 * load for it: `{ path, reasonCode, error }`.
 *
 * Exported for tests.
 */
export function kiroV3ModeNotFoundText(params: unknown): string | undefined {

    const { requestedAgent, fallbackAgent, skipped } = (params ?? {}) as Record<string, unknown>;

    const asked = textOf(requestedAgent);

    if (!asked)
        return undefined;

    const fallback = textOf(fallbackAgent);

    const instead = fallback === "vibe" ? "Default" : fallback;

    const { path, reasonCode, error } = (skipped ?? {}) as Record<string, unknown>;

    const why = textOf(error) ?? textOf(reasonCode);

    const file = textOf(path);

    return `Kiro has no mode "${asked}"${instead ? ` - it runs in ${instead} mode instead` : ""}.`
        + (why || file ? ` Its agent file was skipped${file ? ` (${file})` : ""}${why ? `: ${clipLine(why)}` : ""}.` : "");
}

/**
 * `_kiro/customAgent/config_error` - `{ sessionId, path, reasonCode,
 * error }`, sent for each agent file Kiro could not load (read from
 * kiro-cli 3.2.1's own code). The mode it describes is then missing.
 *
 * Exported for tests.
 */
export function kiroV3AgentFileErrorText(params: unknown): string | undefined {

    const { path, reasonCode, error } = (params ?? {}) as Record<string, unknown>;

    const file = textOf(path);
    const why = textOf(error) ?? textOf(reasonCode);

    if (!file && !why)
        return undefined;

    return `Kiro could not load an agent file${file ? ` (${file})` : ""}${why ? `: ${clipLine(why, 400)}` : ""}.`;
}

/**
 * `_session/steer` - hands a message to the running turn. Read from
 * kiro-cli 3.2.1's own code and tried live: params `{ sessionId,
 * message }` with `message` as plain text; the answer is `{ queued:
 * true, messageId }`, or `{ queued: false, messageId, dropped }` when the
 * turn moved on while the message was being saved. Kiro then reports it
 * as `steering_queued`, `steering_injected` and `steering_cleared` - see
 * {@link readKiroV3Steering}. A message that comes after the agent has
 * finished writing still gets an answer: Kiro runs one more turn for it
 * inside the same `session/prompt`.
 *
 * Exported for tests.
 */
export async function steerKiroV3(session: AcpExtensionSession, text: string): Promise<{ ok: boolean; reason?: string }> {

    if (!text.trim())
        return { ok: false, reason: "An empty message was not sent." };

    try {

        const result = await session.request(KIRO_V3_STEER, { sessionId: session.sessionId, message: text }) as
            { queued?: unknown; dropped?: unknown } | undefined;

        if (result?.queued === true)
            return { ok: true };

        return {
            ok: false,
            reason: `Kiro did not take your message into the running turn${textOf(result?.dropped) ? ` (${textOf(result?.dropped)})` : ""}. Send it again.`
        };

    } catch (error) {

        return { ok: false, reason: `Kiro did not take your message into the running turn: ${error instanceof Error ? error.message : String(error)}. Send it again.` };
    }
}

/**
 * Kiro's three steering kinds, as lines in the chat. `steering_queued`:
 * the message waits for the agent's next step. `steering_injected`: the
 * agent has it. `steering_cleared` lists the ids the turn is done with;
 * one never injected was dropped, and the person is told to send it again.
 *
 * Exported for tests.
 */
export function readKiroV3Steering(kiro: Record<string, unknown>, update: unknown, turn: AcpExtensionTurn): AgentEvent | undefined {

    const waiting = new Set(Array.isArray(turn.noted(STEERING)) ? turn.noted(STEERING) as string[] : []);
    const id = textOf(kiro.messageId);

    const line = (text: string): AgentEvent => ({ name: KIRO_V3_INFO, raw: update, kind: "notice", text });

    if (kiro.kind === "steering_queued") {

        if (id)
            turn.note(STEERING, [...waiting, id]);

        return line("Your message is waiting - Kiro adds it to the running turn at its next step.");
    }

    if (kiro.kind === "steering_injected") {

        if (id)
            turn.note(STEERING, [...waiting].filter(one => one !== id));

        return line("Kiro added your message to the running turn.");
    }

    const cleared = Array.isArray(kiro.messageIds) ? kiro.messageIds.filter((one): one is string => typeof one === "string") : [];
    const dropped = cleared.filter(one => waiting.has(one));

    turn.note(STEERING, [...waiting].filter(one => !cleared.includes(one)));

    return dropped.length
        ? line(`Kiro dropped ${dropped.length === 1 ? "your message" : `${dropped.length} of your messages`} before the agent read ${dropped.length === 1 ? "it" : "them"}. Send ${dropped.length === 1 ? "it" : "them"} again.`)
        : undefined;
}

/**
 * `session_info_update` kind `model_fallback` - `{ from, to?, scope?,
 * trigger, reason? }`. With `to`, Kiro switched the turn to another
 * model; without it, Kiro wanted to and could not, and `reason` says why.
 * `trigger` is `availability` or `refusal`. Model ids as Kiro lists them.
 *
 * Exported for tests.
 */
export function kiroV3FallbackText(kiro: Record<string, unknown>): string {

    const from = textOf(kiro.from) ?? "the model";
    const to = textOf(kiro.to);
    const trigger = textOf(kiro.trigger);
    const reason = textOf(kiro.reason);

    const why = trigger === "availability" ? "it was not available"
        : trigger === "refusal" ? "it refused the request"
            : trigger ? `trigger: ${trigger}` : undefined;

    if (to)
        return `Kiro switched the model from ${from} to ${to}${kiro.scope === "turn" ? " for this turn" : ""}`
            + `${why ? ` - ${why}` : ""}.`;

    const words: Record<string, string> = {
        noServedTarget: "no other model was available",
        chainExhausted: "every other model was already tried",
        unsafeToReissue: "sending the request again was not safe"
    };

    const cause = !reason ? ""
        : words[reason] ? ` - ${words[reason]} (reason: ${reason})`
            : ` (reason: ${reason})`;

    return `Kiro could not switch away from ${from}${why ? ` after ${why}` : ""}${cause}.`;
}

/**
 * `session_info_update` kind `queued` - `{ activeSessionId }`: this turn
 * waits until another session in the same Kiro process finishes its turn.
 *
 * Exported for tests.
 */
export function kiroV3QueuedText(kiro: Record<string, unknown>): string {

    const other = textOf(kiro.activeSessionId);

    return `Waiting - Kiro is busy with another session${other ? ` (${other})` : ""}. This turn starts when that one ends.`;
}

/**
 * One `session_info_update`, when it carries Kiro's `_meta` - a charge on
 * the turn's bill, a context notice, or a warning (a model switched
 * mid-turn, a turn waiting for another session). Anything else is left
 * alone.
 *
 * Exported for tests.
 */
export function readKiroV3Info(update: unknown, turn: AcpExtensionTurn): AgentEvent | undefined {

    const kiro = ((update as { _meta?: { kiro?: unknown } } | undefined)?._meta?.kiro ?? undefined) as
        Record<string, unknown> | undefined;

    if (!kiro || typeof kiro !== "object" || kiro.replay === true)
        return undefined;

    if (kiro.kind === "turn_completion") {

        const charges = kiroCharges(kiro.promptTurnSummaries);

        if (charges.length)
            turn.charge(charges, kiroDuration(kiro.elapsedTime));

        return undefined;
    }

    if (kiro.kind === "model_fallback")
        return warning(KIRO_V3_INFO, update, kiroV3FallbackText(kiro), turn);

    if (kiro.kind === "queued")
        return warning(KIRO_V3_INFO, update, kiroV3QueuedText(kiro), turn);

    if (kiro.kind === "steering_queued" || kiro.kind === "steering_injected" || kiro.kind === "steering_cleared")
        return readKiroV3Steering(kiro, update, turn);

    if (kiro.kind !== "context_usage")
        return undefined;

    const percent = typeof kiro.usagePercentage === "number"
        ? kiro.usagePercentage
        : (kiro.contextUsage as { usagePercentage?: unknown } | undefined)?.usagePercentage;

    if (typeof percent !== "number" || !Number.isFinite(percent))
        return undefined;

    // The newest breakdown, kept for the updates that carry only the
    // share - otherwise the card's parts would vanish mid-turn and come
    // back at its end.
    const fresh = kiroParts(kiro.breakdown);

    if (fresh.length)
        turn.note(PARTS, fresh);

    const parts = turn.noted(PARTS) as ContextPart[] | undefined;

    const share = Math.min(100, Math.max(0, percent));

    return {
        name: KIRO_V3_INFO,
        raw: update,
        kind: "notice",
        progress: true,
        text: `Context ${Math.round(share)}% used`,

        // A share with no size: `used` out of 100, flagged, so no page
        // prints it - or the parts beside it - against a window size.
        context: { used: share, size: 100, percentOnly: true, ...(parts?.length ? { parts } : {}) }
    };
}

/**
 * `_kiro/account/getUsage`, as an account notice. An engine that answers
 * "method not found" is not asked again this session.
 *
 * Exported for tests.
 */
export async function askKiroV3Usage(session: AcpExtensionSession): Promise<AgentEvent | undefined> {

    if (session.noted(NO_USAGE) === true)
        return undefined;

    let result: unknown;

    try {

        result = await session.request(KIRO_V3_USAGE, { sessionId: session.sessionId });

    } catch (error) {

        if ((error as { code?: unknown } | undefined)?.code === -32601)
            session.note(NO_USAGE, true);

        return undefined;
    }

    const account = kiroAccount(result);

    return account ? accountNotice(KIRO_V3_USAGE, result, account) : undefined;
}
