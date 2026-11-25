import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import { parse } from "yaml";

import { AgentAttachment, SteeringEntry } from "../AgentSession";

/**
 * Steering files: `.md` files anywhere in the chat's root folders whose
 * header (the `---` block at the top) says when a chat should get them.
 * The header format is Kiro's (`inclusion:`), so the team's existing
 * steering files work unchanged.
 *
 * What differs from Kiro, on purpose:
 *
 *   - A file is steering only if its header has `inclusion:`. No
 *     header, or a header without it, and the file is not used - even
 *     with `tags:`, which blog posts and docs pages carry too. Kiro
 *     treats a file with no header as `always`, which puts it into
 *     every chat.
 *   - Any folder, not only `.kiro/steering/`.
 *   - Only the header is read here. The body goes to the agent as an
 *     attachment, never pasted by the engine.
 *
 * `always` files are attached to a new chat's first message. `fileMatch`
 * files are attached when a file the chat is known to work on matches -
 * today only an SDD implement wave's `Files:` lines. Files with `tags:`
 * are offered through the `steering` tool (see `providers/steeringTool`).
 * `manual` files are attached to one message when the person types
 * `@name` for them in the compose box.
 */

/** What a steering header may say. */
export interface SteeringHeader {

    inclusion: string;

    tags?: string[];

    /** `fileMatch` only: one pattern or several, as written. */
    fileMatchPattern?: string[];
}

/** One steering file found in a root. */
export interface SteeringFile {

    /** Absolute. */
    path: string;

    /** Relative to the root it was found in, with forward slashes. */
    relative: string;

    header: SteeringHeader;
}

/** The inclusion values Kiro defines. Anything else is reported. */
const INCLUSIONS = new Set(["always", "fileMatch", "manual", "auto"]);

/**
 * How much of a file is read to find its header. A header is a few
 * lines; a file whose header does not close within this is treated as
 * having none.
 */
const HEADER_BYTES = 8 * 1024;

/** Folders never looked in, git or not. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

const run = promisify(execFile);

/**
 * The header of a file's text, or `undefined` when the file has no
 * steering header.
 *
 * Throws when the header has `inclusion:` but cannot be used, so the
 * caller can tell the team why the file was skipped.
 */
export function parseSteeringHeader(text: string): SteeringHeader | undefined {

    // A byte order mark some editors write is not part of the header.
    const start = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

    // The header must open on the very first line.
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(start);

    if (!match)
        return undefined;

    const raw = match[1];

    // Most `.md` headers (docs pages, blog posts) are not steering.
    // Only one naming `inclusion:` is worth reading or complaining about.
    if (!/^\s*inclusion\s*:/m.test(raw))
        return undefined;

    let value: unknown;

    try {

        value = parse(raw);

    } catch (error) {

        throw new Error(`the header is not valid YAML (${error instanceof Error ? error.message : String(error)})`);
    }

    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("the header is not a list of keys");

    const { inclusion, tags, fileMatchPattern } = value as Record<string, unknown>;

    if (typeof inclusion !== "string" || !INCLUSIONS.has(inclusion))
        throw new Error(`'inclusion: ${String(inclusion ?? "")}' is not one of: ${[...INCLUSIONS].join(", ")}`);

    const header: SteeringHeader = { inclusion };

    if (tags !== undefined && tags !== null)
        header.tags = words(tags, "'tags' must be one word or a list of words");

    if (inclusion === "fileMatch") {

        if (fileMatchPattern === undefined || fileMatchPattern === null)
            throw new Error("'inclusion: fileMatch' needs 'fileMatchPattern', such as \"src/api/**\"");

        header.fileMatchPattern = words(fileMatchPattern, "'fileMatchPattern' must be one pattern or a list of patterns");
    }

    return header;
}

/** One string or a list of them, trimmed, none empty - or the error. */
function words(value: unknown, problem: string): string[] {

    const list = typeof value === "string" ? [value] : value;

    if (!Array.isArray(list) || !list.length || list.some(one => typeof one !== "string" || !one.trim()))
        throw new Error(problem);

    return list.map(one => (one as string).trim());
}

/**
 * Whether a path matches a `fileMatchPattern`, both relative to the
 * repository, either slash.
 *
 * `**` is any number of folders, `*` any part of one name, `?` one
 * character, `{a,b}` either. A pattern with no `/` in it is matched
 * against the file's name alone, at any depth: `*.tsx` matches
 * `src/ui/Button.tsx`. Case is ignored.
 */
