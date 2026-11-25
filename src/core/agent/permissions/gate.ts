import * as os from "os";
import * as path from "path";

import type { AskPermission } from "../../models/run";
import {
    AnswerScope,
    LEVEL_NAMES,
    PermissionCard,
    PermissionLevel,
    RememberChoice,
    SavedAnswer,
    SCOPE_NAMES,
    readAnswer
} from "../../models/permissionCard";
import type { PathJail } from "../providers/pathJail";
import { AnswerBook, samePath } from "./answers";
import { cdTarget, cleanCommand, commandChoices, commandMatches } from "./command";
import { folderChoices, protectedReason } from "./protectedPaths";

/*
 * Our own permission check: one decision for one tool call, the same on
 * every provider. Each provider
 * turns its own request into a {@link GateCall} and asks {@link
 * PermissionGate.decide}; a card's answer goes back through {@link
 * PermissionGate.answer}.
 */

/** One tool call, in the words every provider can be put into. */
export interface GateCall {

    /** The runtime's own name for it - for the log, never for matching. */
    tool: string;

    /**
     * What it does:
     * - `command`: runs a shell command ({@link command}).
     * - `edit`: writes, deletes or moves files ({@link paths}).
     * - `read`: reads, lists or searches files.
     * - `mcp`: an MCP server's tool ({@link server}, {@link mcpTool}).
     * - `web`: fetches an address ({@link url}) or searches the web ({@link search}).
     * - `housekeeping`: the agent's own to-do list, questions, helper agents and our own tools - always runs.
     * - `tool`: any other tool, remembered by {@link name}.
     * - `unknown`: nothing to tell it by.
     */
    what: "command" | "edit" | "read" | "mcp" | "web" | "housekeeping" | "tool" | "unknown";

    /** The command as the agent sent it. */
    command?: string;

    /** Files and folders it names, as sent - checked against the chat's folders. */
    paths?: readonly string[];

    /** Whether it could change those paths. Unset counts as yes. */
    writes?: boolean;

    server?: string;

    mcpTool?: string;

    url?: string;

    /** The search words, for a web search. */
    search?: string;

    /** What a `tool` is remembered by. */
    name?: string;

    /** An ACP agent's own kind for the request (`execute`, `edit`, ...). Unset or empty for none. */
    acpKind?: string;

    /** Can only be allowed once - Copilot asking to run outside its sandbox. */
    onceOnly?: boolean;
}

/** What to do with one call. */
export type GateDecision =

    /** Run it. `note` is what its row says; none for a call that runs silently. */
    | { verdict: "allow"; note?: string }

    /** Never run, no card. `reason` is told to the agent; `note` goes on the row. */
    | { verdict: "deny"; reason: string; note: string }

    /** Ask the person with this card. */
    | { verdict: "ask"; card: PermissionCard };

/** What the person's answer means. */
export type GateAnswer =
    | { allow: true; note: string }
    | { allow: false; note: string; reason?: string };

export interface PermissionGate {

    /** The level in force now - read on every call, so the picker holds at once. */
    level(): PermissionLevel;

    /** The decision for one call. `jail` is the session's own folder boundary. */
    decide(call: GateCall, jail: PathJail): GateDecision;

    /** The person's answer to a card for this call: what it means, saved first when it says to. */
    answer(call: GateCall, card: PermissionCard, text: string): GateAnswer;
}

/** What a gate needs from the program it runs in. */
export interface GateOptions {

    /** The provider id: `claude`, `ghcp`, or an ACP agent's id. */
    provider: string;

    /** Whether the provider is an ACP agent. */
    acp: boolean;

    /** The chat this session is for - fixed when the session starts. */
    chatId: string;

    /** The chat's working folder: where "This folder" answers are filed. */
    workingFolder: string;

    level(): PermissionLevel;

    book: AnswerBook;

    /** A card's "Add folder to this chat": the folder joins the chat's list. */
    addFolder(folder: string): void;

    /**
     * Nobody is there to answer a card - a variant of an evaluation. A
     * call outside the chat's folders is refused, never asked. The caller
     * also gives `level` as Auto, so no other call asks either.
     */
    unattended?: boolean;

    /** Injected so a test does not depend on this machine's home folder. */
    home?: string;
}

/** The provider as a card names it: "copilot wants to run a command". */
export function agentName(provider: string): string {

    return provider === "ghcp" ? "copilot" : provider;
}

/** The note on a row a level let through without asking. */
const READ_NOTE = "ran without asking: a read inside the chat's folders";

