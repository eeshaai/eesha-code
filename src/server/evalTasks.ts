import * as fs from "fs";
import * as path from "path";

import { eeshaPath } from "./paths";
import { EVAL_NAME, type EvalFinding, type EvalTask } from "./protocol";

/*
 * The Evaluator's saved tasks: a message kept under a name, so the same
 * words go to every variant today and to a new model in six months.
 *
 * A few are built in. A person's own are files, one task each:
 *
 *   ~/.eesha/eval-tasks/<name>.md
 *
 *   ---
 *   title: Find slow database calls
 *   kind: find
 *   ---
 *   Look for database calls inside loops in this folder.
 *
 * The lines between the two `---` are optional. `kind` is `find` (look
 * and report, change nothing), `fix` (find and fix) or left out (the
 * text is sent as it is). A file named like a built-in task replaces it.
 *
 * A `find` or `fix` task gets the same closing lines added when it is
 * sent: how to list what was found. Every variant then answers in one
 * form, and the report can put the findings side by side - see
 * `parseFindings`. The closing lines are here and nowhere else, so what
 * is asked for and what is read back cannot drift apart.
 */

/** Where a person's own tasks are. */
export function evalTasksDir(): string {

    return eeshaPath("eval-tasks");
}

/** The largest task file read. A bigger one is not a message. */
const TASK_FILE_LIMIT = 64 * 1024;

/** The longest a finding's problem text is kept. */
const PROBLEM_LIMIT = 400;

/** The most findings read from one turn. */
const FINDINGS_LIMIT = 200;

/** The name after the fence that marks the list of findings. */
const FINDINGS_FENCE = "findings";

/** How a variant is told to list what it found. One finding per line, so a cut-off answer still gives the lines before the cut. */
const FINDINGS_FORMAT = [
    `End your answer with one code block that starts with \`\`\`${FINDINGS_FENCE} and lists every finding, one per line, in this form:`,
    "",
    "file | line | severity | problem",
    "",
    "- file: the path from this folder, with forward slashes.",
    "- line: the line number where the problem starts, or 0 when it has no single line.",
    "- severity: high, medium or low.",
    "- problem: one sentence, with no | in it.",
    "",
    "List only what you checked in the code yourself. When you found nothing, write the block with the single line: none"
].join("\n");

const CLOSING: Record<"find" | "fix", string> = {
    find: `Do not change, create or delete any file: only read and report.\n\n${FINDINGS_FORMAT}`,
    fix: `Fix each problem you find, with the smallest change that fixes it. Do not change anything else.\n\n${FINDINGS_FORMAT}\n\nList each problem you fixed, at the line it was before your change.`
};

/** What the built-in tasks look for. Each gives one `find` task and one `fix` task. */
const TOPICS: { name: string; title: string; look: string }[] = [
    {
        name: "security",
        title: "security problems",
        look: "Look for security problems in the code in this folder: input used without a check (SQL, shell commands, file paths, HTML), missing or wrong checks of who may do what, secrets written in the code, unsafe use of cryptography, and data sent or logged that should not be."
    },
    {
        name: "cache",
        title: "cache problems",
        look: "Look for cache problems in the code in this folder: a cached value that is never cleared or refreshed after the data changes, a cache key that leaves out something the value depends on (the user, the tenant, the language), a cache that grows without a limit, and a cache read or written by two requests at once without care."
    },
    {
        name: "error-handling",
        title: "error handling problems",
        look: "Look for error handling problems in the code in this folder: an error caught and dropped, an error that leaves data half written, a missing timeout or retry on a call to another service, a resource not closed when a step fails, and an error message that gives away internal details to the caller."
    },
    {
        name: "missing-tests",
        title: "missing tests",
        look: "Look for code in this folder that has no test and needs one: a branch that decides money, access or data loss, an error path, and an edge value (empty, zero, very large, wrong type). Name the function and the case that is not tested."
    }
];

const FIX_TITLES: Record<string, string> = { "missing-tests": "Add the missing tests" };

const FIX_TEXTS: Record<string, string> = {
    "missing-tests": "Write the missing tests, in the way this folder's tests are already written, and run them."
};

/** The built-in tasks: for each topic, one that only finds and one that fixes. */
export function builtInTasks(): EvalTask[] {

    return TOPICS.flatMap(topic => [
        {
            name: `find-${topic.name}`,
            title: `Find ${topic.title}`,
            kind: "find" as const,
            text: `${topic.look}\n\nReport what you find, or say that you found nothing. Do not make up a problem to have something to report.`,
            own: false
        },
        {
            name: `fix-${topic.name}`,
            title: FIX_TITLES[topic.name] ?? `Find and fix ${topic.title}`,
            kind: "fix" as const,
            text: `${topic.look}\n\n${FIX_TEXTS[topic.name] ?? "Fix what you find. When you find nothing, change nothing and say so."}`,
            own: false
        }
    ]);
}

/**
 * One task file read: the lines between the two `---` at its top give
 * the title and the kind, the rest is the message.
 */
