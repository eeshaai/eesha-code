import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { DB_SUBDIR } from "../loader/constants";
import { profileDirectory } from "../loader/profilePaths";

/** What the database file is called inside its workspace's folder. */
const DATABASE_FILE = "run.db";

/** Stands in for the workspace when no folder is open. */
const NO_WORKSPACE = "no-workspace";

/**
 * Where a workspace's run database lives:
 * `~/.eesha/db/<workspace>/run.db`.
 *
 * Run history is private and machine-local, so it is filed per
 * workspace in the profile, not in the repository, where a person can
 * find and back it up. Renaming or moving a workspace starts fresh history; the
 * alternative is a marker file in every repository.
 *
 * @param workspacePath the open workspace's absolute path; when nothing
 * is open, runs are filed under a shared `no-workspace` folder so the
 * panel still works.
 */
export function resolveDatabasePath(workspacePath: string | undefined): string {

    const folder = path.join(profileDirectory(), DB_SUBDIR, workspaceFolderName(workspacePath));

    fs.mkdirSync(folder, { recursive: true });

    return path.join(folder, DATABASE_FILE);
}

/**
 * A filesystem-safe folder name for a workspace path: a readable slug
 * plus a short hash.
 *
 * Both parts are needed. The slug lets a person recognise the folder.
 * The hash keeps it unique: slugging is lossy, so `C:\work\a-b` and
 * `C:\work\a\b` flatten to the same text, and two repositories must
 * never share one run history.
 *
 * Case is folded only where the filesystem folds it. Drive letters
 * can come in either case on Windows, so `c:\work` and `C:\work`
 * must agree there; on Linux they are two different directories.
 */
export function workspaceFolderName(workspacePath: string | undefined): string {

    if (!workspacePath)
        return NO_WORKSPACE;

    const resolved = path.resolve(workspacePath);

    const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;

    const slug = resolved
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);

    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 8);

    // A path of only separators slugs to empty; the digest still names it.
    return slug ? `${slug}-${digest}` : digest;
}
