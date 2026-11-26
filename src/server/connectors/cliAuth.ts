import { execFile, spawn } from "child_process";

import { commandOnPath } from "../../core/agent/providers/cliOnPath";
import { EnvService } from "../../core/env/envService";
import type { ConnectorId } from "./config";

/*
 * Sign-in and tokens, through the CLIs the person already uses: `az` for
 * Azure DevOps and `gh` for GitHub.
 *
 * The CLI is used only to sign in and to hand out a token. Everything
 * else goes to the web APIs with that token. The token is kept in this
 * process's memory until it runs out and is never written anywhere. No
 * personal access token is ever asked for.
 */

/** The resource id of Azure DevOps, which `az` hands out tokens for. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

const CLI: Record<ConnectorId, { name: string; install: string }> = {
    ado: { name: "az", install: "Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli - then sign in here." },
    github: { name: "gh", install: "Install the GitHub CLI: https://cli.github.com - then sign in here." }
};

/** How long a call to the CLI may take, sign-in aside. */
const CLI_MS = 60_000;

/** How long a sign-in may wait for the browser. */
const SIGN_IN_MS = 10 * 60_000;

/** What the CLI said, cut to a few lines. */
export class CliError extends Error { }

/** The CLI's full path, or nothing when it is not installed. */
export function findCli(id: ConnectorId): string | undefined {

    return commandOnPath(EnvService.machine(), CLI[id].name);
}

/** How to install the CLI, for the card and the command. */
export function installHint(id: ConnectorId): string {

    return CLI[id].install;
}

/**
 * `az` on Windows is `az.cmd`, which Node can only start through the
 * shell. Every argument here is fixed text of our own, never anything
 * the person or the AI typed, so the shell sees nothing it could run.
 */
function needsShell(command: string): boolean {

    return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * The command as it is started. Through the shell the path goes in
 * quotes: `az.cmd` is usually under "C:\Program Files", and without them
 * the shell stops at the space.
 */
function startable(command: string): string {

    return needsShell(command) ? `"${command}"` : command;
}

function shortText(text: string): string {

    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 6).join("\n");
}

