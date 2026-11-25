import type { EngineSettings } from "../core/settings/engineSettings";
import type { AiPick } from "../sdd/config/sddConfig";

/*
 * The chat's rules that need no page to check - kept apart
 * from the controller so a test can hold them without a running server.
 */

/**
 * What a chat runs on: its own pick while the org still lists that
 * runtime, else `start` - by default the first runtime `ai.providers`
 * lists (see {@link startRuntime} for the one a chat really starts on).
 * With no list and no `start` there is nothing to start on first, and
 * the settings decide - the same default a phase gets.
 *
 * A stale pick (a runtime taken off the list since) is dropped rather
 * than refused: the chat carries on on the start runtime, and the hand
 * over says so in the thread.
 */
export function chatPick(own: AiPick | undefined, providers: readonly string[] | undefined, start: string | undefined = providers?.[0]): AiPick | undefined {

    if (own && (!providers || providers.includes(own.provider)))
        return own;

    return start ? { provider: start } : undefined;
}

/** The default runtime settings.json names - `ai."ai@1".provider`. Nothing when it names none. */
export function defaultRuntimeOf(settings: Pick<EngineSettings, "ai">): string | undefined {

    const provider = settings.ai.defaults["ai@1"]?.provider;

    return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

/**
 * The runtime a chat with no pick of its own starts on: the default
 * runtime when it is on offer, else the first one on offer. Nothing when
 * there is no list of runtimes on offer - the settings decide then.
 */
export function startRuntime(offered: readonly string[] | undefined, defaultRuntime: string | undefined): string | undefined {

    if (!offered?.length)
        return undefined;

    return defaultRuntime && offered.includes(defaultRuntime) ? defaultRuntime : offered[0];
}

/** A new chat's id: when it started, then a few random characters so two in one second differ. */
export function newChatId(now: number, random: () => number = Math.random): string {

    const when = new Date(now);
    const pad = (value: number) => String(value).padStart(2, "0");

    const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
        + `T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;

    const tail = Array.from({ length: 6 }, () => Math.floor(random() * 36).toString(36)).join("");

    return `${stamp}-${tail}`;
}
