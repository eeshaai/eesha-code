/**
 * A tool call in the chat, drawn by its kind: its icon, what a run of
 * calls did in a few words, and what an opened call shows.
 *
 * The kind is the verb the engine puts at the start of a call's title
 * ("Reading app.js", "Executing 'npm test'" - see `toolLabel`). A title
 * with no known verb, such as an MCP tool's own name or a Kiro title we
 * cannot read, gets the plain look: the wrench, and its arguments.
 */
import React from "react";
import { labelVerb } from "../../core/agent/providers/describe";
import { textDiffChanges } from "../diff/textChanges";
import { CodeBlock, TextDiff } from "../ui";
import type { IconName } from "../ui";

/** The icon at the start of a call's row. */
export function toolIcon(name: string): IconName {

    if (name.startsWith("Searching web "))
        return "globe";

    switch (labelVerb(name)) {
        case "Reading": return "file";
        case "Writing": return "file-new";
        case "Editing": return "edit";
        case "Listing": return "folder-open";
        case "Searching": return "search";
        case "Executing": return "terminal";
        case "Fetching": return "globe";
        case "Running": return "tree";
        default: return "wrench";
    }
}

/**
 * What a run of calls did, in a few words: "read 2 files, ran 1
 * command". Each kind once, in the order it first came.
 *
 * Empty when every call is of no known kind: "8 other calls" next to the
 * group's own "Used 8 tools" says the same count twice.
 */
export function toolSummary(names: readonly string[]): string {

    const counts = new Map<string, number>();

    for (const name of names) {

        const verb = labelVerb(name) ?? "";

        counts.set(verb, (counts.get(verb) ?? 0) + 1);
    }

    if (counts.size === 1 && counts.has(""))
        return "";

    return [...counts].map(([verb, count]) => summaryPart(verb, count)).join(", ");
}

function summaryPart(verb: string, count: number): string {

    const of = (one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

    switch (verb) {
        case "Reading": return `read ${of("file", "files")}`;
        case "Writing": return `wrote ${of("file", "files")}`;
        case "Editing": return `edited ${of("file", "files")}`;
        case "Listing": return `listed ${of("folder", "folders")}`;
        case "Searching": return of("search", "searches");
        case "Executing": return `ran ${of("command", "commands")}`;
        case "Fetching": return `fetched ${of("page", "pages")}`;
        case "Running": return `started ${of("task", "tasks")}`;
        default: return of("other call", "other calls");
    }
}

/**
 * A call's argument line as name and value pairs.
 *
 * The engine writes a call's arguments as `name=value, name=value` (see
 * `describeArguments`). A line in any other shape - a bare command, a
 * title - gives undefined. A value that itself holds ", name=" is split
 * there: the line is all there is to go on.
 */
export function argPairs(detail: string | undefined): Array<[string, string]> | undefined {

    if (!detail || !/^[A-Za-z_][\w.-]*=/.test(detail))
        return undefined;

    return detail.split(/, (?=[A-Za-z_][\w.-]*=)/).map(part => {

        const at = part.indexOf("=");

        return [part.slice(0, at), part.slice(at + 1)] as [string, string];
    });
}

/**
 * A titled call's row, split in two: the verb in plain bold ("Read",
 * "Run"), then what it acted on in code font ("app.js", "npm test"), with
 * the quotes the engine put round it taken off. Undefined for a call that
 * has no title we know - a bare tool name keeps its own look.
 */
export function toolHeading(name: string): { verb: string; target: string } | undefined {

    for (const [prefix, verb] of HEADINGS) {

        if (!name.startsWith(prefix))
            continue;

        const rest = name.slice(prefix.length);
        const target = /^'(.*)'$/s.exec(rest)?.[1] ?? rest;

        return target ? { verb, target } : undefined;
    }

    return undefined;
}

/** Each title's opening words and the verb the row shows for them. "Searching web" comes before "Searching". */
const HEADINGS: ReadonlyArray<[string, string]> = [
    ["Searching web ", "Search web"],
    ["Running task ", "Task"],
    ["Reading ", "Read"],
    ["Writing ", "Write"],
    ["Editing ", "Edit"],
    ["Listing ", "List"],
    ["Searching ", "Search"],
    ["Executing ", "Run"],
    ["Fetching ", "Fetch"]
];

/** The argument names a file's path comes under, in the order `toolPath` tries them. */
const PATH_KEYS = ["file_path", "path", "filePath", "file", "target", "notebook_path"];

/**
 * The file a read opened, when the row can open it too: a full path that
 * the log did not cut short. A path relative to some folder is left
 * alone - a file is opened by its full path.
 */
export function readFile(name: string, detail: string | undefined): string | undefined {

    if (labelVerb(name) !== "Reading")
        return undefined;

    const pairs = argPairs(detail);
    const path = PATH_KEYS.map(key => pairs?.find(([one]) => one === key)?.[1]).find(Boolean);

    return path && !cut(path) && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path) ? path : undefined;
}

/**
 * Which lines a read asked for, as "lines 1-200" or "from line 40".
 * Claude sends `offset` (the first line) and `limit` (how many); Copilot
 * sends `view_range` as [first, last], where a last of -1 is the end of
 * the file. Undefined when the read took the whole file.
 */
