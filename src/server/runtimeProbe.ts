import { spawn, spawnSync } from "child_process";
import * as os from "os";

import { runnableCommand } from "../core/agent/providers/mcpServers";

/*
 * Checks that a program speaks the Agent Client Protocol before the
 * settings page adds it as a runtime: starts it, sends ACP's first
 * message (`initialize`), and waits for its answer. The program is
 * stopped right after. No session is opened, so nothing is prompted and
 * no credits are used.
 *
 * ACP over stdio is one JSON-RPC message per line, so this needs no SDK.
 */

/** How long the program has to answer. A cold `npx` start can take a while. */
export const PROBE_TIMEOUT_MS = 20_000;

/** ACP's protocol version this build speaks. */
const PROTOCOL_VERSION = 1;

/** What a check found: the agent's own name and version when it gave them, or why it failed. */
export type ProbeResult = { ok: true; name?: string; version?: string } | { problem: string };

/** Starts `command args`, sends `initialize`, and says whether it answered as an ACP agent. */
export function probeAcp(command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeResult> {

    return new Promise(resolve => {

        // Windows: an npm-installed CLI is a `.cmd` shim that only a
        // shell can start - the same fix a chat's runtime gets.
        const runnable = runnableCommand(command, args) ?? { command, args: [...args] };

        let child: ReturnType<typeof spawn>;

        try {

            child = spawn(runnable.command, runnable.args, { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

        } catch (error) {

            return resolve({ problem: `Could not start '${command}': ${(error as Error).message}` });
        }

        let done = false;
        let stdout = "";
        let stderr = "";

        const finish = (result: ProbeResult): void => {

            if (done)
                return;

            done = true;
            clearTimeout(timer);
            stopTree(child);
            resolve(result);
        };

        /** The last of what it wrote on stderr - most programs say there what is wrong. */
        const said = (): string => {

            const tail = stderr.trim().slice(-300);

            return tail ? ` It said: ${tail}` : "";
        };

        const timer = setTimeout(() => finish({
            problem: `'${command}' did not answer ACP's first message within ${Math.round(timeoutMs / 1000)} seconds. `
                + `Check the arguments - many programs need one such as --acp to speak ACP.${said()}`
        }), timeoutMs);

        child.on("error", error => finish({ problem: `Could not start '${command}': ${error.message}` }));

        // "close", not "exit": its last output is read first.
        child.on("close", code => finish({
            problem: `'${command}' stopped (exit code ${code ?? "none"}) before it answered ACP's first message. Check the arguments.${said()}`
        }));

        child.stderr?.on("data", (chunk: Buffer) => {

            stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });

        child.stdout?.on("data", (chunk: Buffer) => {

            stdout += chunk.toString("utf8");

            const lines = stdout.split("\n");

            stdout = lines.pop() ?? "";

            for (const line of lines) {

                const answer = parseLine(line);

                if (!answer || answer.id !== 1)
                    continue;

                if (answer.error)
                    return finish({ problem: `'${command}' refused ACP's first message: ${answer.error.message ?? JSON.stringify(answer.error)}` });

                if (typeof answer.result?.protocolVersion === "number")
                    return finish({
                        ok: true,
                        ...(answer.result.agentInfo?.name ? { name: answer.result.agentInfo.name } : {}),
                        ...(typeof answer.result.agentInfo?.version === "string" && answer.result.agentInfo.version ? { version: answer.result.agentInfo.version } : {})
                    });

                return finish({ problem: `'${command}' answered ACP's first message, but not the way an ACP agent does.` });
            }
        });

        // A program that never reads stdin makes this write fail; the
        // timer or the exit then says what went wrong.
        child.stdin?.on("error", () => undefined);
        child.stdin?.write(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
        }) + "\n");
    });
}

interface Answer {

    id?: unknown;

    result?: { protocolVersion?: unknown; agentInfo?: { name?: string; version?: unknown } };

    error?: { message?: string };
}

/** One stdout line as a JSON-RPC message, or nothing when it is not one - a program may print other text too. */
function parseLine(line: string): Answer | undefined {

    try {

        const value = JSON.parse(line.trim()) as unknown;

        return value && typeof value === "object" ? value as Answer : undefined;

    } catch {

        return undefined;
    }
}

/** Stops the program and what it started. On Windows `cmd` wraps it, so the whole tree goes. */
function stopTree(child: ReturnType<typeof spawn>): void {

    if (child.exitCode !== null || child.pid === undefined)
        return;

    if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else
        child.kill();
}
