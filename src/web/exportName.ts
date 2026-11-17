/*
 * The file name Export gives a chat. No React and no browser here, so
 * it is tested on its own (src/server/__tests__/exportName.test.ts).
 */

/** Longest name before `.md`. */
const NAME_LIMIT = 80;

/**
 * `<chat name>.md`, with the characters Windows refuses in a file name
 * swapped for `-`, and `chat.md` when nothing is left.
 */
export function exportName(title: string): string {

    const name = title
        .replace(/\s+/g, " ")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .trim()
        .replace(/[. ]+$/, "")
        .slice(0, NAME_LIMIT)
        .trim();

    return `${name || "session"}.md`;
}
