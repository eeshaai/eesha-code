import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

import { findCli, installHint, signedInAs, startSignIn } from "./connectors/cliAuth";
import { ADO_SOURCES, CONNECTOR_IDS, GITHUB_SOURCES, readConnectors, saveConnector, type ConnectorId } from "./connectors/config";
import { runMcpBridge } from "./connectors/mcpBridge";
import { remotesOf } from "./connectors/remotes";
import { checkThisMachine, doctorLine, doctorReport } from "./doctor";
import { eeshaHome, eeshaPath } from "./paths";
import { ensureKey, KEY_HEADER } from "./security";
import { readServerFile, removeServerFile } from "./serverFile";
import { readServerSettings } from "./settings";
import { packageVersion } from "./version";

/*
 * The `eesha` command.
 *
 *   eesha start [--no-open]  starts the server in the background and opens the page
 *   eesha stop               stops it - every turn in flight is stopped too
 *   eesha status             says whether it runs, and prints the link again
 *   eesha open               opens the page in the browser
 *   eesha run                runs the server in this terminal; Ctrl+C stops it
 *   eesha doctor             says which runtimes' programs are on this machine
 *   eesha connect <ado|github>  signs in through az or gh, and connects
 *   eesha mcp --chat <id>          the connector tools for a runtime - started by the runtime, not by hand
 *   eesha --version          prints the version
 */

const USAGE = `Eesha Code - a session with AI coding agents in a browser tab.

  eesha start [--no-open]  Start the server in the background and open the page.
  eesha stop               Stop the server. A turn still running is stopped.
  eesha status             Say whether the server runs, and print its link.
  eesha open               Open the page in the browser.
  eesha run                Run the server in this terminal. Ctrl+C stops it.
  eesha doctor             Say which runtimes' programs are on this machine.
  eesha connect ado        Sign in to Azure DevOps through az, and connect it.
  eesha connect github     Sign in to GitHub through gh, and connect it.
  eesha --version          Print the version.

Files: ${eeshaHome()}
Settings: ${eeshaPath("settings.json")} - "eesha": { "port": 7420, "theme": "dark", "fontSize": 16 }`;

/** What the server said about itself, or nothing when it does not answer. */
interface Status {

    pid: number;

    port: number;

    tabs: number;

    chats: number;

    working: number;
}

/** The terminal output of a server started in the background - where a crash before logging starts lands. */
function outputFile(): string {

    return eeshaPath("logs", "server-output.txt");
}

function link(port: number, key: string): string {

    return `http://127.0.0.1:${port}/?key=${key}`;
}

/** One request to the server's control address, with the key. */
function control(port: number, key: string, method: "GET" | "POST", route: string): Promise<unknown> {

    return new Promise((resolve, reject) => {

        const request = http.request({
            host: "127.0.0.1",
            port,
            method,
            path: route,
            headers: { [KEY_HEADER]: key },
            timeout: 3000
        }, response => {

            const parts: Buffer[] = [];

            response.on("data", (part: Buffer) => parts.push(part));
            response.on("end", () => {

                if (response.statusCode !== 200)
                    return reject(new Error(`The server answered ${response.statusCode}.`));

                try {

                    resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));

                } catch {

                    reject(new Error("The server's answer was not JSON."));
                }
            });
        });

        request.on("timeout", () => request.destroy(new Error("The server did not answer.")));
        request.on("error", reject);
        request.end();
    });
}

/** The running server's status, or nothing. A server.json left by a crash is removed. */
async function running(key: string): Promise<Status | undefined> {

    const saved = readServerFile();

    if (!saved)
        return undefined;

    try {

        return await control(saved.port, key, "GET", "/control/status") as Status;

    } catch {

        if (!alive(saved.pid))
            removeServerFile(saved.pid);

        return undefined;
    }
}

