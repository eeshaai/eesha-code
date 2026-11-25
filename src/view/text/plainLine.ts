/**
 * One line of Markdown as plain text, for a one-line preview: models write
 * a bold heading first ("**Checking the file**"), and the stars would show
 * as they are. Takes off heading marks, list and quote marks at the start,
 * and bold, italic and code marks around words.
 */
export function plainLine(line: string): string {
    return line
        .trim()
        .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+)/, '')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

/**
 * The preview on a thinking block's closed line: the newest line while the
 * thinking is still being written, the first line once it is finished,
 * both as plain text.
 */
export function thinkingSummary(text: string, live: boolean): string {
    const lines = text.split('\n').filter((line) => line.trim());
    return plainLine((live ? lines[lines.length - 1] : lines[0]) ?? '');
}
