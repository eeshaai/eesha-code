import * as path from "path";

import { agentRuntime, AgentSessions, coreProviders } from "../core/agent";
import { cdTarget, cleanCommand, type GateCall, type GateDecision, type PermissionGate } from "../core/agent/permissions";
import type { PathJail } from "../core/agent/providers/pathJail";
import { EnvService } from "../core/env/envService";
import { logger } from "../core/logging/logger";
import { PluginHost } from "../core/plugins/PluginHost";
import { buildRegistry } from "../plugins";
import { runSession } from "../sdd/phase/runPhase";

/*
 * The git panel's AI button: one hidden session on the chat's runtime and
 * model writes a commit message for one repository. It finds the changes
 * itself, with read-only git commands, and is deleted once it answered.
 *
 * It never touches the chat: its own session list, its own permission
 * check, nothing written to the chat's history. Nobody is watching it, so
 * it can ask nothing and no permission card is ever shown - the check
 * below either lets a call run or refuses it.
 */

/** Said to the agent when the check refuses a call. */
const REFUSED = "This session only writes a commit message. It may read files in the repository and run read-only git commands "
    + "(status, diff, log, show). Nothing else runs here. Reply with the commit message.";

/** The read-only git commands the session may run. `branch` only to list. */
const GIT_READ = /^(status|diff|log|show|shortlog|rev-parse|ls-files|blame|describe|cat-file|merge-base|name-rev|whatchanged|grep)$/;

/** Plain read-only programs a git command may be piped into. */
const PIPE_READ = /^(head|tail|wc|cat|sort|uniq|grep|findstr|more|select-object|measure-object|out-string)$/i;

