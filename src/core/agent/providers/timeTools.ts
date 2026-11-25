/**
 * Two clock tools, so an agent never has to start a shell to learn the
 * date.
 *
 * Nothing the engine ships asks for the time, but a model writing a
 * document wants a date on it, and left to itself it runs `Get-Date`
 * or `date` - a process start and a permission round-trip for a value
 * this process already has. These answer from Node instead, in no
 * time and with nothing to approve.
 *
 * Both take no input. `time_now` is the machine's own clock and zone,
 * what a person here would write; `utc_now` is the same instant in
 * UTC, what a log or a `spec.json` stamp should carry. Two tools
 * rather than one with a flag: a model reaches for a name, and
 * `utc_now` is the name it reaches for.
 *
 * Registered the same way `ask_user` is on each provider - see
 * `askTool` for the two routes. Never deferred behind tool search, and
 * never behind a permission prompt: a clock has nothing to approve.
 */

export const TIME_NOW_TOOL_NAME = "time_now";

export const UTC_NOW_TOOL_NAME = "utc_now";

export const TIME_NOW_DESCRIPTION =
    "The current local date and time on this machine, with its time zone and UTC offset.\n\n"
    + "Use this whenever you need today's date or the time now - do not run a shell command "
    + "such as Get-Date or date for it. For a timestamp in UTC, use utc_now instead.";

export const UTC_NOW_DESCRIPTION =
    "The current date and time in UTC, as an ISO 8601 string ending in Z.\n\n"
    + "Use this for timestamps in files, logs and records - do not run a shell command such "
    + "as Get-Date or date for it. For the local wall-clock time, use time_now instead.";

/** No input either way. The empty shape, in the two forms the two SDKs want. */
export const timeToolShape = {};

export const timeToolJsonSchema: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: false
};

/**
 * The local time, spelled out so the model has nothing to compute:
 * the ISO form with its offset, the zone by name, and the weekday.
 *
 * @param now The clock, replaceable for a test.
 */
export function timeNow(now: () => Date = () => new Date()): string {

    const date = now();
    const zone = zoneName();
    const weekday = date.toLocaleDateString("en-US", { weekday: "long" });

    return `${localIso(date)} (${zone}, ${weekday})`;
}

/** The same instant in UTC, ISO 8601 with a `Z`. */
export function utcNow(now: () => Date = () => new Date()): string {

    return now().toISOString();
}

/** The IANA zone this process runs in, or `local` when the runtime cannot say. */
function zoneName(): string {

    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    }
    catch {
        return "local";
    }
}

/**
 * `Date` has no local ISO form - `toISOString` is always UTC - so this
 * builds one: `2026-09-11T14:32:05+05:30`. The offset is the zone's at
 * that instant, so daylight saving is already in it.
 */
function localIso(date: Date): string {

    const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");

    // getTimezoneOffset is minutes *behind* UTC, so +05:30 comes back as -330.
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? "-" : "+";

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        + `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