export function matchesPattern(pattern: string, file: string): boolean {

    const tidy = (one: string) => one.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

    const wanted = tidy(pattern);
    const target = tidy(file);

    const subject = wanted.includes("/") ? target : target.slice(target.lastIndexOf("/") + 1);

    return globRegExp(wanted).test(subject);
}

/** A glob as an anchored, case-blind regular expression. */
function globRegExp(glob: string): RegExp {

    let out = "";

    for (let at = 0; at < glob.length; at++) {

        const char = glob[at];

        if (char === "*" && glob[at + 1] === "*") {

            // `**/` is zero or more whole folders; a trailing or bare
            // `**` is anything at all.
            if (glob[at + 2] === "/") {

                out += "(?:.*/)?";
                at += 2;

            } else {

                out += ".*";
                at += 1;
            }

        } else if (char === "*")
            out += "[^/]*";
        else if (char === "?")
            out += "[^/]";
        else if (char === "{") {

            const close = glob.indexOf("}", at);

            if (close < 0) {

                out += "\\{";
                continue;
            }

            out += `(?:${glob.slice(at + 1, close).split(",").map(part => globRegExp(part).source.slice(1, -1)).join("|")})`;
            at = close;

        } else
            out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }

    return new RegExp(`^${out}$`, "i");
}

/** A header read earlier, kept until the file changes. */
interface Cached {

    mtimeMs: number;

    size: number;

    /** `undefined` for a file with no steering header. */
    header?: SteeringHeader;

    /** Why a file that looked like steering could not be used. */
    problem?: string;
}

/**
 * Headers by absolute path. The list of `.md` files is taken fresh each
 * time; a header is read again only when its file's time or size has
 * changed, so starting a chat does not re-open every file.
 */
const cache = new Map<string, Cached>();

/**
 * Every steering file in the given root folders, and the files skipped
 * for a bad header.
 *
 * Never throws: a root that cannot be listed or a file that cannot be
 * read is left out rather than failing the chat.
 */
export async function findSteering(roots: readonly string[]): Promise<{
    files: SteeringFile[];
    skipped: { relative: string; problem: string }[];
}> {

    const files: SteeringFile[] = [];
    const skipped: { relative: string; problem: string }[] = [];

    // A root can repeat, or sit inside another (the working folder
    // inside a workspace folder). A file is counted once, under the
    // first root that lists it.
    const seen = new Set<string>();

    for (const root of [...new Set(roots.map(one => path.resolve(one)))]) {

        for (const relative of await listMarkdown(root)) {

            const absolute = path.join(root, relative);
            const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;

            if (seen.has(key))
                continue;

            seen.add(key);

            const read = readHeader(absolute);

            const shown = relative.split(path.sep).join("/");

            if (read?.problem)
                skipped.push({ relative: shown, problem: read.problem });
            else if (read?.header)
                files.push({ path: absolute, relative: shown, header: read.header });
        }
    }

    return { files, skipped };
}

/**
 * The `always` steering files as attachments for a chat's first
 * message, sorted by path so the order is the same every time.
 */
export function alwaysAttachments(files: readonly SteeringFile[]): AgentAttachment[] {

    return files
        .filter(file => file.header.inclusion === "always")
        .sort((a, b) => a.relative.localeCompare(b.relative))
        .map(file => ({ path: file.path, name: `steering: ${file.relative}` }));
}

/**
 * The `fileMatch` steering files whose pattern matches any of the files
 * the chat is known to work on, as attachments, sorted by path. No
 * known files, no matches: a file the agent only happens to open later
 * never pulls one in.
 *
 * @param known Paths relative to the working folder, as a plan's
 *              `Files:` line writes them.
 */
export function fileMatchAttachments(files: readonly SteeringFile[], known: readonly string[]): AgentAttachment[] {

    return files
        .filter(file => file.header.inclusion === "fileMatch"
            && file.header.fileMatchPattern!.some(pattern => known.some(one => matchesPattern(pattern, one))))
        .sort((a, b) => a.relative.localeCompare(b.relative))
        .map(file => ({ path: file.path, name: `steering: ${file.relative}` }));
}

/**
 * The `@name` words in a message a person typed, and the `manual`
 * steering files they name, as attachments for that message only.
 *
 * A name is the file's name without `.md`, case ignored: `@api-rules`
 * is `api-rules.md` in any folder. Two files with one name are both
 * attached. An `@word` that names no `manual` file is returned in
 * `unknown`, so the caller can say so; the message still goes as typed.
 *
 * `#` opens the compose box's tools and MCP servers menu, so `#name`
 * is plain text.
 */
