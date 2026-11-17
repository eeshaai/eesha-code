import { type ChildProcess, execFileSync, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { expect, type Page } from "@playwright/test";

/*
 * Starts Eesha Code for a test file.
 *
 * The server runs from dist/ on a throwaway home folder: its own
 * ~/.eesha with settings that turn on the fake runtime and SDD, and a
 * fixed key so the page can be opened with ?key=. A small git repository
 * in that home is the folder the tests work in.
 */

/** The repository root - where dist/cli.js is. */
const ROOT = path.resolve(__dirname, "..");

export interface Eesha {

    /** The page's address with the key, for the first visit. */
    url: string;

    /** The server's address, no key. */
    origin: string;

    /** The throwaway home folder. */
    home: string;

    /** A git repository with one commit, for workspaces. */
    work: string;

    /** Everything the server printed so far. */
    output(): string;

    stop(): Promise<void>;
}

/** A port nothing listens on now. */
async function freePort(): Promise<number> {

    return new Promise((resolve, reject) => {

        const server = net.createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {

            const port = (server.address() as net.AddressInfo).port;

            server.close(() => resolve(port));
        });
    });
}

/** A folder with a git repository and one commit. */
function makeRepository(folder: string): void {

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "readme.txt"), "A test repository.\n");

    const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });

    git("init", "-q", "-b", "master");

    // The throwaway home has no git name or email, so the repository has its own.
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");

    git("add", ".");
    git("commit", "-q", "-m", "First commit");
}

/** Starts the server and waits until it listens. */
export async function startEesha(settings: Record<string, unknown> = {}): Promise<Eesha> {

    if (!fs.existsSync(path.join(ROOT, "dist", "cli.js")))
        throw new Error("dist/cli.js is missing. Run `npm run build` first.");

    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-e2e-")));
    const profile = path.join(home, ".eesha");
    const work = path.join(home, "work");
    const port = await freePort();
    const key = crypto.randomBytes(24).toString("hex");

    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "key"), key + "\n");
    fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
        eesha: { port },
        features: { fakeRuntime: true, "Feature-SDD": true },
        ...settings
    }, null, 2));

    makeRepository(work);

    const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, "dist", "cli.js"), "run"], {
        cwd: os.tmpdir(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let printed = "";

    child.stdout?.on("data", chunk => printed += String(chunk));
    child.stderr?.on("data", chunk => printed += String(chunk));

    await new Promise<void>((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(`Eesha Code did not start in time:\n${printed}`)), 30_000);

        const check = () => {

            if (printed.includes("listening on")) {

                clearTimeout(timer);
                resolve();
            }
        };

        child.stdout?.on("data", check);
        child.on("exit", code => {

            clearTimeout(timer);
            reject(new Error(`Eesha Code stopped (exit code ${code}):\n${printed}`));
        });
    });

    const origin = `http://127.0.0.1:${port}`;

    return {
        url: `${origin}/?key=${key}`,
        origin,
        home,
        work,
        output: () => printed,
        stop: async () => {

            if (child.exitCode === null) {

                const exited = new Promise(resolve => child.once("exit", resolve));

                // The server and every program it started (git, runtimes):
                // on Windows a plain kill leaves the children holding the folder.
                if (process.platform === "win32" && child.pid)
                    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { child.kill(); }
                else
                    child.kill();

                await exited;
            }

            try {

                fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

            } catch (error) {

                // A folder still held open is left in the temp folder; the test result stands.
                console.warn(`Could not remove ${home}: ${(error as Error).message}`);
            }
        }
    };
}

/** Collects the page's console errors, to check none came. */
export function consoleErrors(page: Page): string[] {

    const errors: string[] = [];

    page.on("console", message => {

        if (message.type() === "error")
            errors.push(message.text());
    });

    page.on("pageerror", error => errors.push(error.message));

    return errors;
}

/** Picks a runtime in the compose row's Runtime menu. */
export async function pickRuntime(page: Page, runtime: string): Promise<void> {

    await page.getByRole("button", { name: /^Runtime:/ }).click();
    await page.getByRole("menuitemradio", { name: runtime, exact: true }).click();
    await expect(page.getByRole("button", { name: `Runtime: ${runtime}` })).toBeVisible();
}

/** Adds a workspace through the Add workspace window, by typing its folder. */
export async function addWorkspace(page: Page, folder: string): Promise<void> {

    await page.getByRole("button", { name: "Add workspace" }).last().click();

    const dialog = page.getByRole("dialog");

    await dialog.getByRole("combobox", { name: "Main folder" }).click();
    // The folder list opens outside the window.
    await page.getByText(/Browse for another/).click();

    // Typed at once, before the first folder list comes: the list must not wipe it.
    await dialog.getByRole("textbox", { name: "Folder path" }).fill(folder);
    await dialog.getByRole("textbox", { name: "Folder path" }).press("Enter");
    await dialog.getByRole("button", { name: "Use this folder" }).click();
    await dialog.getByRole("button", { name: "Add workspace" }).click();

    await expect(dialog).toBeHidden();
}