function alive(pid: number): boolean {

    try {

        process.kill(pid, 0);

        return true;

    } catch (error) {

        // EPERM: it runs, as someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function wait(ms: number): Promise<void> {

    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Opens the link in the default browser. */
function openInBrowser(url: string): void {

    const [command, args] = process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];

    try {

        spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();

    } catch {

        console.log("Could not open the browser - open the link above yourself.");
    }
}

function printRunning(status: Status, key: string): void {

    console.log(`Eesha Code is running (pid ${status.pid}).`);
    console.log(`  Open:  ${link(status.port, key)}`);
    console.log(`  Sessions: ${status.chats} open, ${status.working} working, ${status.tabs} browser tab(s).`);
    console.log(`  Log:   ${eeshaPath("logs")}`);
    console.log("  Stop:  eesha stop");
}

async function start(open: boolean): Promise<number> {

    const key = ensureKey();

    const already = await running(key);

    if (already) {

        console.log("Already running.");
        printRunning(already, key);

        if (open)
            openInBrowser(link(already.port, key));

        return 0;
    }

    const settings = readServerSettings();

    for (const problem of settings.problems)
        console.log(`settings.json: ${problem}`);

    // A first start: which runtimes can run here at all, before a turn
    // fails on a program that is not installed.
    if (!fs.existsSync(eeshaPath("settings.json"))) {

        console.log(`No ${eeshaPath("settings.json")} yet - the runtimes use their built-in defaults.`);
        console.log(doctorLine((await checkThisMachine()).checks));
    }

    fs.mkdirSync(path.dirname(outputFile()), { recursive: true });

    const output = fs.openSync(outputFile(), "w");

    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
        detached: true,
        stdio: ["ignore", output, output],
        windowsHide: true,
        cwd: eeshaHome()
    });

    fs.closeSync(output);

    let exited: number | null | undefined;

    child.on("exit", code => { exited = code; });
    child.unref();

    // Up to 20 seconds for it to answer.
    for (let tries = 0; tries < 100; tries++) {

        await wait(200);

        if (exited !== undefined) {

            console.error(`Eesha Code did not start (exit ${exited}).`);

            const said = fs.existsSync(outputFile()) ? fs.readFileSync(outputFile(), "utf8").trim() : "";

            if (said)
                console.error(said);

            console.error(`More in ${eeshaPath("logs")}.`);

            return 1;
        }

        const status = await running(key);

        if (status) {

            printRunning(status, key);

            if (open)
                openInBrowser(link(status.port, key));

            return 0;
        }
    }

    console.error(`Eesha Code started but does not answer. See ${eeshaPath("logs")}.`);

    return 1;
}

async function stop(): Promise<number> {

    const key = ensureKey();

    const saved = readServerFile();

    if (!saved) {

        console.log("Not running.");

        return 0;
    }

    try {

        await control(saved.port, key, "POST", "/control/stop");

    } catch {

        // Not answering: a hung process is ended below.
    }

    for (let tries = 0; tries < 50 && alive(saved.pid); tries++)
        await wait(200);

    if (alive(saved.pid)) {

        console.log("The server did not stop by itself - ending its process.");

        try {

            process.kill(saved.pid);

        } catch (error) {

            console.error(`Could not end process ${saved.pid}: ${(error as Error).message}`);

            return 1;
        }
    }

    removeServerFile(saved.pid);

    console.log("Stopped.");

    return 0;
}

async function status(): Promise<number> {

    const key = ensureKey();

    const found = await running(key);

    if (!found) {

        console.log("Not running. Start it with: eesha start");

        return 1;
    }

    printRunning(found, key);

    return 0;
}

async function openPage(): Promise<number> {

    const key = ensureKey();

    const found = await running(key);

    if (!found) {

        console.log("Not running. Start it with: eesha start");

        return 1;
    }

    openInBrowser(link(found.port, key));

    return 0;
}

