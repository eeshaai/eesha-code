import { exec, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { eeshaPath, readJson } from "./paths";
import { packageName, packageVersion } from "./version";

/*
 * Check for a newer Eesha Code and upgrade to it - from the version in
 * the page's footer.
 *
 * Two ways Eesha Code runs, and what "upgrade" means for each:
 *
 *   npm      installed with `npm install -g`. Upgrade = install the
 *            newer version from npm, then start again.
 *   source   run from the repository (build.js is beside dist/, which
 *            the npm package never ships). A click on the version runs
 *            `npm run build` at once, no window and no npm check. The
 *            server builds while it still runs - a failed build leaves
 *            it running - then closes its port and starts the new
 *            dist/server.js itself (server.ts, restart). No helper.
 *
 * The npm install cannot run while the server runs: Windows keeps the
 * loaded koffi file locked, so npm cannot replace it. So a small helper
 * process is started on its own, the server stops, and the helper waits
 * for it to be gone, installs, and starts Eesha Code again.
 *
 * What happened is left in ~/.eesha/upgrade.json - by the helper, or
 * by the server itself before a restart from source. The next server
 * reads it once and tells the page.
 */

/** How this copy of Eesha Code runs. */
export type InstallKind = "npm" | "source";

/** The folder above dist/ - the installed package, or the repository root. */
function packageFolder(): string {

    return path.join(__dirname, "..");
}

export function installKind(): InstallKind {

    return fs.existsSync(path.join(packageFolder(), "build.js")) ? "source" : "npm";
}

/** A version npm can install: 1.2.3, or 1.2.3-beta.1. Anything else is refused - it goes into a command line. */
export function isVersion(text: unknown): text is string {

    return typeof text === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(text);
}

/** Runs a command through the shell (npm is npm.cmd on Windows). Its output, and whether it ended well. */
function run(command: string, cwd: string, timeout: number): Promise<{ ok: boolean; stdout: string; output: string }> {

    return new Promise(resolve => {

        exec(command, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
            resolve({ ok: !error, stdout: stdout.trim(), output: `${stdout}${stderr}`.trim() || (error ? error.message : "") }));
    });
}

/** The last lines of a command's output, for a problem shown on the page. */
function lastLines(text: string, count = 12): string {

    return text.split(/\r?\n/).slice(-count).join("\n");
}

export interface UpdateCheck {

    /** The version running now. */
    current: string;

    kind: InstallKind;

    /** The newest version on npm. Absent when npm could not be asked - see `problem`. */
    latest?: string;

    problem?: string;
}

/** Asks npm for the newest version, with the person's own npm settings (a work registry, a proxy). */
export async function checkForUpdate(): Promise<UpdateCheck> {

    const base = { current: packageVersion(), kind: installKind() };

    const asked = await run(`npm view ${packageName()} version`, packageFolder(), 30_000);

    const latest = asked.stdout.split(/\r?\n/).pop()?.trim();

    if (!asked.ok || !isVersion(latest))
        return { ...base, problem: `Could not ask npm for the newest version.\n${lastLines(asked.output, 6)}` };

    return { ...base, latest };
}

/** Builds from source (`npm run build`). The server keeps running while it does. */
export async function buildFromSource(): Promise<{ ok: true } | { problem: string }> {

    const built = await run("npm run build", packageFolder(), 10 * 60_000);

    return built.ok
        ? { ok: true }
        : { problem: `npm run build failed. Eesha Code keeps running the old build, but dist/ may be half written - fix the error and build again.\n\n${lastLines(built.output)}` };
}

/** What the helper, or a restart from source, leaves for the next server. */
export interface UpgradeResult {

    from: string;

    /** The version asked for; absent for a build from source. */
    to?: string;

    kind: InstallKind;

    /** Set when it failed. */
    problem?: string;

    at: number;
}

function resultFile(): string {

    return eeshaPath("upgrade.json");
}

function helperLog(): string {

    return eeshaPath("logs", "upgrade-output.txt");
}

/*
 * The helper, run with `node -e`. It loads nothing from this package, so
 * npm may replace every file of it. Its one argument is the job as JSON.
 */
const HELPER = `
const { spawnSync } = require("child_process");
const fs = require("fs");
const job = JSON.parse(process.argv[1]);
const log = text => { try { fs.appendFileSync(job.log, new Date().toISOString() + " " + text.replace(/key=[0-9a-f]+/gi, "key=(hidden)") + "\\n"); } catch {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    for (let tries = 0; tries < 150 && alive(job.pid); tries++)
        await wait(200);
    let problem;
    if (alive(job.pid))
        problem = "The old server did not stop, so nothing was installed.";
    else {
        log("Running: " + job.install);
        const installed = spawnSync(job.install, { shell: true, encoding: "utf8", windowsHide: true, cwd: job.home });
        log((installed.stdout || "") + (installed.stderr || ""));
        if (installed.status !== 0)
            problem = "npm install failed (exit " + installed.status + "). The old version is started again. See " + job.log;
    }
    try { fs.writeFileSync(job.result, JSON.stringify({ from: job.from, to: job.to, kind: job.kind, problem, at: Date.now() })); } catch {}
    if (alive(job.pid))
        return;
    log("Starting Eesha Code again.");
    const started = spawnSync(process.execPath, [job.cli, "start", "--no-open"], { encoding: "utf8", windowsHide: true, cwd: job.home });
    log((started.stdout || "") + (started.stderr || ""));
})();
`;

/** Left by a server about to restart after a build from source, for the next one to tell the page. */
export function noteRebuilt(): void {

    fs.writeFileSync(resultFile(), JSON.stringify({ from: packageVersion(), kind: "source", at: Date.now() } satisfies UpgradeResult));
}

/**
 * Installed from npm: starts the helper that waits for this server to
 * stop, installs `version` from npm, and starts Eesha Code again. The
 * caller stops the server right after.
 */
export function startUpgradeHelper(version: string): void {

    fs.mkdirSync(path.dirname(helperLog()), { recursive: true });
    fs.writeFileSync(helperLog(), "");
    fs.rmSync(resultFile(), { force: true });

    const job = {
        pid: process.pid,
        from: packageVersion(),
        to: version,
        kind: installKind(),
        install: `npm install -g ${packageName()}@${version}`,
        cli: path.join(__dirname, "cli.js"),
        home: eeshaPath(),
        log: helperLog(),
        result: resultFile()
    };

    spawn(process.execPath, ["-e", HELPER, JSON.stringify(job)], { detached: true, stdio: "ignore", windowsHide: true, cwd: eeshaPath() }).unref();
}

/** What the helper left, read once: the file is removed. Only one written in the last ten minutes counts. */
export function takeUpgradeResult(): UpgradeResult | undefined {

    const saved = readJson(resultFile()) as Partial<UpgradeResult> | undefined;

    fs.rmSync(resultFile(), { force: true });

    if (!saved || typeof saved.from !== "string" || typeof saved.at !== "number" || Date.now() - saved.at > 10 * 60_000)
        return undefined;

    return {
        from: saved.from,
        kind: saved.kind === "source" ? "source" : "npm",
        at: saved.at,
        ...(typeof saved.to === "string" ? { to: saved.to } : {}),
        ...(typeof saved.problem === "string" ? { problem: saved.problem } : {})
    };
}