export function createPermissionGate(options: GateOptions): PermissionGate {

    /** Folders added from a card in this session. The session's own jail does not know them. */
    const added: string[] = [];

    const home = options.home ?? os.homedir();

    const who = agentName(options.provider);

    /** Under one of the folders added from a card. */
    const inAdded = (absolute: string): boolean => added.some(folder => isUnder(absolute, folder));

    /** Whether a path is inside the chat's folders: the jail's roots or a folder added. */
    const insideChat = (absolute: string, jail: PathJail): boolean =>
        jail.allows(absolute, true) || inAdded(absolute);

    /** The first path the call names outside the chat's folders, resolved. */
    const outside = (call: GateCall, jail: PathJail): string | undefined => {

        for (const asked of call.paths ?? []) {

            if (typeof asked !== "string" || !asked)
                continue;

            const escape = jail.escape({ paths: [asked] }, undefined, call.writes !== false);

            if (escape && !inAdded(escape.resolved))
                return escape.resolved;
        }

        return undefined;
    };

    /** Whether the level asks about this call. */
    const levelAsks = (call: GateCall, level: PermissionLevel): boolean => {

        if (options.acp) {

            if (level === "agent")
                return true;

            return level === "semi"
                && (!call.acpKind || call.acpKind === "execute" || call.acpKind === "other");
        }

        if (level === "manual")
            return call.what !== "read" && call.what !== "housekeeping";

        return level === "semi" && call.what === "command";
    };

    /**
     * The saved answer that covers this call: one answer, `"silent"` for a
     * chained command whose every part is covered, or nothing.
     */
    const savedFor = (call: GateCall, jail: PathJail): SavedAnswer | "silent" | undefined => {

        const answers = options.book.applying(options.chatId, options.workingFolder);

        if (!answers.length && call.what !== "command")
            return undefined;

        const ofKind = (kind: SavedAnswer["kind"]): SavedAnswer[] => answers.filter(answer => answer.kind === kind);

        switch (call.what) {

            case "command": {

                const cleaned = cleanCommand(call.command ?? "");

                if (!cleaned.text)
                    return undefined;

                const commands = ofKind("command");

                // The whole text, exactly - how a chained command is saved.
                const whole = commands.find(answer => answer.pattern === cleaned.text);

                if (whole)
                    return whole;

                if (cleaned.onceOnly || call.onceOnly)
                    return undefined;

                if (cleaned.parts.length === 1)
                    return commands.find(answer => commandMatches(answer.pattern, cleaned.parts[0]));

                // A chain: every part covered, a `cd` into the chat's
                // folders included, and it runs with no note at all.
                let at = options.workingFolder;

                for (const part of cleaned.parts) {

                    const target = cdTarget(part, at, (from, to) => path.resolve(from, to));

                    if (target !== undefined) {

                        if (!insideChat(target, jail))
                            return undefined;

                        at = target;

                        continue;
                    }

                    if (!commands.some(answer => commandMatches(answer.pattern, part)))
                        return undefined;
                }

                return "silent";
            }

            case "edit":
            case "read": {

                const files = (call.paths ?? []).filter(one => typeof one === "string" && one.length > 0);

                if (!files.length)
                    return undefined;

                const kind = ofKind(call.what);

                let found: SavedAnswer | undefined;

                for (const file of files) {

                    const absolute = path.resolve(options.workingFolder, file);

                    const match = kind.find(answer => fileMatches(answer.pattern, absolute));

                    if (!match)
                        return undefined;

                    found ??= match;
                }

                return found;
            }

            case "mcp": {

                if (!call.server || !call.mcpTool)
                    return undefined;

                const own = `${call.server}/${call.mcpTool}`;

                return ofKind("mcp").find(answer => answer.pattern === own || answer.pattern === `${call.server}/*`);
            }

            case "web": {

                if (call.search !== undefined && !call.url)
                    return ofKind("web").find(answer => answer.pattern === WEB_SEARCH);

                if (!call.url)
                    return undefined;

                return ofKind("web").find(answer => urlMatches(answer.pattern, call.url!));
            }

            case "tool":

                return call.name ? ofKind("tool").find(answer => answer.pattern === call.name) : undefined;

            default:

                return undefined;
        }
    };

    /** A saved pattern as a person reads it - a file pattern relative to the working folder. */
    const shownPattern = (answer: SavedAnswer): string =>
        answer.kind === "edit" || answer.kind === "read" ? relativeShown(answer.pattern, options.workingFolder) : answer.pattern;

    const cardFor = (call: GateCall, level: PermissionLevel): PermissionCard => {

        const base = {
            level: LEVEL_NAMES[level],
            ...(options.acp ? { noReason: true } : {})
        };

        const once = (title: string, shown: string, why?: string): PermissionCard => ({
            ...base,
            type: "once",
            title,
            shown,
            scopes: [],
            ...(why ? { lines: [`It can only be allowed once: ${why}.`] } : {})
        });

        switch (call.what) {

            case "command": {

                const raw = call.command ?? "";
                const cleaned = cleanCommand(raw);
                const title = `${who} wants to run a command`;
                const sentAs = {
                    where: options.workingFolder,
                    ...(raw.trim() !== cleaned.text ? { sentAs: raw.trim() } : {})
                };

                if (!cleaned.text)
                    return once(title, "(an empty command)", "the agent sent no command text");

                if (call.onceOnly)
                    return { ...once(title, cleaned.text, "it asks to run outside Copilot's sandbox"), ...sentAs };

                if (cleaned.onceOnly)
                    return { ...once(title, cleaned.text, cleaned.onceOnly), ...sentAs };

                if (cleaned.parts.length > 1)
                    return {
                        ...base,
                        ...sentAs,
                        type: "chained",
                        title,
                        shown: cleaned.text,
                        lines: [
                            "This runs several commands in one go. It is asked as one command, exactly as written.",
                            "Only this exact command can be saved. A chained command gets no wildcard choices."
                        ],
                        remember: [{ pattern: cleaned.text }],
                        pick: 0,
                        scopes: ["session", "folder", "always"],
                        kind: "command"
                    };

                const { choices, pick } = commandChoices(cleaned.parts[0]);

                return {
                    ...base,
                    ...sentAs,
                    type: "command",
                    title,
                    shown: cleaned.text,
                    remember: choices,
                    pick,
                    scopes: ["session", "folder", "always"],
                    kind: "command"
                };
            }

            case "edit":
            case "read": {

                const files = (call.paths ?? []).filter(one => typeof one === "string" && one.length > 0)
                    .map(one => path.resolve(options.workingFolder, one));

                const verb = call.what === "edit" ? "edit" : "read";

                if (!files.length)
                    return call.name
                        ? toolCard(call.name, `${who} wants to ${verb} a file`)
                        : once(`${who} wants to ${verb} a file`, call.tool, "the agent did not say which file");

                const first = files[0];
                const folder = path.dirname(first);

                const choices: RememberChoice[] = [
                    { pattern: slashes(first), shown: relativeShown(slashes(first), options.workingFolder), hint: "only this file" },
                    { pattern: `${slashes(folder)}/**`, shown: relativeShown(`${slashes(folder)}/**`, options.workingFolder), hint: "this folder and below" },
                    { pattern: ANY_FILE, hint: "every file in the chat's folders" }
                ];

                return {
                    ...base,
                    type: call.what,
                    title: `${who} wants to ${verb} ${files.length > 1 ? `${files.length} files` : "a file"}`,
                    shown: files.map(one => relativeShown(slashes(one), options.workingFolder)).join("\n"),
                    remember: choices,
                    pick: 1,
                    // No Always for edits.
                    scopes: call.what === "edit" ? ["session", "folder"] : ["session", "folder", "always"],
                    kind: call.what
                };
            }

            case "mcp": {

                if (!call.server || !call.mcpTool)
                    return call.name
                        ? toolCard(call.name, `${who} wants to use an MCP tool`)
                        : once(`${who} wants to use an MCP tool`, call.tool, "the agent did not say which server");

                return {
                    ...base,
                    type: "mcp",
                    title: `${who} wants to use an MCP tool`,
                    shown: `${call.server}/${call.mcpTool}`,
                    remember: [
                        { pattern: `${call.server}/${call.mcpTool}`, hint: "only this tool" },
                        { pattern: `${call.server}/*`, hint: `every tool of ${call.server}` }
                    ],
                    pick: 0,
                    scopes: ["session", "folder", "always"],
                    kind: "mcp"
                };
            }

            case "web": {

                if (!call.url)
                    return {
                        ...base,
                        type: "web",
                        title: `${who} wants to search the web`,
                        shown: call.search?.trim() || "(no search words)",
                        remember: [{ pattern: WEB_SEARCH, hint: "every web search" }],
                        pick: 0,
                        scopes: ["session", "folder", "always"],
                        kind: "web"
                    };

                const site = siteOf(call.url);

                return {
                    ...base,
                    type: "web",
                    title: `${who} wants to fetch from the web`,
                    shown: call.url,
                    remember: [
                        { pattern: call.url, hint: "only this address" },
                        ...(site ? [{ pattern: `${site.origin}/*`, hint: `every address on ${site.host}` }] : [])
                    ],
                    pick: site ? 1 : 0,
                    scopes: ["session", "folder", "always"],
                    kind: "web"
                };
            }

            case "tool":

                return call.name
                    ? toolCard(call.name, `${who} wants to use a tool`)
                    : once(`${who} wants to use a tool`, call.tool, "the tool has no name to remember it by");

            default:

                return once(`${who} wants to use a tool`, call.tool || "(no name)", "the agent said nothing about what it is");
        }

        function toolCard(name: string, title: string): PermissionCard {

            return {
                ...base,
                type: "tool",
                title,
                shown: name,
                remember: [{ pattern: name, hint: "only this tool" }],
                pick: 0,
                scopes: ["session", "folder", "always"],
                kind: "tool"
            };
        }
    };

    const outsideCard = (call: GateCall, absolute: string, jail: PathJail): PermissionCard => {

        const doing = call.what === "command"
            ? "run a command that reaches"
            : call.writes === false ? "read a file" : "change a file";

        return {
            level: "asked in every mode",
            ...(options.acp ? { noReason: true } : {}),
            type: "outside",
            title: `${who} wants to ${doing} outside this chat's folders`,
            shown: absolute,
            scopes: [],
            outside: {
                path: absolute,
                chatFolders: [...jail.roots, ...added],
                folders: folderChoices(absolute, home)
            }
        };
    };

    return {

        level: () => options.level(),

        decide(call: GateCall, jail: PathJail): GateDecision {

            // Outside the chat's folders: asked at every level, or never
            // allowed at all.
            const far = outside(call, jail);

            if (far) {

                const reason = protectedReason(far, home);

                if (reason)
                    return {
                        verdict: "deny",
                        note: `refused: ${reason} is never allowed, in any mode`,
                        reason: `Denied: ${far} is in ${reason}, which this chat never allows, at any permission level.`
                            + ` Work only inside the chat's folders: ${[...jail.roots, ...added].join(", ") || "(none)"}.`
                            + " Do not look for another way to reach it."
                    };

                if (options.unattended)
                    return {
                        verdict: "deny",
                        note: "refused: outside this session's folders, and nobody is asked",
                        reason: `Denied: ${far} is outside this session's folders, and nobody can be asked to allow it.`
                            + ` Work only inside: ${[...jail.roots, ...added].join(", ") || "(none)"}.`
                            + " Do not look for another way to reach it."
                    };

                return { verdict: "ask", card: outsideCard(call, far, jail) };
            }

            if (call.what === "housekeeping")
                return { verdict: "allow" };

            const level = options.level();

            if (level === "auto")
                return { verdict: "allow", note: "auto-allowed (Auto)" };

            const saved = savedFor(call, jail);

            if (saved === "silent")
                return { verdict: "allow" };

            if (saved)
                return { verdict: "allow", note: `allowed by your answer \`${shownPattern(saved)}\` (${SCOPE_NAMES[saved.scope]})` };

            if (!levelAsks(call, level))
                return { verdict: "allow", note: call.what === "read" ? READ_NOTE : `auto-allowed (${LEVEL_NAMES[level]})` };

            return { verdict: "ask", card: cardFor(call, level) };
        },

        answer(_call: GateCall, card: PermissionCard, text: string): GateAnswer {

            const answer = readAnswer(text);

            switch (answer.choice) {

                case "once":
                    return { allow: true, note: "allowed once by you" };

                case "deny":
                    return answer.reason
                        ? { allow: false, note: `denied by you: "${answer.reason}"`, reason: answer.reason }
                        : { allow: false, note: "denied by you" };

                case "addFolder": {

                    // Only a folder the card offered: the answer comes from a page.
                    const offered = card.outside?.folders.find(folder => samePath(folder.path, answer.folder));

                    if (!offered)
                        return { allow: false, note: "denied: that folder was not one the card offered" };

                    if (!added.some(folder => samePath(folder, offered.path)))
                        added.push(offered.path);

                    options.addFolder(offered.path);

                    return { allow: true, note: `allowed by you, and ${offered.path} was added to this chat` };
                }

                default: {

                    const scope: AnswerScope = answer.choice;

                    // A yes the card did not offer to save is a yes once:
                    // nothing reaches the file the card did not show.
                    const choice = card.scopes.includes(scope) && card.kind
                        ? card.remember?.find(one => one.pattern === answer.pattern)
                        : undefined;

                    if (!choice || !card.kind)
                        return { allow: true, note: "allowed once by you" };

                    const saved = options.book.add({
                        kind: card.kind,
                        pattern: choice.pattern,
                        scope,
                        ...(scope === "session" ? { chatId: options.chatId } : {}),
                        ...(scope === "folder" ? { folder: options.workingFolder } : {}),
                        agent: options.provider
                    });

                    if (!saved)
                        return { allow: true, note: "allowed once by you" };

                    return { allow: true, note: `allowed by your answer \`${choice.shown ?? choice.pattern}\` (${SCOPE_NAMES[scope]})` };
                }
            }
        }
    };
}