/** Runs the CLI and gives its output. A non-zero exit is a CliError with what it printed. */
function runCli(id: ConnectorId, args: string[]): Promise<string> {

    const command = findCli(id);

    if (!command)
        return Promise.reject(new CliError(installHint(id)));

    return new Promise((resolve, reject) => {

        execFile(startable(command), args, {
            env: { ...EnvService.machine(), GH_PROMPT_DISABLED: "1", AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true" },
            windowsHide: true,
            timeout: CLI_MS,
            maxBuffer: 4 * 1024 * 1024,
            shell: needsShell(command)
        }, (error, stdout, stderr) => {

            if (error)
                return reject(new CliError(shortText(String(stderr || stdout || "")) || error.message));

            resolve(String(stdout));
        });
    });
}

/** Who the CLI is signed in as, or nothing when it is not. */
export async function signedInAs(id: ConnectorId): Promise<string | undefined> {

    try {

        if (id === "ado")
            return (await runCli("ado", ["account", "show", "--query", "user.name", "-o", "tsv"])).trim() || undefined;

        const status = await runCli("github", ["auth", "status", "--hostname", "github.com"]);

        return /account\s+(\S+)/i.exec(status)?.[1] ?? (status.trim() ? "GitHub" : undefined);

    } catch {

        return undefined;
    }
}

interface Token {

    value: string;

    /** Epoch ms after which it is asked for again. */
    until: number;
}

/** Tokens kept in memory, one per connector - see the comment at the top. */
export class Tokens {

    private readonly kept = new Map<ConnectorId, Token>();

    private readonly asking = new Map<ConnectorId, Promise<string>>();

    /** A token for the web APIs. `fresh`: ask the CLI again even when one is kept - after a 401. */
    get(id: ConnectorId, fresh = false): Promise<string> {

        const kept = this.kept.get(id);

        if (!fresh && kept && kept.until > Date.now())
            return Promise.resolve(kept.value);

        let asking = this.asking.get(id);

        if (!asking) {

            asking = this.ask(id).finally(() => this.asking.delete(id));
            this.asking.set(id, asking);
        }

        return asking;
    }

    /** Forgets the kept tokens - after a sign-in, or a Disconnect. */
    forget(id: ConnectorId): void {

        this.kept.delete(id);
    }

    private async ask(id: ConnectorId): Promise<string> {

        if (id === "ado") {

            const text = await runCli("ado", ["account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"]);
            const answer = JSON.parse(text) as { accessToken?: string; expires_on?: number; expiresOn?: string };

            if (!answer.accessToken)
                throw new CliError("az gave no token. Sign in to ADO again.");

            const expires = typeof answer.expires_on === "number"
                ? answer.expires_on * 1000
                : Date.parse(answer.expiresOn ?? "") || Date.now() + 30 * 60_000;

            // Five minutes early, so a long call does not run out halfway.
            this.kept.set("ado", { value: answer.accessToken, until: expires - 5 * 60_000 });

            return answer.accessToken;
        }

        const token = (await runCli("github", ["auth", "token", "--hostname", "github.com"])).trim();

        if (!token)
            throw new CliError("gh gave no token. Sign in to GitHub again.");

        // gh's tokens do not run out on a clock; asked again after an hour anyway.
        this.kept.set("github", { value: token, until: Date.now() + 60 * 60_000 });

        return token;
    }
}

/** What a sign-in shows while it runs. */
export interface SignInProgress {

    /** A line the CLI printed. */
    line?: string;

    /** GitHub's one-time code, to type on the page the browser opened. */
    code?: string;

    /** The page to open when the browser did not open by itself. */
    url?: string;
}

export interface SignIn {

    done: Promise<{ ok: true; account?: string } | { problem: string }>;

    stop(): void;
}

/**
 * The CLI's own sign-in: `az login` or `gh auth login --web`. The browser
 * opens; GitHub's one-time code and its page are passed on as they are
 * printed, so the Connectors page and the terminal can show them.
 */
export function startSignIn(id: ConnectorId, onProgress: (progress: SignInProgress) => void): SignIn {

    const command = findCli(id);

    if (!command)
        return { done: Promise.resolve({ problem: installHint(id) }), stop: () => undefined };

    const args = id === "ado"
        ? ["login", "--allow-no-subscriptions", "--only-show-errors", "-o", "none"]
        : ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"];

    const child = spawn(startable(command), args, {
        env: { ...EnvService.machine(), AZURE_CORE_NO_COLOR: "true" },
        windowsHide: true,
        shell: needsShell(command),
        stdio: ["pipe", "pipe", "pipe"]
    });

    let stopped = false;
    let said = "";

    const read = (part: Buffer) => {

        const text = part.toString("utf8");

        said = (said + text).slice(-4000);

        for (const line of text.split(/\r?\n/).map(one => one.trim()).filter(Boolean)) {

            const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(line)?.[1];
            const url = /(https:\/\/\S+)/.exec(line)?.[1];

            onProgress({ line, ...(code ? { code } : {}), ...(url ? { url } : {}) });

            // gh waits for Enter before it opens the browser.
            if (/press enter/i.test(line) && child.stdin.writable)
                child.stdin.write("\n");
        }
    };

    child.stdout.on("data", read);
    child.stderr.on("data", read);

    const timer = setTimeout(() => child.kill(), SIGN_IN_MS);

    const done = new Promise<{ ok: true; account?: string } | { problem: string }>(resolve => {

        child.on("error", error => resolve({ problem: error.message }));

        child.on("close", async exitCode => {

            clearTimeout(timer);

            if (stopped)
                return resolve({ problem: "Sign-in stopped." });

            if (exitCode !== 0)
                return resolve({ problem: shortText(said) || `Sign-in ended with code ${exitCode}.` });

            resolve({ ok: true, account: await signedInAs(id) });
        });
    });

    return {
        done,
        stop: () => {

            stopped = true;
            child.kill();
        }
    };
}
