import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { ConsoleSink } from "serilogger";

import { usePlanChecker } from "../core/agent/providers/planTools";
import { useProfileDirectory } from "../core/loader/profilePaths";
import { planChecker } from "../sdd/documents/planCheck";
import { createFileSink } from "../core/logging/fileSink";
import { flushLogs, logger, messageOf, setLogSinks } from "../core/logging/logger";
import { EeshaServer } from "./EeshaServer";
import { FileStore } from "./fileStore";
import { eeshaHome, eeshaPath } from "./paths";
import { ensureKey } from "./security";
import { removeServerFile, writeServerFile } from "./serverFile";
import { readServerSettings } from "./settings";
import { takeUpgradeResult } from "./update";

/*
 * The server process: `node dist/server.js`. Started in the background by
 * `eesha start`, or in this terminal by `eesha run`
 * (`--foreground`, which also logs to the terminal).
 *
 * The engine is pointed at ~/.eesha before anything reads a setting,
 * so settings, chats and model lists all live there.
 */

async function main(): Promise<void> {

    const foreground = process.argv.includes("--foreground");

    useProfileDirectory(eeshaHome());

    fs.mkdirSync(eeshaHome(), { recursive: true });

    const logs = eeshaPath("logs");

    setLogSinks(...(foreground ? [createFileSink(logs), new ConsoleSink()] : [createFileSink(logs)]));

    // One failed promise or a throw inside some event handler must not
    // end every chat the server holds. Written down, and the server goes on.
    process.on("unhandledRejection", reason => logger.error(`Eesha Code: unhandled failure. ${messageOf(reason)}`));
    process.on("uncaughtException", error => logger.critical(`Eesha Code: uncaught error. ${error.stack ?? error.message}`));

    const settings = readServerSettings();

    for (const problem of settings.problems)
        logger.warning(`Eesha Code: settings.json: ${problem}`);

    // Left by the helper of an upgrade started from the page: the page is told how it went.
    const upgraded = takeUpgradeResult();

    if (upgraded)
        logger.info(`Eesha Code: started after an upgrade from ${upgraded.from}${upgraded.problem ? ` - it failed: ${upgraded.problem}` : ""}.`);

    let stopping = false;

    /** Closes and exits. With `restart`, the new dist/server.js is started once the port is free - after a build from source. */
    const stop = async (why: string, restart = false): Promise<void> => {

        if (stopping)
            return;

        stopping = true;

        logger.info(`Eesha Code: ${restart ? "restarting" : "stopping"} (${why}).`);

        try {

            await server.close();

        } finally {

            removeServerFile(process.pid);

            if (restart)
                startAgain();

            await flushLogs();

            process.exit(0);
        }
    };

    // The plan reader behind the Tasks phase's `check_plan` tool. The
    // engine cannot import SDD, so the host hands it in. Without it every check said "No
    // plan checker is registered".
    usePlanChecker(planChecker);

    const server = new EeshaServer({
        port: settings.port,
        theme: settings.theme,
        fontSize: settings.fontSize,
        key: ensureKey(),
        webRoot: path.join(__dirname, "web"),
        workerPath: path.join(__dirname, "pluginWorker.js"),

        // SDD's built-in styles: copied beside server.js by the build.
        resources: path.join(__dirname, "resources"),
        logPlace: `The Eesha Code log (${logs})`,
        store: new FileStore(eeshaPath("state.json")),
        onStop: () => void stop("eesha stop"),
        onRestart: () => void stop("built from source", true),
        upgraded
    });

    try {

        await server.listen();

    } catch (error) {

        const text = `Eesha Code: could not listen on 127.0.0.1:${settings.port}. ${messageOf(error)}`
            + ((error as NodeJS.ErrnoException).code === "EADDRINUSE"
                ? " Another program uses that port - set eesha.port in ~/.eesha/settings.json."
                : "");

        // To the terminal output file too: `eesha start` shows it.
        console.error(text);
        logger.critical(text);

        await flushLogs();

        process.exit(1);
    }

    writeServerFile({ pid: process.pid, port: server.port, startedAt: Date.now() });

    logger.info(`Eesha Code: listening on http://127.0.0.1:${server.port} (pid ${process.pid}).`);

    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
        process.on(signal, () => void stop(signal));
}

/**
 * Starts dist/server.js again, in the background, the way `eesha start`
 * does: its terminal output to logs/server-output.txt. Started from
 * `eesha run` too - the terminal's run then ends and this one goes on.
 */
function startAgain(): void {

    try {

        const output = fs.openSync(eeshaPath("logs", "server-output.txt"), "w");

        spawn(process.execPath, [path.join(__dirname, "server.js")], {
            detached: true,
            stdio: ["ignore", output, output],
            windowsHide: true,
            cwd: eeshaHome()
        }).unref();

        fs.closeSync(output);

    } catch (error) {

        logger.critical(`Eesha Code: could not start again after the build. Run eesha start. ${messageOf(error)}`);
    }
}

void main();