/** The pattern for every file - `**`, inside the chat's folders. */
export const ANY_FILE = "**";

/** The pattern for every web search. */
export const WEB_SEARCH = "web search";

/** A path with forward slashes - how file patterns are kept. */
function slashes(one: string): string {

    return one.replace(/\\/g, "/");
}

/**
 * A saved answer's pattern as the saved answers list shows it: a file
 * pattern relative to the working folder, an MCP one as `server · tool`.
 */
export function answerShown(answer: Pick<SavedAnswer, "kind" | "pattern">, workingFolder: string | undefined): string {

    if ((answer.kind === "edit" || answer.kind === "read") && workingFolder)
        return relativeShown(answer.pattern, workingFolder);

    if (answer.kind === "mcp") {

        const cut = answer.pattern.indexOf("/");

        if (cut > 0) {

            const tool = answer.pattern.slice(cut + 1);

            return `${answer.pattern.slice(0, cut)} · ${tool === "*" ? "every tool" : tool}`;
        }
    }

    return answer.pattern;
}

/** A file pattern relative to the working folder when it is inside it. */
function relativeShown(pattern: string, folder: string): string {

    if (pattern === ANY_FILE)
        return pattern;

    const base = slashes(path.resolve(folder)).replace(/\/$/, "");

    const windows = process.platform === "win32";

    const one = windows ? pattern.toLowerCase() : pattern;
    const root = windows ? base.toLowerCase() : base;

    if (one.startsWith(`${root}/`))
        return pattern.slice(base.length + 1);

    return pattern;
}

