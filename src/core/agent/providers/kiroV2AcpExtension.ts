import type { ContextUsage } from "../../models/run";
import type { AgentEvent } from "../AgentSession";
import type { AcpExtension, AcpExtensionSession, AcpExtensionTurn } from "./acpExtensions";
import {
    accountNotice, contextNotice, estimateContext, kiroAccount, kiroCharges, kiroDuration, kiroParts, shareNotice
} from "./kiroShared";

/**
 * Kiro CLI's v2 engine (`kiro-cli acp`) - the `kiro-v2` extension.
 *
 * Observed on kiro-cli 2.24.0. None of it is in Kiro's public ACP docs.
 *
 * Kiro sends no `usage_update`. What it spends and how full its context
 * window is arrive on `_kiro.dev/metadata` instead:
 *
 *   - Sent several times a turn: right after `session/new`, around tool
 *     calls, and twice at the end of the turn - all before the
 *     `session/prompt` response.
 *   - Every one carries `contextUsagePercentage` (0-100). No token counts.
 *   - The last one of a turn also carries `meteringUsage` - a list of
 *     `{ value, unit, unitPlural }` (unit `credit`) - and
 *     `turnDurationMs`. It is what that turn charged, not a running
 *     total: three turns in a row were billed 0.062, 0.035 and 0.083.
 *   - A turn that runs no model (a slash command such as `/tools`)
 *     sends no metadata at all, so it costs no line.
 *
 * After each turn, two of Kiro's slash commands run over
 * `_kiro.dev/commands/execute` - neither is a model call, so neither
 * costs credits - each only when Kiro's own command list
 * (`_kiro.dev/commands/available`, sent at the start of each session)
 * names it:
 *
 *   - `/context show`: what fills the window, and so its size - see
 *     {@link kiroContext}. The size is kept, so the metadata's share can
 *     be drawn against it for the rest of the session.
 *   - `/usage`: the account's usage this billing period.
 *
 * Kiro's other messages (`_kiro.dev/subagent/list_update`,
 * `_kiro.dev/session/update`) carry nothing the log or the usage card
 * shows, so they are not read.
 */
export const KIRO_METADATA = "_kiro.dev/metadata";

export const KIRO_COMMANDS = "_kiro.dev/commands/available";

export const KIRO_EXECUTE = "_kiro.dev/commands/execute";

/** Session notes this file keeps - see `AcpExtensionTurn.note`. */
const OFFERS_CONTEXT = "kiro.offersContext";
const OFFERS_USAGE = "kiro.offersUsage";

export const kiroV2Extension: AcpExtension = {

    vendor: "Kiro (v2 engine)",

    notifications: {

        [KIRO_METADATA]: (params, turn) => readKiroMetadata(params, turn),

        [KIRO_COMMANDS]: (params, turn) => {

            turn.note(OFFERS_CONTEXT, offersCommand(params, "/context"));
            turn.note(OFFERS_USAGE, offersCommand(params, "/usage"));

            return undefined;
        }
    },

    // Both at once, each on its own: one failing or not offered costs
    // only its own event.
    afterTurn: async session => {

        const events = await Promise.all([
            askKiroContext(session).catch(() => undefined),
            askKiroUsage(session).catch(() => undefined)
        ]);

        return events.filter((event): event is AgentEvent => event !== undefined);
    },

    // Kiro only lists its commands once the first prompt is sent, so at
    // the start there is no knowing whether `/usage` is offered - it is
    // simply tried. A failure costs nothing: the first turn's end asks
    // again, the ordinary way.
    atStart: async session => {

        const event = await askKiroUsage(session, true).catch(() => undefined);

        return event ? [event] : [];
    }
};

/** Whether Kiro's command list names this slash command. Exported for tests. */
export function offersCommand(params: unknown, name: string): boolean {

    const commands = (params as { commands?: unknown } | undefined)?.commands;

    return Array.isArray(commands)
        && commands.some(command => (command as { name?: unknown } | null)?.name === name);
}

/**
 * Runs `/context show` and turns the answer into a context notice, when
 * Kiro offered the command. Keeps the window size it works out.
 *
 * Exported for tests.
 */
export async function askKiroContext(session: AcpExtensionSession): Promise<AgentEvent | undefined> {

    if (session.noted(OFFERS_CONTEXT) !== true)
        return undefined;

    const result = await session.request(KIRO_EXECUTE, {
        sessionId: session.sessionId,
        command: { command: "context", args: { subcommand: "show" } }
    });

    const context = kiroContext(result);

    return context ? contextNotice(KIRO_EXECUTE, result, context, session) : undefined;
}

/**
 * `/context show`'s answer as a {@link ContextUsage}, or nothing when it
 * failed or has a shape this does not know. The breakdown and Kiro's own
 * `contextUsagePercentage` are under `data` - see `estimateContext` for
 * how the size is worked out from them.
 *
 * Exported for tests.
 */
export function kiroContext(result: unknown): ContextUsage | undefined {

    const { success, data } = (result ?? {}) as { success?: unknown; data?: unknown };

    if (success === false || !data || typeof data !== "object")
        return undefined;

    const { contextUsagePercentage, breakdown } = data as { contextUsagePercentage?: unknown; breakdown?: unknown };

    return estimateContext(kiroParts(breakdown), contextUsagePercentage);
}

/**
 * Runs `/usage` and turns the answer into an account notice, when Kiro
 * offered the command.
 *
 * Asked after every turn although it is account-wide: other sessions and
 * other people on the same plan move it too.
 *
 * @param untold Ask even though Kiro has not said it offers `/usage` -
 *               at the start of a session, before its command list.
 *
 * Exported for tests.
 */
export async function askKiroUsage(session: AcpExtensionSession, untold = false): Promise<AgentEvent | undefined> {

    if (!untold && session.noted(OFFERS_USAGE) !== true)
        return undefined;

    const result = await session.request(KIRO_EXECUTE, {
        sessionId: session.sessionId,
        command: { command: "usage", args: {} }
    });

    const account = kiroAccount(result);

    return account ? accountNotice(KIRO_EXECUTE, result, account) : undefined;
}

/** `_kiro.dev/metadata`'s params, every field optional - it is an unstable vendor message. */
interface KiroMetadata {

    sessionId?: unknown;

    contextUsagePercentage?: unknown;

    meteringUsage?: unknown;

    turnDurationMs?: unknown;
}

/**
 * The charge goes on the turn's bill. The context share comes back as a
 * notice that replaces the last one, the same way `usage_update` does.
 *
 * Exported for tests.
 */
export function readKiroMetadata(params: unknown, turn: AcpExtensionTurn): AgentEvent | undefined {

    if (!params || typeof params !== "object")
        return undefined;

    const metadata = params as KiroMetadata;

    const charges = kiroCharges(metadata.meteringUsage);

    if (charges.length)
        turn.charge(charges, kiroDuration(metadata.turnDurationMs));

    const percent = metadata.contextUsagePercentage;

    if (typeof percent !== "number" || !Number.isFinite(percent))
        return undefined;

    return shareNotice(KIRO_METADATA, params, percent, turn);
}
