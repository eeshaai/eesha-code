import { spawn, spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";

import { EnvService } from "../core/env/envService";
import { loadEngineSettings } from "../core/settings/engineSettings";
import { checkRuntimes } from "./doctor";
import { probeAcp } from "./runtimeProbe";

/*
 * Which version of a runtime's program is on this machine - written down
 * for each variant of an evaluation when its one message is sent, so a
 * report read months later says what each variant ran on.
 *
 * Claude and Copilot (the two built in on their SDKs) are asked with
 * `--version`. An ACP agent is asked the ACP way first: its answer to the
 * first message can name its version (see runtimeProbe.ts). When it does
 * not, its program is asked with `--version`. No session is opened, so
 * nothing is prompted and no credits are used.
 */

/** How long a program has to say its version. */
const VERSION_TIMEOUT_MS = 10_000;

/** A version line is short; anything longer is cut. */
const VERSION_LIMIT = 80;

/** The version of runtime `id`'s program, or nothing when it could not be found out. Never throws. */
export async function runtimeVersion(id: string): Promise<string | undefined> {

    try {

        const settings = await loadEngineSettings(undefined);
        const env = EnvService.machine();

        if (id === "claude" || id === "ghcp") {

            const found = checkRuntimes([id], settings.ai.acpAgents, env)[0]?.found;

            return found ? await askVersion(found, env) : undefined;
        }

        const agent = settings.ai.acpAgents[id]?.agent as { command?: unknown; args?: unknown } | undefined;

        if (!agent || typeof agent.command !== "string" || !agent.command)
            return undefined;

        const args = Array.isArray(agent.args) ? agent.args.filter((one): one is string => typeof one === "string") : [];
        const probed = await probeAcp(agent.command, args, env, VERSION_TIMEOUT_MS);

        if ("ok" in probed && probed.version)
            return oneLine(probed.version);

        // Not every agent names its version in ACP (Kiro does not): its program is asked instead.
        const found = checkRuntimes([id], settings.ai.acpAgents, env)[0]?.found;

        return found ? await askVersion(found, env) : undefined;

    } catch {

        return undefined;
    }
}

/** Runs `program --version` and takes the first line it prints. */
function askVersion(program: string, env: Record<string, string>): Promise<string | undefined> {

    return new Promise(resolve => {

        // Windows: an npm-installed CLI is a `.cmd` shim that only a shell can start.
        const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(path.extname(program));
        const child = shim
            ? spawn("cmd", ["/c", program, "--version"], { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
            : spawn(program, ["--version"], { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

        let out = "";
        let done = false;

        const finish = (value: string | undefined): void => {

            if (done)
                return;

            done = true;
            clearTimeout(timer);

            if (child.exitCode === null && child.pid !== undefined) {

                if (process.platform === "win32")
                    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
                else
                    child.kill();
            }

            resolve(value);
        };

        const timer = setTimeout(() => finish(undefined), VERSION_TIMEOUT_MS);

        child.on("error", () => finish(undefined));
        child.stdout?.on("data", (chunk: Buffer) => { out = (out + chunk.toString("utf8")).slice(0, 2000); });
        child.on("close", () => finish(oneLine(out)));
    });
}

/** The first line that has text, cut short. Nothing for none. */
export function oneLine(text: string): string | undefined {

    const line = text.split(/\r?\n/).map(one => one.trim()).find(one => one);

    return line ? line.slice(0, VERSION_LIMIT) : undefined;
}
