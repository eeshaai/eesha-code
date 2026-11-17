import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { WORKFLOWS_DIR } from "../../loader/constants";

/**
 * The directories a session may touch, and the check that holds it
 * there.
 *
 * `cwd` and `additionalDirectories` are not a sandbox. They are the
 * permission scope: a path outside them is not refused, it becomes a
 * permission request. This module answers that request. A path that
 * does not resolve under one of the roots is denied, attended or not,
 * and no workflow file can turn the check off.
 *
 * A tool call that names a file in a structured argument (see
 * {@link PATH_KEYS}) is resolved and checked, at any depth, including
 * an MCP server's own path arguments. Relative names are resolved
 * against the working directory, and a symlink is followed before the
 * comparison, since a link inside a root pointing outside it is an
 * escape. Only the nearest existing ancestor is resolved, so a file
 * about to be created still gets checked.
 *
 * A shell command is not checked here. Scanning the command text for
 * absolute paths would deny `git`, `node` and the rest of the
 * toolchain, which live outside the roots. What is checked is the
 * vendor's own detection: the Claude SDK hands `canUseTool` a
 * `blockedPath`, and Copilot's shell permission request lists
 * `possiblePaths` (see {@link copilotRequestPaths}); each is honoured
 * like any other path. Real
 * containment of a shell is an OS sandbox (`sandbox: { enabled: true }`
 * on the Claude SDK, `sandboxConfig` on Copilot's), not switched on
 * here because on Windows it runs as a separate user and needs
 * installing first.
 *
 * In short: file arguments are confined; a shell command is confined
 * only as far as the vendor detects it.
 */

/**
 * Argument names that carry a filesystem path, in both vendors'
 * spellings.
 *
 * A union rather than a per-tool table: a tool added later, or an MCP
 * server's, would fall through a per-tool table silently. An unknown
 * key here costs a lookup, not a hole.
 *
 * `cwd`, `root` and `directory` are here because a tool that takes a
 * working directory can reach as far as one that takes a file.
 */
export const PATH_KEYS = [
    "cwd",
    "dir",
    "directory",
    "file",
    "fileName",
    "filePath",
    "file_path",
    "files",
    "notebookPath",
    "notebook_path",
    "path",
    "paths",
    "root",
    "target",
    "targets",
    "workingDirectory",
    "working_directory"
];

/**
 * The engine's own directories, which a session may read and may not
 * write - see {@link createJail} for why they exist and why the profile
 * directory itself is not one of them.
 *
 * @param resources Eesha Code's `resources` directory, which only
 *                  the caller knows. Absent when none is given, and
 *                  then only the profile's styles are named.
 */
export function engineDirectories(resources?: string, home: string = os.homedir()): string[] {

    return [
        resources,

        // The one part of the profile directory a phase ever attaches.
        // Its siblings (`settings.json` with MCP env values, `events/`
        // with every past conversation) are deliberately not named.
        path.join(home, WORKFLOWS_DIR, "styles")
    ].filter((one): one is string => typeof one === "string" && one.length > 0);
}

/**
 * The Claude tools that cannot change a file.
 *
 * An allowlist rather than a list of the writing ones, so an unknown
 * tool (a future SDK's, or an MCP server's) is treated as a write and
 * gets the roots only.
 */
const READING_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch"]);

/** Whether a Claude tool call could change a file. */
export function claudeWrites(tool: string | undefined): boolean {

    return !tool || !READING_TOOLS.has(tool);
}

/**
 * The same for Copilot's pre-tool hook, which is handed only a tool
 * name. Its permission handler does not need this: a
 * `PermissionRequest` says `kind: "read"` outright.
 */
const COPILOT_READING_TOOLS = new Set(["view", "read", "glob", "grep", "search", "fetch", "githubRepo"]);

/** Whether a Copilot tool call could change a file. */
export function copilotWrites(tool: string | undefined): boolean {

    return !tool || !COPILOT_READING_TOOLS.has(tool);
}

/**
 * The paths a Copilot permission request names that the argument scan
 * does not see: a shell request's `possiblePaths` (the runtime's own list
 * of paths the command touches - its "vendor detection", like Claude's
 * `blockedPath`), and a read request's `path` split on ", " (Copilot's
 * request for paths outside its own folders joins them all into one
 * string, which read whole starts inside the folders). A path with ", "
 * in its own name is split too; each piece is checked on its own, so the
 * worst case is a refusal, never a pass.
 */
