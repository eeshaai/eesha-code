import * as fs from "fs";

/**
 * Whether a path holds real content - the existence check every
 * document gate uses.
 *
 * A zero-byte or whitespace-only file passes `existsSync` but gives the
 * next phase nothing to work from, so "exists" here means "exists and
 * says something". A directory counts by presence alone.
 *
 * Only small files are read for the whitespace check: past a few KB
 * the file has content, and discovery asks this once per artifact per
 * refresh.
 */
export function hasContent(absolute: string): boolean {

    try {

        const stat = fs.statSync(absolute);

        if (stat.isDirectory())
            return true;

        if (stat.size === 0)
            return false;

        if (stat.size > 4096)
            return true;

        return fs.readFileSync(absolute, "utf8").trim().length > 0;

    } catch {

        return false;
    }
}
