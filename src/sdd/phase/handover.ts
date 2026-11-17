import { RunEvent } from "../../core/events/runEvents";

/*
 * The Handover button: the conversation so
 * far, written out for a runtime that was not there for it.
 *
 * A session id belongs to the runtime that issued it, and no runtime can
 * open another's transcript. So the only way to carry a conversation to
 * another runtime is to tell it what was said. The events file has every
 * turn - it is what redraws the thread on reopen - and this turns it into
 * a Markdown file, and the new session's first message points at it.
 */

/**
 * How many lines of one tool call's output go into a handover file. A
 * file read or a build log is mostly noise to the next agent, and it can
 * run the tool again when it needs the rest.
 */
const TOOL_OUTPUT_LINES = 30;

/**
 * The conversation so far as a Markdown file - what the Handover button
 * saves.
 *
 * What goes in: the person's messages, the agent's answers, questions
 * asked and answered, and one line per tool call with the first lines of
 * its output - a file is read in parts, so it can carry more than a
 * prompt could. What stays out: the agent's reasoning, notices, and the
 * old runtime's errors (see `threadOf`).
 *
 * @returns the file's text and how many lines it has - the new agent is
 * told the count, so it knows when it has read to the end.
 */
export function handoverTranscript(
    events: readonly RunEvent[],
    ownerId: string,
    about: { title: string; from?: string; model?: string; at: number }
): { text: string; lines: number } {

    const thread = threadOf(events, ownerId, true);

    const text = [
        `# Handover: ${about.title}`,
        "",
        `- From: ${about.from ?? "unknown runtime"}${about.model ? ` (${about.model})` : ""}`,
        `- Written: ${new Date(about.at).toISOString()}`,
        `- Messages from the person: ${thread.filter(block => block.startsWith("### Person\n")).length}`,
        "",
        `Tool outputs are cut to their first ${TOOL_OUTPUT_LINES} lines. Reasoning and the old runtime's errors are left out.`,
        "",
        "---",
        "",
        thread.length ? thread.join("\n\n") : "(nothing was said yet)",
        ""
    ].join("\n");

    return { text, lines: text.split("\n").length };
}

/**
 * The first message of the session a Handover starts: where the file is,
 * how long it is, and the last two exchanges copied in - they matter
 * most, and they still arrive when a long file is read only in part.
 *
 * @param carryOn what to do after reading. Absent: reply with one line
 * saying where things stand, then wait.
 */
export function handoverStartPrompt(
    events: readonly RunEvent[],
    ownerId: string,
    file: { path: string; lines: number; from?: string },
    carryOn?: string
): string {

    const recent = recentPart(events, ownerId);

    return [
        "## Handed over",
        "",
        `This conversation started on another runtime${file.from ? ` (${file.from})` : ""} and is handed over to you. `
        + `The conversation so far is in \`${file.path}\`. It is ${file.lines} lines long. `
        + "Read all of it, to the last line, before you reply.",
        "",
        "## The last part, copied here",
        "",
        recent ? clipStart(recent, RECENT_CHARS) : "(nothing was said yet)",
        "",
        "## What to do now",
        "",
        carryOn ?? "Reply with one line saying where things stand and what was asked last. Then wait for the next message. Do not start any work."
    ].join("\n");
}

/**
 * The message a chat sends after going back to an earlier message, on a
 * runtime whose conversation cannot be cut there: a new conversation
 * starts, so what was said before that point is in a file - the same
 * file a Handover writes - and the person's message follows.
 */
export function goBackPrompt(
    events: readonly RunEvent[],
    ownerId: string,
    file: { path: string; lines: number },
    message: string
): string {

    const recent = recentPart(events, ownerId);

    return [
        "## Earlier in this chat",
        "",
        "This chat went back to an earlier point, so this is a new conversation. "
        + `What was said before that point is in \`${file.path}\`. It is ${file.lines} lines long. `
        + "Read all of it, to the last line, before you reply.",
        "",
        "## The last part, copied here",
        "",
        recent ? clipStart(recent, RECENT_CHARS) : "(nothing was said yet)",
        "",
        "## My message",
        "",
        message
    ].join("\n");
}

/** From the person's second-to-last message to the end - the part a start prompt copies in. */
function recentPart(events: readonly RunEvent[], ownerId: string): string {

    const thread = threadOf(events, ownerId, false);

    const people = thread
        .map((block, index) => block.startsWith("### Person\n") ? index : -1)
        .filter(index => index >= 0);

    return thread.slice(people.length >= 2 ? people[people.length - 2] : 0).join("\n\n");
}

/** How much of the last two exchanges a start prompt copies in. */
const RECENT_CHARS = 6000;

/** The last `max` characters, with a mark where the rest was. */
function clipStart(text: string, max: number): string {

    return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

/** Every turn of one phase's thread, as headed blocks in the order they happened. */
function threadOf(events: readonly RunEvent[], ownerId: string, withOutputs = false): string[] {

    const blocks: string[] = [];

    // The agent's answer often arrives as several `message` records;
    // they are one block, not one heading each.
    let agent: string[] = [];

    const flushAgent = (): void => {

        if (agent.length)
            blocks.push(`### Agent\n${agent.join("").trim()}`);

        agent = [];
    };

    for (const event of events) {

        if (event.ownerId !== ownerId || !event.kind)
            continue;

        const text = (event.text ?? "").trim();

        switch (event.kind) {

            case "prompt":
                flushAgent();
                blocks.push(`### Person\n${text}`);
                break;

            case "message":
                agent.push(event.text ?? "");
                break;

            case "ask":
                flushAgent();
                blocks.push(`### Agent asked\n${event.prompt?.trim() || text}`);
                break;

            case "answer":
                flushAgent();
                blocks.push(`### Person answered\n${text}`);
                break;

            case "tool.start":
                flushAgent();
                blocks.push(`- tool: ${event.tool ?? "?"}${event.detail ? ` ${clip(event.detail, 200)}` : ""}`);
                break;

            // What came back, under the call's own line - only in the
            // file. `detail` is the output; `text` is only "Read done".
            case "tool.end": {

                const output = (event.detail ?? "").trimEnd();

                if (withOutputs && output) {

                    flushAgent();
                    blocks.push(fenced(output));
                }

                break;
            }

            // Reasoning, notices, tool results and the file's own
            // control lines say nothing the next runtime needs. Nor do
            // errors: they are the old runtime's - a quota hit, a
            // crash, a tool it could not run - and the usual reason
            // for the switch. Told about them, the new runtime opens
            // by explaining a failure that is not its own.
            default:
                break;
        }
    }

    flushAgent();

    return blocks;
}

/**
 * A tool's output as a fenced block, cut to {@link TOOL_OUTPUT_LINES}.
 * The fence is longer than any run of backticks inside, so an output
 * that holds Markdown cannot close it early.
 */
function fenced(output: string): string {

    const all = output.split(/\r?\n/);
    const kept = all.slice(0, TOOL_OUTPUT_LINES);
    const cut = all.length - kept.length;

    const longest = Math.max(0, ...(output.match(/`+/g) ?? []).map(run => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));

    return [
        fence,
        ...kept,
        fence,
        ...(cut > 0 ? [`(${cut} more lines cut)`] : [])
    ].join("\n");
}

/** The first `max` characters, with a mark where the rest was. */
function clip(text: string, max: number): string {

    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
