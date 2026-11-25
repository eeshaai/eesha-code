import type { Spend } from "../../models/run";
import type { AgentEvent } from "../AgentSession";
import type { AcpPermissionToolCall } from "./acpApproval";
import type { AcpPromptResponse, AcpUsage } from "./AcpProvider";
import type { AcpMcpServer } from "./mcpServers";
import { claudeCliExtension } from "./claudeCliAcpExtension";
import { copilotCliExtension } from "./copilotCliAcpExtension";
import { kiroV3Extension } from "./kiroV3AcpExtension";

/**
 * One vendor's own ACP extras, on top of the protocol.
 *
 * An agent can send things ACP does not define: notifications of its
 * own (`_kiro/mcp/status`), its own data inside a standard
 * `session/update` (`_meta` on a `session_info_update`), and requests
 * of its own that it answers. Each extension handles one vendor's, and
 * `AcpProvider` stays the same for every agent.
 *
 * Which extensions a runtime gets is settings: `ai.acpAgents.<id>.extensions`
 * lists their ids from {@link ACP_EXTENSIONS} (see `acpConfig.ts`, which
 * also fills it in for a built-in id). An entry with none gets none - a
 * plain ACP agent runs on the protocol alone. It is chosen per runtime
 * rather than by message name, so an agent that only borrows a vendor's
 * command gets that vendor's extras only when it asks for them.
 *
 * To add a vendor: write a file like `kiroV3AcpExtension.ts`, add it to
 * {@link ACP_EXTENSIONS}, and name it on the runtimes it belongs to.
 */
export interface AcpExtension {

    /** Whose extras these are - for comments and tests, never for matching. */
    readonly vendor: string;

    /**
     * The vendor's own notifications this extension reads, by method name.
     * Each gets the message's raw params (never validated by the SDK -
     * they are the vendor's) and the session, and may return one event to
     * publish.
     *
     * A reader must not throw on a shape it does not know - vendor messages
     * are unstable by nature - but if one does, the session drops that
     * message and carries on.
     */
    readonly notifications?: Readonly<Record<string, AcpExtensionReader>>;

    /**
     * Standard `session/update`s this extension also reads, by their
     * `sessionUpdate` kind - for a vendor that puts its own data inside
     * one (Kiro v3's `_meta` on `session_info_update`). The reader gets
     * the update itself. The engine's own handling of the update still
     * runs; this is in addition to it. Same rules as {@link notifications}.
     */
    readonly updates?: Readonly<Record<string, AcpExtensionReader>>;

    /**
     * Runs once each turn has ended, before whoever ran the turn is
     * released - the only point where an event still reaches a caller that
     * disposes the session as soon as the turn is over. May ask the agent
     * something and return events to publish.
     *
     * Capped by the session, so an agent that never answers costs the turn
     * a few seconds and no more. A throw or a timeout costs the events,
     * never the turn.
     */
    afterTurn?(session: AcpExtensionSession): Promise<readonly AgentEvent[]>;

    /**
     * Runs once, on the session's first message - for what should show
     * before the first turn ends (Kiro's account usage). Not awaited: the
     * message goes out at once and these events are published when they
     * land. Capped and forgiving the same way as {@link afterTurn}.
     */
    atStart?(session: AcpExtensionSession): Promise<readonly AgentEvent[]>;

    /**
     * What one model costs as a multiple of the base rate, read from the
     * vendor's own data on a model choice (Kiro v3's `rateMultiplier`) -
     * shown beside the model's name in the picker. Undefined when the
     * choice carries none.
     */
    modelMultiplier?(choice: unknown): number | undefined;

    /**
     * What one model costs, as short text read from the vendor's own data
     * on a model choice (claude-agent-acp's `$5/$25 per Mtok` in the
     * description) - shown beside the name where there is no multiplier.
     */
    modelPrice?(choice: unknown): string | undefined;

    /**
     * The vendor's own session option that decides whether the agent asks
     * before it uses a tool (Kiro v3's `autopilot`), and the value that
     * makes it ask. Set on every session and put back when the agent
     * changes it. An agent that runs tools without asking never sends a
     * permission request, so the permission check has nothing to answer and
     * the folder boundary has nothing to check - which is why Kiro v3 is
     * set to ask.
     */
    readonly permissionOption?: { id: string; value: string };

