/**
 * A long path made short enough for one table cell, keeping its two ends:
 * the drive or first folder, and the last folder with the file name -
 * `C:\Users\me\AppData\Roaming\npm\copilot.CMD` is
 * `C:\…\npm\copilot.CMD`. The settings page shows the full path on hover.
 * A path no longer than `max` is left as it is.
 *
 * No React here, so it is tested on its own (src/server/__tests__/shortPath.test.ts).
 */
export function shortPath(full: string, max: number = 40): string {

    if (full.length <= max)
        return full;

    const separator = full.includes("\\") ? "\\" : "/";
    const parts = full.split(/[\\/]/);

    if (parts.length < 4)
        return full;

    const first = parts[0] || `${separator}${parts[1]}`;
    const lastTwo = parts.slice(-2).join(separator);
    const short = `${first}${separator}…${separator}${lastTwo}`;

    return short.length <= max ? short : `${first}${separator}…${separator}${parts[parts.length - 1]}`;
}