export function copilotRequestPaths(request: unknown): string[] {

    const asked = request as { kind?: unknown; possiblePaths?: unknown; path?: unknown } | undefined;

    // The list is the command's words that look like paths - `log`,
    // `UTF8` and the like resolve inside the working directory and pass.
    // A shell expands the home directory where Node does not, so `~` and
    // the usual spellings of it are expanded first; read whole, they too
    // would resolve inside.
    if (asked?.kind === "shell" && Array.isArray(asked.possiblePaths))
        return asked.possiblePaths
            .filter((one): one is string => typeof one === "string" && one.length > 0)
            .map(one => one.replace(HOME_PREFIX, os.homedir()));

    if (asked?.kind === "read" && typeof asked.path === "string" && asked.path.includes(", "))
        return asked.path.split(", ").map(one => one.trim()).filter(Boolean);

    return [];
}

/** The home directory at the start of a shell word: `~`, `$HOME`, `$env:USERPROFILE`, `%USERPROFILE%`, before a separator or the end. */
const HOME_PREFIX = /^(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i;

/**
 * Whether the paths {@link copilotRequestPaths} found are written: a read
 * request's are not, and a shell request's are not when every command in
 * it is one Copilot marks read-only and nothing is redirected into a file.
 */
export function copilotRequestWrites(request: unknown): boolean {

    const asked = request as { kind?: unknown; commands?: unknown; hasWriteFileRedirection?: unknown } | undefined;

    if (asked?.kind === "read")
        return false;

    const commands = Array.isArray(asked?.commands) ? asked.commands as { readOnly?: unknown }[] : [];

    return !(asked?.kind === "shell"
        && commands.length > 0
        && commands.every(command => command?.readOnly === true)
        && asked.hasWriteFileRedirection !== true);
}

/** A path outside the roots, and the argument that named it. */
export interface Escape {

    /** The path as the tool asked for it. */
    readonly asked: string;

    /** Where it lands, once a relative name is resolved. */
    readonly resolved: string;
}

/** The roots a session may touch, and the questions asked of them. */
export interface PathJail {

    /** The roots, absolute and resolved. Empty means nothing is allowed. */
    readonly roots: readonly string[];

    /**
     * Directories a session may read but never write - the engine's own
     * shipped content. See {@link createJail}.
     */
    readonly readable: readonly string[];

    /**
     * Whether one path may be touched by a call of this kind.
     *
     * @param writes Whether the call could change the file. `true` is
     *               the default and the safe answer: a caller that
     *               cannot tell gets the roots and nothing else.
     */
    allows(candidate: string, writes?: boolean): boolean;

    /**
     * The first path in a tool call that lands outside what it may
     * touch, or `undefined` when the call stays inside.
     *
     * @param input The tool's own arguments.
     * @param blockedPath A path the SDK already flagged as out of scope -
     *                    the only signal there is for a shell command.
     * @param writes Whether the call could change a file - see
     *               {@link PathJail.allows}.
     */
    escape(input: unknown, blockedPath?: string, writes?: boolean): Escape | undefined;

    /** What to tell the agent when it is refused. */
    refusal(escape: Escape): string;
}

/**
 * A jail over the working directory, whatever else the host opened, and
 * a read-only tier for the engine's own shipped files.
 *
 * The working directory is always a root: it is where the task said to
 * run.
 *
 * The read-only tier exists because the engine hands the agent files of
 * its own: an SDD phase attaches the grammar from Eesha Code's
 * `resources/` and style prompts from there or from
 * `~/.eesha/styles/`, none of which are under `cwd`. They are
 * read-only rather than roots because a shipped prompt the agent can
 * rewrite changes every future run on the machine, silently.
 *
 * The profile directory itself is not readable: it holds `settings.json`
 * with env values and tokens, and `events/` with every past run.
 *
 * @param readable Directories the session may read but not write:
 *                 Eesha Code's `resources/` and the profile's
 *                 `styles/`.
 */
export function createJail(
    workingDirectory: string,
    directories?: readonly string[],
    isWindows: boolean = process.platform === "win32",
    readable?: readonly string[]
): PathJail {

    const resolveAll = (all: readonly (string | undefined)[]): string[] =>
        all
            .filter((one): one is string => typeof one === "string" && one.length > 0)
            .map(one => resolveReal(path.resolve(one)));

    const roots = resolveAll([workingDirectory, ...(directories ?? [])]);

    const readOnly = resolveAll(readable ?? []);

    const allows = (candidate: string, writes = true): boolean => {

        const resolved = resolveReal(path.resolve(workingDirectory, candidate));

        if (roots.some(root => under(resolved, root, isWindows)))
            return true;

        // The second tier, only for a call that cannot change the file.
        // `writes` defaults to true so a caller that did not say gets
        // the roots alone.
        return !writes && readOnly.some(root => under(resolved, root, isWindows));
    };

    return {

        roots,

        readable: readOnly,

        allows,

        escape(input: unknown, blockedPath?: string, writes = true): Escape | undefined {

            // The flagged path first: it is the more specific fact, and
            // for a shell command it is the only one there is.
            if (typeof blockedPath === "string" && blockedPath.length && !allows(blockedPath, writes))
                return { asked: blockedPath, resolved: path.resolve(workingDirectory, blockedPath) };

            for (const asked of pathsIn(input))
                if (!allows(asked, writes))
                    return { asked, resolved: path.resolve(workingDirectory, asked) };

            return undefined;
        },

        refusal(escape: Escape): string {

            return `Denied: ${escape.asked} is outside the directories this session may use.`
                + ` It resolves to ${escape.resolved}.`
                + ` Allowed: ${roots.join(", ") || "(none)"}.`
                + (readOnly.length ? ` Readable but not writable: ${readOnly.join(", ")}.` : "")
                + " Work only inside those directories - do not look for another way to reach this path.";
        }
    };
}

/**
 * A jail that refuses nothing, for `debug: true`.
 *
 * The roots are still worked out and reported, so logs and panels show
 * where a session would have been held. Only the answer changes.
 *
 * A second factory rather than a flag inside {@link createJail}, so the
 * boundary has no `if` in the middle of it; the choice is made once at
 * the call site.
 *
 * `debug` is a profile-only setting (`~/.eesha/settings.json`)
 * and the loader errors when a workspace file sets it. That is what
 * makes this safe: the file cannot arrive with a clone, so a repository
 * cannot open its own jail.
 */
export function openJail(
    workingDirectory: string,
    directories?: readonly string[],
    readable?: readonly string[]
): PathJail {

    const closed = createJail(workingDirectory, directories, undefined, readable);

    return {
        roots: closed.roots,
        readable: closed.readable,
        allows: () => true,
        escape: () => undefined,

        // Unreachable while `escape` returns nothing. Written out rather
        // than thrown so a future caller gets a sentence, not a crash.
        refusal: escape => `Denied: ${escape.asked} is outside this session's directories.`
    };
}

/**
 * Every path-shaped argument in a tool call, at any depth.
 *
 * Depth matters: an SDK nests a file under `edits[]`, and an MCP server
 * nests one wherever its schema puts it. A value is taken only when its
 * key says it is a path, never because the string looks like one. That
 * keeps a shell command's `/usr/bin/node` and a grep pattern out.
 */
export function pathsIn(input: unknown, key?: string): string[] {

    if (typeof input === "string")
        return key && PATH_KEYS.includes(key) && input.length ? [input] : [];

    if (Array.isArray(input))
        return input.flatMap(item => pathsIn(item, key));

    if (!input || typeof input !== "object")
        return [];

    return Object.entries(input as Record<string, unknown>)
        .flatMap(([name, value]) => pathsIn(value, name));
}

/**
 * Whether `candidate` is the root itself or something beneath it.
 *
 * The separator matters: a plain `startsWith` puts `C:\repo-backup`
 * inside `C:\repo`. Windows compares without case, because there
 * `C:\Repo` and `c:\repo` are one place.
 */
function under(candidate: string, root: string, isWindows: boolean): boolean {

    const one = isWindows ? candidate.toLowerCase() : candidate;
    const other = isWindows ? root.toLowerCase() : root;

    if (one === other)
        return true;

    return one.startsWith(other.endsWith(path.sep) ? other : other + path.sep);
}

/**
 * An absolute path with its symlinks followed, as far as the filesystem
 * goes.
 *
 * `fs.realpathSync` throws on a path that does not exist yet, and a
 * `Write` names exactly that. So the nearest existing ancestor is
 * resolved and the rest is put back on, so a file about to be created
 * is still checked against where it would land.
 *
 * Never throws. A path that cannot be resolved at all is returned as it
 * came, leaving the decision to the comparison.
 */
function resolveReal(absolute: string): string {

    const tail: string[] = [];

    let head = absolute;

    for (;;) {

        try {
            return path.resolve(fs.realpathSync(head), ...[...tail].reverse());
        } catch {

            const parent = path.dirname(head);

            // The drive root, and nothing on the way down existed.
            if (parent === head)
                return absolute;

            tail.push(path.basename(head));

            head = parent;
        }
    }
}
