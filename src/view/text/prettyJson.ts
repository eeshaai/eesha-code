/** Pretty-prints `raw` when it is JSON; any other text comes back as it is. */
export function prettyJson(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}
