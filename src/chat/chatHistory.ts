import * as fs from "fs";
import * as path from "path";

import { eventsRoot } from "../core/events/eventFile";
import { currentEvents, parseEvents, RunEvent } from "../core/events/runEvents";
import type { ChatSummary } from "../shared/chatMessages";

/*
 * The chat's history list, read off the events files - the
 * chats of the chat page and every spec's phase chats. It needs no page,
 * so a test can hold it.
 */

/** Longest title shown before it is cut. */
const TITLE_LIMIT = 80;

/**
 * One chat's row: named by the newest title the runtime gave the
 * conversation (Kiro v3 writes one), else by the first thing the person
 * asked; dated by the last thing that happened. `undefined` for a file
 * with no message in it - a chat started and never used is not history.
 */
export function summarizeChat(id: string, events: readonly RunEvent[]): Omit<ChatSummary, "current"> | undefined {

    const prompt = events.find(event => event.kind === "prompt");

    if (!prompt)
        return undefined;

    const last = events[events.length - 1];
    const named = [...events].reverse().find(event => typeof event.title === "string" && event.title.trim());

    return {
        id,
        title: named ? cut(named.title!.trim()) : titleOf(prompt.text ?? ""),
        at: last.at,
        ...(lastProvider(events) ? { provider: lastProvider(events) } : {})
    };
}

/** The first line of what was asked, cut to fit a row. */
export function titleOf(text: string): string {

    const first = text
        .split("\n")
        .map(line => line.trim())
        .find(line => line);

    if (!first)
        return "Files only";

    return cut(first);
}

/** Cut to fit a row. */
function cut(text: string): string {

    return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT - 1)}…` : text;
}

function lastProvider(events: readonly RunEvent[]): string | undefined {

    for (let index = events.length - 1; index >= 0; index--)
        if (events[index].kind === "session" && events[index].provider)
            return events[index].provider;

    return undefined;
}

/**
 * Each chat file's row, kept with the file's size and time of change, so
 * a file nobody wrote to since is not read again. A list is asked for
 * every time a turn starts or ends, and a chat file can be megabytes.
 * Any write changes the size or the time, so a kept row is never stale.
 */
const summaries = new Map<string, { size: number; changed: number; summary: Omit<ChatSummary, "current"> | undefined }>();

/** Every chat with something in it, newest first. */
export function listChats(workspace: string | undefined): Omit<ChatSummary, "current">[] {

    const folder = path.join(eventsRoot(workspace), "chats");

    return filesIn(folder)
        .flatMap(file => {

            const summary = summaryOf(file);

            return summary ? [summary] : [];
        })
        .sort((left, right) => right.at - left.at);
}

/** One chat file's row - kept from the last read when the file did not change. */
function summaryOf(file: string): Omit<ChatSummary, "current"> | undefined {

    let stat: fs.Stats;

    try {

        stat = fs.statSync(file);

    } catch {

        summaries.delete(file);

        return undefined;
    }

    const kept = summaries.get(file);

    if (kept && kept.size === stat.size && kept.changed === stat.mtimeMs)
        return kept.summary;

    const summary = summarizeChat(path.basename(file, ".jsonl"), read(file));

    summaries.set(file, { size: stat.size, changed: stat.mtimeMs, summary });

    return summary;
}

/** Longest line of matching text a search hit shows. */
const HIT_LIMIT = 120;

/** How much of the text before the match a hit's line keeps. */
const HIT_BEFORE = 30;

/** A chat whose messages hold the text searched for: one line around the first place it is. */
export interface ChatHit {

    id: string;

    line: string;
}

/**
 * What was said in each chat file, kept with the file's size and time of
 * change like `summaries`: a search runs as the person types.
 */
const saidKept = new Map<string, { size: number; changed: number; said: string[] }>();

/**
 * What was said in a chat: each message from the person, and each answer
 * from the agent as one piece - it often arrives as several records. Not
 * tool calls or their output, not reasoning. Only what the chat shows
 * today: a New Session or a clear hides the lines before it.
 */
export function saidIn(events: readonly RunEvent[]): string[] {

    const said: string[] = [];

    let agent = "";

    const flushAgent = (): void => {

        if (agent.trim())
            said.push(agent.trim());

        agent = "";
    };

    for (const event of currentEvents(events)) {

        switch (event.kind) {

            case "message":
                agent += event.text ?? "";
                break;

            case "prompt":
                flushAgent();

                if (event.text?.trim())
                    said.push(event.text.trim());

                break;

            // A tool call or a question splits the agent's answer, as on screen.
            case "tool.start":
            case "ask":
            case "answer":
                flushAgent();
                break;

            default:
                break;
        }
    }

    flushAgent();

    return said;
}

/**
 * The chats whose messages hold `query`, in any case, with spaces and
 * line breaks counted as one space. One hit per chat: the first place
 * the text is.
 */
export function searchChats(workspace: string | undefined, query: string): ChatHit[] {

    const wanted = query.replace(/\s+/g, " ").trim().toLowerCase();

    if (!wanted)
        return [];

    const folder = path.join(eventsRoot(workspace), "chats");

    return filesIn(folder).flatMap(file => {

        for (const piece of saidOf(file)) {

            const flat = piece.replace(/\s+/g, " ");
            const at = flat.toLowerCase().indexOf(wanted);

            if (at >= 0)
                return [{ id: path.basename(file, ".jsonl"), line: around(flat, at) }];
        }

        return [];
    });
}

/** One line of `text` from a little before `at`, cut to fit a row. */
function around(text: string, at: number): string {

    const start = Math.max(0, at - HIT_BEFORE);
    const end = Math.min(text.length, start + HIT_LIMIT);

    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** What was said in one chat file - kept from the last read when the file did not change. */
function saidOf(file: string): string[] {

    let stat: fs.Stats;

    try {

        stat = fs.statSync(file);

    } catch {

        saidKept.delete(file);

        return [];
    }

    const kept = saidKept.get(file);

    if (kept && kept.size === stat.size && kept.changed === stat.mtimeMs)
        return kept.said;

    const said = saidIn(read(file));

    saidKept.set(file, { size: stat.size, changed: stat.mtimeMs, said });

    return said;
}

function filesIn(folder: string): string[] {

    try {

        return fs.readdirSync(folder)
            .filter(name => name.endsWith(".jsonl"))
            .map(name => path.join(folder, name));

    } catch {

        // No folder yet: nothing was ever recorded here.
        return [];
    }
}

function read(file: string): RunEvent[] {

    try {

        return parseEvents(fs.readFileSync(file, "utf8"));

    } catch {

        return [];
    }
}