export function parseTaskFile(name: string, content: string): EvalTask | { problem: string } {

    const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");

    let title = name;
    let kind: EvalTask["kind"];
    let body = text;

    const head = /^---\n([\s\S]*?)\n---\n?/.exec(text);

    if (head) {

        body = text.slice(head[0].length);

        for (const line of head[1]!.split("\n")) {

            const at = line.indexOf(":");

            if (at < 0)
                continue;

            const key = line.slice(0, at).trim().toLowerCase();
            const value = line.slice(at + 1).trim();

            if (key === "title" && value)
                title = value.slice(0, 120);

            if (key === "kind" && value) {

                if (value !== "find" && value !== "fix")
                    return { problem: `${name}.md: kind is '${value}'. Write find or fix, or leave the line out.` };

                kind = value;
            }
        }
    }

    if (!body.trim())
        return { problem: `${name}.md has no message under its first lines.` };

    return { name, title, ...(kind ? { kind } : {}), text: body.trim(), own: true };
}

/** A person's own tasks, by name, and what is wrong with the files that could not be read as one. */
export function ownTasks(): { tasks: EvalTask[]; problems: string[] } {

    const tasks: EvalTask[] = [];
    const problems: string[] = [];

    let names: string[];

    try {

        names = fs.readdirSync(evalTasksDir());

    } catch {

        // No folder yet: no own tasks.
        return { tasks, problems };
    }

    for (const file of names.sort((left, right) => left.localeCompare(right))) {

        if (!file.toLowerCase().endsWith(".md"))
            continue;

        const name = file.slice(0, -3);

        if (!EVAL_NAME.test(name)) {

            problems.push(`${file}: a task file's name is letters, digits, - and _ only, up to 60.`);

            continue;
        }

        const full = path.join(evalTasksDir(), file);

        try {

            if (fs.statSync(full).size > TASK_FILE_LIMIT) {

                problems.push(`${file} is larger than ${TASK_FILE_LIMIT / 1024} KB.`);

                continue;
            }

            const read = parseTaskFile(name, fs.readFileSync(full, "utf8"));

            if ("problem" in read)
                problems.push(read.problem);
            else
                tasks.push(read);

        } catch (error) {

            problems.push(`${file} could not be read. ${(error as Error).message}`);
        }
    }

    return { tasks, problems };
}

/** Every task on offer: the person's own first, then the built-in ones no own file replaces. */
export function evalTasks(): { tasks: EvalTask[]; problems: string[] } {

    const own = ownTasks();
    const taken = new Set(own.tasks.map(task => task.name.toLowerCase()));

    return { tasks: [...own.tasks, ...builtInTasks().filter(task => !taken.has(task.name.toLowerCase()))], problems: own.problems };
}

/**
 * What is sent for a task: the text as the person left it in the message
 * box, and for a `find` or `fix` task the closing lines under it.
 */
export function taskMessage(text: string, kind: EvalTask["kind"]): string {

    return kind ? `${text.trim()}\n\n${CLOSING[kind]}` : text;
}

/**
 * The findings an agent listed in its answer: every line of every
 * ```findings block. A line that is not `file | line | severity |
 * problem` is skipped, so a half-written block still gives its good lines.
 *
 * @returns `undefined` when the answer has no such block - the variant
 *          was not asked for one, or did not write it. An empty list:
 *          it wrote the block and found nothing.
 */
export function parseFindings(answer: string): EvalFinding[] | undefined {

    const blocks = [...answer.matchAll(/```[ \t]*findings[^\n]*\n([\s\S]*?)(?:```|$)/gi)];

    if (!blocks.length)
        return undefined;

    const findings: EvalFinding[] = [];
    const seen = new Set<string>();

    for (const block of blocks)
        for (const raw of block[1]!.split("\n")) {

            const parts = raw.split("|").map(part => part.trim());

            if (parts.length < 4)
                continue;

            const [file, lineText, severityText] = parts as [string, string, string];
            const problem = parts.slice(3).join(" | ");

            // The form's own first line, when the agent copied it.
            if (!file || !problem || /^file$/i.test(file) || /^-+$/.test(file))
                continue;

            const line = /^\d+$/.test(lineText) ? Number(lineText) : 0;
            const severity = /^(high|medium|low)$/i.test(severityText) ? severityText.toLowerCase() as EvalFinding["severity"] : undefined;
            const shown = file.replace(/\\/g, "/").replace(/^`|`$/g, "").replace(/^\.\//, "");
            const key = `${shown.toLowerCase()}:${line}:${problem.toLowerCase()}`;

            if (seen.has(key) || findings.length >= FINDINGS_LIMIT)
                continue;

            seen.add(key);

            findings.push({ file: shown, line, ...(severity ? { severity } : {}), problem: problem.slice(0, PROBLEM_LIMIT) });
        }

    return findings;
}

/**
 * A finding's file as a path from the variant's folder, when the agent
 * wrote the full path of a file in its copy. Any other path stays as written.
 */
export function findingInFolder(finding: EvalFinding, folder: string): EvalFinding {

    const root = folder.replace(/\\/g, "/").replace(/\/+$/, "");

    return finding.file.toLowerCase().startsWith(`${root.toLowerCase()}/`)
        ? { ...finding, file: finding.file.slice(root.length + 1) }
        : finding;
}
