/*
 * The words the start page shows for times and counts. No React here, so
 * it is tested on its own (startText.test.ts).
 */

/** The heading over the waiting sessions: `1 SESSION IS WAITING FOR YOU`, `3 SESSIONS ARE WAITING FOR YOU`. */
export function waitingHeading(count: number): string {

    return count === 1 ? "1 SESSION IS WAITING FOR YOU" : `${count} SESSIONS ARE WAITING FOR YOU`;
}

/**
 * How long ago, short, for the start page's rows: `now`, `40m`, `2h`,
 * `3d`. A month or more ago it is the date instead, such as `12 Oct`.
 */
export function startAgo(at: number, now: number): string {

    const minutes = Math.floor((now - at) / 60_000);

    if (minutes < 1)
        return "now";

    if (minutes < 60)
        return `${minutes}m`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24)
        return `${hours}h`;

    const days = Math.floor(hours / 24);

    if (days < 30)
        return `${days}d`;

    return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The same time for the Resume card: `just now`, `2m ago`, `3d ago`, or the date (`12 Oct`). */
export function startAgoText(at: number, now: number): string {

    const short = startAgo(at, now);

    if (short === "now")
        return "just now";

    return /^\d+[mhd]$/.test(short) ? `${short} ago` : short;
}

/** `no sessions yet`, `1 session`, `4 sessions`. */
export function sessionsText(count: number): string {

    return count === 0 ? "no sessions yet" : count === 1 ? "1 session" : `${count} sessions`;
}
