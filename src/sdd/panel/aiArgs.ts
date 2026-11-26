import { DEFAULT_PROVIDER } from "../config/sddConfig";

/* What a phase's resolved `ai:` args say: the runtime and the model. */

/**
 * Which runtime a phase runs on, off the phase's resolved `ai:` args.
 *
 * Recorded beside a session id so the id is only ever offered back to
 * the runtime that issued it. The plugin's own default when nothing
 * names one, rather than "unknown": since a style.yml edit can switch
 * the runtime and switch it back, a record that matched whatever asked
 * for it would hand Copilot a Kiro id the moment it was switched back.
 * A record with no provider on it still matches anything - see
 * `sessionToContinue`.
 */
export function providerOf(args: Record<string, unknown>): string {

    return typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : DEFAULT_PROVIDER;
}

/** The model a phase's resolved `ai:` args name, or nothing when it is left to the runtime. */
export function modelOf(args: Record<string, unknown>): string | undefined {

    return typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
}