/** Whether a saved file pattern covers one absolute path. */
export function fileMatches(pattern: string, absolute: string, isWindows: boolean = process.platform === "win32"): boolean {

    if (pattern === ANY_FILE)
        return true;

    const file = slashes(path.resolve(absolute));

    const one = isWindows ? file.toLowerCase() : file;
    const saved = isWindows ? pattern.toLowerCase() : pattern;

    if (saved.endsWith("/**")) {

        const folder = saved.slice(0, -3);

        return one === folder || one.startsWith(`${folder}/`);
    }

    return one === saved;
}

/** Whether a saved web pattern covers one address: the same address, or a site's `/*`. */
export function urlMatches(pattern: string, url: string): boolean {

    if (pattern === url)
        return true;

    if (!pattern.endsWith("/*"))
        return false;

    const site = siteOf(url);

    return site !== undefined && `${site.origin}/*` === pattern;
}

function siteOf(url: string): { origin: string; host: string } | undefined {

    try {

        const parsed = new URL(url);

        return parsed.host ? { origin: parsed.origin, host: parsed.host } : undefined;

    } catch {

        return undefined;
    }
}

function isUnder(candidate: string, root: string, isWindows: boolean = process.platform === "win32"): boolean {

    const one = path.resolve(candidate);
    const other = path.resolve(root);

    const a = isWindows ? one.toLowerCase() : one;
    const b = isWindows ? other.toLowerCase() : other;

    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * The permission an `ask` or a notice carries: the tool, what it would be
 * given, and our card or the row's note.
 */
export function gatePermission(
    tool: string,
    input: string | undefined,
    extra: { card?: PermissionCard; note?: string; refused?: boolean } = {}
): AskPermission {

    return {
        tool,
        ...(input !== undefined && input !== "" ? { input } : {}),
        ...(extra.card ? { card: extra.card } : {}),
        ...(extra.note ? { note: extra.note } : {}),
        ...(extra.refused ? { refused: true } : {})
    };
}