export function readRange(name: string, detail: string | undefined): string | undefined {

    if (labelVerb(name) !== "Reading")
        return undefined;

    const pairs = argPairs(detail);
    const value = (key: string): string | undefined => pairs?.find(([one]) => one === key)?.[1];

    const range = /^\[(\d+),\s*(-?\d+)\]$/.exec(value("view_range") ?? "");

    if (range) {

        const [from, to] = [Number(range[1]), Number(range[2])];

        return to < 0 ? `from line ${from}` : `lines ${from}-${to}`;
    }

    const offset = Number(value("offset") ?? NaN);
    const limit = Number(value("limit") ?? NaN);

    if (Number.isInteger(limit) && limit > 0) {

        const from = Number.isInteger(offset) && offset > 0 ? offset : 1;

        return `lines ${from}-${from + limit - 1}`;
    }

    return Number.isInteger(offset) && offset > 0 ? `from line ${offset}` : undefined;
}

/** What an opened call is drawn from. */
export interface ToolBodyProps {

    /** The call's title. Its verb picks the shape. */
    name: string;

    /** What the call was given, as the engine wrote it. */
    detail?: string;

    /** What the runtime asked to run, on a call the engine allowed by itself, when it differs from `detail`. */
    asked?: string;

    /** What a running command has printed so far. */
    live?: string;

    /** What a finished call returned - only with the `toolResults` flag. */
    output?: string;
}

/** The engine ends a value it cut short with "..." (see `clip`). */
const cut = (text: string): boolean => text.endsWith("...");

/**
 * An opened call's body, shaped by its kind:
 *
 * 1. A command is a terminal: `$ command`, then what it printed.
 * 2. An edit is its old text over its new text, the changed words marked.
 *    The log keeps each text on one line and only its start, so this is
 *    the clipped text, not the file's real lines.
 * 3. Anything else is its arguments, one per line, then what it returned.
 *
 * Why a call failed is not here: the row shows it under itself, open or
 * closed.
 */
export function ToolBody({ name, detail, asked, live, output }: ToolBodyProps) {

    const verb = labelVerb(name);
    const pairs = argPairs(detail);
    const value = (...keys: string[]): string | undefined => pairs?.find(([key]) => keys.includes(key))?.[1];

    // A command: the `command` argument, or the whole line when the
    // runtime sent the command alone (Copilot's shell does).
    const command = verb === "Executing" ? (pairs ? value("command") : detail) : undefined;

    const before = verb === "Editing" ? value("old_string", "old_str") : undefined;
    const after = verb === "Editing" ? value("new_string", "new_str") : undefined;
    const isEdit = before !== undefined && after !== undefined;

    let main: React.ReactNode;

    if (command !== undefined) {

        // What it printed goes in the same box, under the command.
        const printed = live ?? output;

        main = (
            <>
                <div aria-live={live ? "polite" : undefined}>
                    <CodeBlock code={printed ? `$ ${command}\n${printed}` : `$ ${command}`} language="text" />
                </div>
                <Args pairs={pairs} skip={["command"]} />
            </>
        );
    }
    else if (isEdit) {

        const path = value("file_path", "path");

        main = (
            <>
                {path && <div className="chat-tool-edit__path">{path}</div>}
                <div className="chat-tool-edit__diff">
                    <TextDiff changes={textDiffChanges(before, after)} />
                </div>
                {(cut(before) || cut(after)) && (
                    <div className="chat-tool-note">Cut short - the log keeps only the start of each text.</div>
                )}
                <Args pairs={pairs} skip={["file_path", "path", "old_string", "old_str", "new_string", "new_str"]} />
            </>
        );
    }
    else {

        main = (
            <>
                <Label>Input</Label>
                {pairs
                    ? <Args pairs={pairs} skip={[]} />
                    : detail
                        ? <CodeBlock code={detail} language="text" />
                        : <div className="chat-tool-note">No arguments.</div>}
                {live && (
                    <>
                        <Label>Output so far</Label>
                        <div aria-live="polite">
                            <CodeBlock code={live} language="text" />
                        </div>
                    </>
                )}
                {output && (
                    <>
                        <Label>Output</Label>
                        <CodeBlock code={output} language="text" />
                    </>
                )}
            </>
        );
    }

    return (
        <>
            {main}
            {asked && (
                <>
                    <Label>Asked to run</Label>
                    <CodeBlock code={asked} language="text" />
                </>
            )}
        </>
    );
}

/** A heading inside the body, in the library's own look. */
function Label({ children }: { children: React.ReactNode }) {

    return <p className="ee-tool-panel__section-label">{children}</p>;
}

/** Arguments, one per line: the name, then the value. Nothing when none is left after `skip`. */
function Args({ pairs, skip }: { pairs: Array<[string, string]> | undefined; skip: readonly string[] }) {

    const shown = pairs?.filter(([key]) => !skip.includes(key)) ?? [];

    if (!shown.length)
        return null;

    return (
        <dl className="chat-tool-args">
            {shown.map(([key, text], index) => (
                <React.Fragment key={`${key}-${index}`}>
                    <dt>{key}</dt>
                    <dd>{text}</dd>
                </React.Fragment>
            ))}
        </dl>
    );
}
