import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { profileDirectory } from "../../loader/profilePaths";

/*
 * Places outside a chat's folders that are never offered and always
 * refused with no card, at every level: this app's own
 * profile folder, the agents' own settings folders, secret stores, a
 * drive root and the home folder itself.
 */

/**
 * Folders and files under the home folder, as the refusal names them.
 * This app's own profile folder is not listed: it is wherever the app
 * keeps it - see profileDirectory.
 */
const UNDER_HOME = [
    ".claude",
    ".claude.json",
    ".copilot",
    ".kiro",
    ".codex",
    ".gemini",
    ".ssh",
    ".aws",
    ".azure",
    ".gnupg",
    ".kube",
    ".docker",
    ".config/gh",
    ".npmrc",
    ".git-credentials",
    ".netrc",
    ".pypirc"
];

/**
 * Why a path outside the chat's folders is never allowed, as the row
 * says it ("~/.ssh is never allowed, in any mode"), or nothing when it may
 * be asked about.
 */
export function protectedReason(
    absolute: string,
    home: string = os.homedir(),
    isWindows: boolean = process.platform === "win32"
): string | undefined {

    const resolved = path.resolve(absolute);

    const same = (one: string, other: string): boolean =>
        isWindows ? one.toLowerCase() === other.toLowerCase() : one === other;

    const under = (candidate: string, root: string): boolean => {

        const one = isWindows ? candidate.toLowerCase() : candidate;
        const other = isWindows ? root.toLowerCase() : root;

        return one === other || one.startsWith(other.endsWith(path.sep) ? other : other + path.sep);
    };

    if (same(trimSeparator(resolved), trimSeparator(path.parse(resolved).root)))
        return `the drive root ${resolved}`;

    if (same(trimSeparator(resolved), trimSeparator(home)))
        return "your home folder";

    const own = profileDirectory();

    if (under(resolved, own)) {

        const relative = path.relative(home, own);

        return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
            ? `~/${relative.split(path.sep).join("/")}`
            : own;
    }

    for (const name of UNDER_HOME)
        if (under(resolved, path.join(home, name)))
            return `~/${name}`;

    return undefined;
}

function trimSeparator(one: string): string {

    return one.length > 1 && /[\\/]$/.test(one) && !/^[A-Za-z]:[\\/]$/.test(one) && one !== "/"
        ? one.slice(0, -1)
        : one;
}

/**
 * The folders the outside-folder card offers to add for one path: the
 * path's git root (suggested), then the file's own
 * folder. A folder that is protected, a drive root or the home folder
 * is never offered. Empty when nothing can be.
 */
export function folderChoices(
    absolute: string,
    home: string = os.homedir(),
    isWindows: boolean = process.platform === "win32"
): { path: string; hint: string }[] {

    const resolved = path.resolve(absolute);

    let own = path.dirname(resolved);

    try {

        if (fs.statSync(resolved).isDirectory())
            own = resolved;

    } catch {

        // Not there yet - a file about to be written. Its folder it is.
    }

    const choices: { path: string; hint: string }[] = [];

    const root = gitRoot(own);

    const offerable = (folder: string): boolean => protectedReason(folder, home, isWindows) === undefined;

    if (root && offerable(root))
        choices.push({ path: root, hint: "git root · suggested" });

    const same = (one: string, other: string): boolean =>
        isWindows ? one.toLowerCase() === other.toLowerCase() : one === other;

    if (offerable(own) && !choices.some(choice => same(choice.path, own)))
        choices.push({ path: own, hint: own === resolved ? "this folder" : "this file's folder" });

    return choices;
}

/** The nearest folder at or above `from` with a `.git` in it. */
function gitRoot(from: string): string | undefined {

    let at = from;

    for (;;) {

        if (fs.existsSync(path.join(at, ".git")))
            return at;

        const parent = path.dirname(at);

        if (parent === at)
            return undefined;

        at = parent;
    }
}
