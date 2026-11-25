import { promises as fs } from "fs";
import * as path from "path";

import type { AccountUsage } from "../models/run";
import { profilePath } from "../loader/profilePaths";

/**
 * The last account usage each runtime reported, kept in
 * `~/.eesha/usage.json` - so a new session shows the account
 * straight away, as of when it was last fetched, instead of nothing until
 * its runtime answers.
 *
 * In the profile folder, not the workspace: an account belongs to the
 * person, not to a repository, and nothing here should reach git.
 *
 * Never throws. A file that cannot be read is no copy; one that cannot be
 * written is a copy not kept. Neither is worth failing a session over.
 */
export const ACCOUNT_CACHE_FILE = "usage.json";

interface CacheFile {

    accounts?: Record<string, AccountUsage>;
}

/**
 * Keeps a runtime's account usage, replacing the one it had. An older
 * answer than the one kept is ignored, so two sessions finishing out of
 * order never put the older figures back.
 *
 * @param file For tests - the real one is in the profile folder.
 */
export async function rememberAccount(
    runtime: string,
    account: AccountUsage,
    file: string = profilePath(ACCOUNT_CACHE_FILE)
): Promise<void> {

    try {

        const cache = await read(file);

        const kept = cache.accounts?.[runtime];

        if (kept && kept.at > account.at)
            return;

        cache.accounts = { ...cache.accounts, [runtime]: { ...account, runtime } };

        await fs.mkdir(path.dirname(file), { recursive: true });

        // Written beside and then moved into place, so a reader never
        // sees half a file.
        const partial = `${file}.${process.pid}.tmp`;

        await fs.writeFile(partial, JSON.stringify(cache, null, 2), "utf8");
        await fs.rename(partial, file);

    } catch {

        // Not kept - the next answer tries again.
    }
}

/** The account usage kept for a runtime, or nothing. */
export async function lastAccount(
    runtime: string,
    file: string = profilePath(ACCOUNT_CACHE_FILE)
): Promise<AccountUsage | undefined> {

    try {

        const account = (await read(file)).accounts?.[runtime];

        return account && typeof account.at === "number" && Array.isArray(account.rows) ? account : undefined;

    } catch {

        return undefined;
    }
}

async function read(file: string): Promise<CacheFile> {

    try {

        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;

        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CacheFile : {};

    } catch {

        return {};
    }
}