export async function mentionedSteering(text: string, roots: readonly string[]): Promise<{
    attachments: AgentAttachment[];
    unknown: string[];
}> {

    // After a space or at the start, so `me@site.com` and `a@b` are not
    // names; a letter first, so `@12` is not one either.
    const names = [...new Set([...text.matchAll(/(?:^|[\s(])@([A-Za-z][\w.-]*)/g)]
        .map(match => match[1].replace(/[.-]+$/, "")))];

    if (!names.length)
        return { attachments: [], unknown: [] };

    const manual = (await findSteering(roots)).files.filter(file => file.header.inclusion === "manual");

    const nameOf = (file: SteeringFile) => path.basename(file.path).replace(/\.md$/i, "").toLowerCase();

    const attachments: AgentAttachment[] = [];
    const unknown: string[] = [];

    for (const name of names) {

        const found = manual.filter(file => nameOf(file) === name.toLowerCase());

        if (!found.length)
            unknown.push(name);

        for (const file of found)
            if (!attachments.some(one => one.path === file.path))
                attachments.push({ path: file.path, name: `steering: ${file.relative}` });
    }

    return { attachments, unknown };
}

/** The log line for `@names` that matched no `manual` steering file, or `undefined`. */
export function unknownMentions(unknown: readonly string[]): string | undefined {

    return unknown.length
        ? `No manual steering file named ${unknown.map(name => `@${name}`).join(", ")}. The message was sent as typed.`
        : undefined;
}

/**
 * The tagged steering files the `steering` tool offers, sorted by path.
 * An `always` file is left out even when it has tags: it is attached
 * already.
 */
export function taggedEntries(files: readonly SteeringFile[]): SteeringEntry[] {

    return files
        .filter(file => file.header.tags?.length && file.header.inclusion !== "always")
        .sort((a, b) => a.relative.localeCompare(b.relative))
        .map(file => ({ path: file.path, relative: file.relative, tags: file.header.tags! }));
}

/** A file's header, from the cache when the file has not changed. */
function readHeader(file: string): Cached | undefined {

    let stat: fs.Stats;

    try {

        stat = fs.statSync(file);

    } catch {

        cache.delete(file);

        return undefined;
    }

    const known = cache.get(file);

    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size)
        return known;

    let text: string;

    try {

        const handle = fs.openSync(file, "r");

        try {

            const buffer = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
            const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);

            text = buffer.subarray(0, bytes).toString("utf8");

        } finally {

            fs.closeSync(handle);
        }

    } catch {

        return undefined;
    }

    let entry: Cached;

    try {

        entry = { mtimeMs: stat.mtimeMs, size: stat.size, header: parseSteeringHeader(text) };

    } catch (error) {

        entry = { mtimeMs: stat.mtimeMs, size: stat.size, problem: (error as Error).message };
    }

    cache.set(file, entry);

    return entry;
}

/**
 * Every `.md` file under a root, relative to it.
 *
 * Git is asked first, because it knows every `.gitignore` in the tree,
 * nested ones and `!` lines included: tracked files plus untracked
 * files that are not ignored. A root that is not in a git repository,
 * or a machine with no git, falls back to walking the folders.
 * `.git` and `node_modules` are skipped either way.
 */
async function listMarkdown(root: string): Promise<string[]> {

    try {

        const { stdout } = await run(
            "git",
            ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
            { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 10_000, windowsHide: true });

        return [...new Set(stdout.split("\0"))]
            .filter(one => one && !one.split("/").some(part => SKIPPED_FOLDERS.has(part)))
            .map(one => path.normalize(one));

    } catch {

        return walk(root);
    }
}

/** `.md` files under a folder, without git. */
function walk(root: string): string[] {

    const found: string[] = [];

    const visit = (folder: string) => {

        let entries: fs.Dirent[];

        try {

            entries = fs.readdirSync(folder, { withFileTypes: true });

        } catch {

            return;
        }

        for (const entry of entries) {

            const full = path.join(folder, entry.name);

            if (entry.isDirectory()) {

                if (!SKIPPED_FOLDERS.has(entry.name))
                    visit(full);

            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
                found.push(path.relative(root, full));
        }
    };

    visit(root);

    return found;
}