/** The words of one command, outside quotes. Good enough to tell what runs - nothing here runs it. */
function words(part: string): string[] {

    return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^["']|["']$/g, ""));
}

/**
 * Whether one command (no chain) only reads: a read-only git command,
 * optionally with `-C <folder inside the repository>`, or a plain reader.
 * No redirection, no substitution, and no `--output` (which writes a file).
 */
export function readOnlyCommand(part: string, root: string): boolean {

    if (/[<>`]|\$\(/.test(part))
        return false;

    const list = words(part.trim());

    if (!list.length)
        return false;

    const program = list[0].replace(/\.exe$/i, "").replace(/^.*[\\/]/, "").toLowerCase();

    if (PIPE_READ.test(program))
        return true;

    if (program !== "git")
        return false;

    let at = 1;

    while (at < list.length && list[at].startsWith("-")) {

        const option = list[at];

        if (option === "-C") {

            const folder = list[at + 1];

            if (!folder || !inside(path.resolve(root, folder), root))
                return false;

            at += 2;

            continue;
        }

        // Never `-c`: a setting given there can run a program.
        if (option === "--no-pager" || option === "-P" || option === "--no-optional-locks")
            at++;
        else
            return false;
    }

    const command = list[at];

    if (!command)
        return false;

    const rest = list.slice(at + 1);

    // Options that write a file or start another program.
    if (rest.some(word => /^--output(=|$)|^--ext-diff$|^--exec|^-O|^--open-files-in-pager/.test(word)))
        return false;

    if (command === "branch")
        return rest.every(word => /^(--show-current|-a|--all|-r|--remotes|-v|-vv|--verbose|--list|--no-color)$/.test(word));

    if (command === "stash")
        return rest[0] === "list" || rest[0] === "show";

    if (command === "config")
        return rest[0] === "--get" || rest[0] === "--list" || rest[0] === "-l";

    return GIT_READ.test(command);
}

function inside(absolute: string, root: string): boolean {

    const relative = path.relative(root, absolute);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether a whole command line only reads: every part does, and a `cd` stays inside the repository. */
export function readOnlyLine(command: string, root: string): boolean {

    const cleaned = cleanCommand(command);

    if (cleaned.onceOnly || !cleaned.parts.length)
        return false;

    let at = root;

    for (const part of cleaned.parts) {

        const target = cdTarget(part, at, (from, to) => path.resolve(from, to));

        if (target !== undefined) {

            if (!inside(target, root))
                return false;

            at = target;

            continue;
        }

        if (!readOnlyCommand(part, at))
            return false;
    }

    return true;
}

/** The check for the hidden session: reads inside the repository and read-only git commands run; everything else is refused. */
export function readOnlyGate(root: string): PermissionGate {

    const deny: GateDecision = { verdict: "deny", reason: REFUSED, note: "refused: the commit message session only reads" };

    return {

        level: () => "auto",

        decide(call: GateCall, jail: PathJail): GateDecision {

            switch (call.what) {

                // Its own to-do list, a helper agent (whose calls come here
                // too) - a question gets "nobody is watching".
                case "housekeeping":
                    return { verdict: "allow" };

                case "read": {

                    const outside = (call.paths ?? []).some(one => typeof one === "string" && one && jail.escape({ paths: [one] }, undefined, false));

                    return outside ? deny : { verdict: "allow" };
                }

                case "command":
                    return call.command && readOnlyLine(call.command, root) ? { verdict: "allow" } : deny;

                default:
                    return deny;
            }
        },

        // Never asked: `decide` never answers "ask".
        answer: () => ({ allow: false, note: "refused" })
    };
}

/** What the session is told. */
export function messagePrompt(root: string): string {

    return [
        `Write a git commit message for the changes in the git repository at ${root}.`,
        "",
        "Find the changes yourself with read-only git commands run in that folder: `git status`, `git diff --staged` and `git diff`. "
        + "If some changes are staged, write the message for the staged changes only. If nothing is staged, write it for all the changes, new files included. "
        + "Read a file in the repository when a diff alone is not clear.",
        "",
        "Do not change any file. Do not stage, commit, or run any command that changes the repository.",
        "",
        "Reply with the commit message only: a first line of at most 72 characters, then, if it helps, a blank line and a short body. "
        + "No quotes, no code fences, no text before or after it."
    ].join("\n");
}

/** The agent's answer as a commit message: no code fence around it, no blank lines at either end. */
export function cleanMessage(text: string): string {

    let message = text.trim();

    const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(message);

    if (fenced)
        message = fenced[1].trim();

    return message.replace(/\r\n/g, "\n");
}

export interface MessageJob {

    /** The session's runtime and model - `ChatController.sideJobAi`. */
    ai: { uses: string; args: Record<string, unknown> };

    root: string;

    /** dist/pluginWorker.js. */
    workerPath: string;

    /** Stops the session when the person clicks the button again. Given the session's stop. */
    onStop(stop: () => void): void;

    /** The person stopped it. */
    stopped(): boolean;
}

/**
 * Runs the hidden session and returns its message. Throws with a reason
 * the panel shows when there is no message. On success the runtime's own
 * record of the session is deleted; otherwise the session is ended.
 */
export async function writeCommitMessage(job: MessageJob): Promise<string> {

    const { registry, failures } = buildRegistry(
        job.workerPath,
        [],
        agentRuntime(
            coreProviders({
                workspaceFolder: () => undefined,
                directories: () => [job.root],
                permissions: () => readOnlyGate(job.root)
            }),

            // Its own list: never held, never seen by the session.
            new AgentSessions()),
        { workspaceFolder: () => undefined });

    for (const failure of failures)
        logger.warning(`Eesha Code: plugin at ${failure.sourcePath} did not load: ${failure.message}`);

    const messages: string[] = [];

    let problem: string | undefined;

    const outcome = await runSession(
        {
            session: "commit-message",
            prompt: messagePrompt(job.root),
            attachments: [],
            title: "commit message",
            ai: {
                uses: job.ai.uses,
                args: {
                    ...job.ai.args,

                    // Deleted once it answered.
                    cleanup: true,

                    // No MCP server is started for it, and none of Claude's
                    // own connectors: it only reads the repository.
                    mcp: { servers: [] },
                    claudeAiConnectors: false
                }
            },
            verbatim: true
        },
        {
            specId: "eesha:git",
            workspace: job.root,
            runId: `eesha:git:${Date.now()}`,
            processEnv: EnvService.machine(),
            onOutput: (line, stream, meta) => {

                if (meta?.kind === "message" && !meta.agent)
                    messages.push(line);
                else if (stream === "stderr" && !meta?.kind && line.trim())
                    problem = line.trim();
            },
            registerKill: kill => job.onStop(() => { void kill(); }),
            isCancelled: () => job.stopped()
        },
        new PluginHost(registry));

    if (job.stopped())
        throw new Error("Stopped.");

    // The last thing the main agent said is its answer.
    const message = cleanMessage(messages.at(-1) ?? "");

    if (!outcome.success)
        throw new Error(problem
            ? `No message: ${problem.replace(/^The agent could not finish:\s*/, "")}`
            : "No message: the runtime gave no reason. The server's log may say more.");

    if (!message)
        throw new Error("The agent answered with no message.");

    return message;
}