    /**
     * A permission request this extension answers itself,
     * whatever the level - one that asks nothing a person has not already
     * answered (Kiro v3's end-of-turn "Review changes", after each write
     * was already allowed on its own). Given the request's raw params.
     *
     * `paths` are the files it covers: held to the folder boundary as
     * writes first, and refused if one is outside. `line` goes in the log.
     * Undefined leaves the request to the usual handling.
     */
    permissionAnswer?(params: unknown): { optionId: string; paths: string[]; line: string } | undefined;

    /**
     * Shrinks the session's context with the vendor's own request (Kiro
     * v3's `_kiro/session/compact`). Resolves with whether it worked and,
     * when not, why. A session whose runtime has an extension with this
     * offers the Compact button - see `AgentSession.compact`.
     */
    compact?(session: AcpExtensionSession): Promise<{ ok: boolean; reason?: string }>;

    /**
     * Hands a message sent while a turn is running to that turn, with the
     * vendor's own request (Kiro v3's `_session/steer`), instead of a second
     * `session/prompt` that would wait for the turn to end. Text only: a
     * message with files goes as a normal prompt. Resolves with whether
     * the agent took it and, when not, why.
     */
    steer?(session: AcpExtensionSession, text: string): Promise<{ ok: boolean; reason?: string }>;

    /**
     * The agent's modes that run tools without asking (Copilot CLI's
     * Autopilot, claude-agent-acp's Bypass permissions). A tool call the
     * agent never asks about never reaches the folder boundary, so these
     * are never offered in the picker, never set, and a session found in
     * one - a settings file's default, or the agent switching itself - is
     * put back in `fallback`. Values as the agent's mode option lists them.
     */
    readonly modeGuard?: { hidden: readonly string[]; fallback: string };

    /**
     * The agent's own slash commands that switch off its asking, widen
     * its folders (Copilot CLI's `/allow-all`, `/add-dir`), or take the
     * chat out of this machine (`/share`, `/remote`). A message starting
     * with one is refused before it is sent. Names without the slash,
     * lower case.
     */
    readonly blockedCommands?: readonly string[];

    /**
     * Why a command in `blockedCommands` is refused, by name, for one the
     * usual words (asking and folders) do not fit. Said after "'/name' was
     * not sent: ".
     */
    readonly blockedReasons?: Readonly<Record<string, string>>;

    /**
     * A permission request's tool call, rewritten before the folder check,
     * for an agent whose request does not say what it asks (Copilot CLI's
     * path request: always `read`, several paths in one string). Given the
     * request's own tool call and what that call's `tool_call` said, when
     * it was seen. Undefined leaves the request as it is.
     */
    permissionToolCall?(
        requested: AcpPermissionToolCall | undefined,
        earlier: AcpPermissionToolCall | undefined
    ): AcpPermissionToolCall | undefined;

    /**
     * Sent as `clientCapabilities._meta` on `initialize` - how a client
     * asks for a vendor's extras (Copilot CLI's event feed). Merged with
     * the other extensions' by top-level key.
     */
    readonly clientMeta?: Readonly<Record<string, unknown>>;

    /**
     * The turn's token counts as the agent reported them in the
     * `session/prompt` answer, rewritten to this turn's alone - for an
     * agent whose figures are something else (Copilot CLI's are a running
     * total for the session, with cache reads already inside `in`).
     */
    turnUsage?(usage: AcpUsage | undefined, turn: AcpExtensionTurn): AcpUsage | undefined;

    /**
     * The session's standing instructions (`AgentSessionConfig.systemInstructions`)
     * and the tools to take away, as the vendor's own `_meta` on
     * `session/new` and `session/load` - Kiro v3's steering,
     * claude-agent-acp's system prompt and blocked tools. Merged with the
     * other extensions' by top-level key.
     *
     * An agent that says it takes ACP's own `systemPrompt` gets the
     * instructions there instead, and this is then called with empty
     * instructions, for the tools alone - see `offersSystemPrompt`.
     *
     * A runtime with neither gets the instructions in front of its first
     * message.
     */
    sessionMeta?(setup: AcpSessionSetup): Record<string, unknown>;

    /**
     * Extra arguments for the runtime's program, for what it only takes
     * when it starts (Copilot CLI's `--excluded-tools`). Added after the
     * declared ones. Empty or undefined adds nothing.
     */
    launchArgs?(setup: AcpSessionSetup): readonly string[] | undefined;