/** The server in this terminal, logging here too. Its exit code is this command's. */
function runHere(): number {

    const key = ensureKey();
    const settings = readServerSettings();

    console.log(`Eesha Code on ${link(settings.port, key)} - Ctrl+C stops it.`);

    const result = spawnSync(process.execPath, [path.join(__dirname, "server.js"), "--foreground"], { stdio: "inherit" });

    return result.status ?? 1;
}

/**
 * `eesha connect ado|github`: signs in through the
 * CLI when it is not signed in yet, then connects. With no choices saved
 * yet, what this folder's git remotes point to is put in reach, every
 * source on Read. Write access and more reach are chosen on the settings
 * page, Connectors.
 */
async function connect(id: string | undefined): Promise<number> {

    if (!CONNECTOR_IDS.includes(id as ConnectorId)) {

        console.error("Say which: eesha connect ado, or eesha connect github.");

        return 2;
    }

    const connector = id as ConnectorId;

    if (!findCli(connector)) {

        console.error(installHint(connector));

        return 1;
    }

    let account = await signedInAs(connector);

    if (account)
        console.log(`Already signed in as ${account}.`);
    else {

        console.log(connector === "ado" ? "Signing in with az login - a browser window opens." : "Signing in with gh auth login - a browser window opens.");

        const signIn = startSignIn(connector, progress => {

            if (progress.code)
                console.log(`One-time code: ${progress.code}${progress.url ? ` - enter it at ${progress.url}` : ""}`);
            else if (progress.line)
                console.log(`  ${progress.line}`);
        });

        const done = await signIn.done;

        if ("problem" in done) {

            console.error(done.problem);

            return 1;
        }

        account = done.account;
        console.log(`Signed in${account ? ` as ${account}` : ""}.`);
    }

    if (readConnectors()[connector]) {

        console.log("Connected already. Change what is in reach and allowed on the Connectors page.");

        return 0;
    }

    const found = await remotesOf([process.cwd()]);

    const saved = connector === "ado"
        ? await saveConnector("ado", { reach: found.ado, sources: Object.fromEntries(ADO_SOURCES.map(source => [source, "read"])) as never })
        : await saveConnector("github", { reach: found.github, sources: Object.fromEntries(GITHUB_SOURCES.map(source => [source, "read"])) as never });

    if ("problem" in saved) {

        console.error(saved.problem);

        return 1;
    }

    const reach = connector === "ado" ? found.ado.map(one => `${one.org}/${one.project}`) : found.github;

    console.log(`Connected, every source on Read. In reach: ${reach.length ? reach.join(", ") : "nothing yet - add it on the Connectors page"}.`);
    console.log("Sessions started from now on get the connector tools.");

    return 0;
}

async function main(): Promise<number> {

    const [command, ...rest] = process.argv.slice(2);

    switch (command) {

        case "start":
            return start(!rest.includes("--no-open"));

        case "stop":
            return stop();

        case "status":
            return status();

        case "open":
            return openPage();

        case "run":
            return runHere();

        case "doctor": {

            const result = await checkThisMachine();

            console.log(doctorReport(result));

            // Fails when nothing can run, so a script can tell.
            return result.checks.some(check => check.found) ? 0 : 1;
        }

        case "connect":
            return connect(rest[0]);

        case "mcp": {

            const at = rest.indexOf("--chat");
            const chatId = at >= 0 ? rest[at + 1] : undefined;

            if (!chatId) {

                console.error("eesha mcp --chat <id> is started by a runtime for the connector tools.");

                return 2;
            }

            return runMcpBridge(chatId);
        }

        case "--version":
        case "-v":
        case "version":
            console.log(packageVersion());
            return 0;

        case undefined:
        case "help":
        case "--help":
        case "-h":
            console.log(USAGE);
            return 0;

        default:
            console.error(`Unknown command: ${command}\n`);
            console.error(USAGE);
            return 2;
    }
}

main().then(code => process.exit(code), error => {

    console.error((error as Error).message);
    process.exit(1);
});