    /**
     * For a runtime that refuses local tool servers at `session/new` and
     * takes them only when it starts, from a file (Copilot CLI: "Rejecting
     * non-http/sse MCP server"). Given the session's local servers,
     * returns the file's text and the arguments that name the file.
     *
     * The provider writes the file, adds the arguments in front of
     * `launchArgs`, leaves those servers out of `session/new`, and
     * removes the file when the program stops. Not called with no local
     * server.
     */
    startMcpServers?(servers: readonly AcpLocalMcpServer[]): { text: string; args(file: string): readonly string[] };

    /**
     * The runtime's own name for the tool behind a permission request or
     * a `tool_call` update, which ACP carries only as a title (Kiro v3)
     * or in the vendor's `_meta` (Claude). Used to refuse a tool the
     * settings turned off, and shown in the log line so it can be copied
     * into that setting. Undefined when it cannot tell - the title is
     * used then.
     */
    toolName?(toolCall: AcpPermissionToolCall | undefined): string | undefined;
}

/** What a session is told and what it may not use - see {@link AcpExtension.sessionMeta}. */
/** A tool server the runtime starts itself, as a program on this machine. */
export type AcpLocalMcpServer = Extract<AcpMcpServer, { type: "stdio" }>;

export interface AcpSessionSetup {

    /** Standing instructions for every turn; empty for none. */
    readonly instructions: string;

    /** The runtime's own tools to take away, by its own names; empty for none. */
    readonly toolsOff: readonly string[];
}

export type AcpExtensionReader = (params: unknown, turn: AcpExtensionTurn) => AgentEvent | undefined;

/** What an extension may do with the session, beyond publishing an event. */
export interface AcpExtensionTurn {

    /**
     * Adds to the bill of the turn in flight. It is reported once, on the
     * "Turn finished" line when the turn ends, beside anything ACP's own
     * `usage_update` charged.
     *
     * @param note A short extra for that line, such as how long the turn
     *             took.
     * @param calls How many model calls this charge is for, when the
     *              agent says (Copilot's feed sends one event per call).
     *              Left out when it does not - nothing is guessed.
     */
    charge(spend: readonly Spend[], note?: string, calls?: number): void;

    /**
     * Keeps a value for the life of this session - what the agent said it
     * offers, a figure worked out once and reused. Per session, never
     * shared: two sessions on the same agent each keep their own. Prefix
     * keys with the vendor (`kiro.`), since a runtime's extensions share
     * the store.
     */
    note(key: string, value: unknown): void;

    /** A value {@link note} kept, or `undefined`. */
    noted(key: string): unknown;
}

/** {@link AcpExtensionTurn}, plus a way to ask the agent something - for {@link AcpExtension.afterTurn}. */
export interface AcpExtensionSession extends AcpExtensionTurn {

    readonly sessionId: string;

    /** Sends one request to the agent and resolves with its result, or rejects with its error. */
    request(method: string, params: unknown): Promise<unknown>;

    /**
     * Runs one turn with this text as the message, the same as a person
     * sending it - its answer is shown and billed like any other turn.
     * For a vendor command that is only reachable as typed text (Copilot
     * CLI's and Claude's `/compact`). Resolves with the turn's answer, so
     * the caller can tell a command that said it failed.
     */
    prompt?(text: string): Promise<string>;
}

/** Every extension this build has, by the id `ai.acpAgents.<id>.extensions` names it with. */
export const ACP_EXTENSIONS: Readonly<Record<string, AcpExtension>> = {
    "kiro-v3": kiroV3Extension,
    "copilot-cli": copilotCliExtension,
    "claude-cli": claudeCliExtension
};

/**
 * The extensions a runtime named, in order. An id this build does not
 * have is logged and skipped rather than failing the session: the
 * runtime still works, only without that vendor's extras.
 */
export function extensionsFor(
    ids: readonly string[],
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): AcpExtension[] {

    const found: AcpExtension[] = [];

    for (const id of ids) {

        const extension = ACP_EXTENSIONS[id];

        if (extension)
            found.push(extension);
        else
            log?.(
                `ACP extension '${id}' is not one this build has (it has: ${Object.keys(ACP_EXTENSIONS).join(", ")}) `
                + "- the agent runs without it.",
                "stderr");
    }

    return found;
}
