import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";

/*
 * Run on a command block in the chat: the command the
 * agent wrote runs once, in a shell the person picked, in one of the
 * session's folders. What it prints goes back to the page as it comes.
 * Nobody types into it - its input is closed, so a program that waits
 * for an answer gets end-of-input instead of hanging. No real terminal:
 * full-screen programs (vim, top) do not work here.
 *
 * The command is written to a script file and the shell runs that file.
 * That way a command of many lines, or one full of quotes, reaches the
 * shell exactly as the agent wrote it.
 */

/** A shell the page offers. */
export interface Shell {

    /** What the page sends back. */
    id: string;

    /** What the list shows. */
    label: string;

    /** The program. */
    program: string;

    kind: "powershell" | "cmd" | "posix";
}

/** How a run ended. `code` is null when it was stopped or could not start. */
export interface RunEnd {

    code: number | null;

    ms: number;

    stopped?: true;

    problem?: string;
}

/** The longest command the page may send. */
export const COMMAND_LIMIT = 20_000;

/** The shells on this machine, the default one first. */
export function findShells(): Shell[] {

    return process.platform === "win32" ? windowsShells() : posixShells();
}

function windowsShells(): Shell[] {

    const shells: Shell[] = [];

    // PowerShell 7 when it is installed, else the one Windows ships.
    const pwsh = onPath("pwsh.exe");

    if (pwsh)
        shells.push({ id: "pwsh", label: "PowerShell", program: pwsh, kind: "powershell" });

    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const windowsPowerShell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    if (fs.existsSync(windowsPowerShell))
        shells.push({ id: "powershell", label: pwsh ? "Windows PowerShell" : "PowerShell", program: windowsPowerShell, kind: "powershell" });

    shells.push({ id: "cmd", label: "Command Prompt", program: process.env.ComSpec ?? path.join(systemRoot, "System32", "cmd.exe"), kind: "cmd" });

    // Git Bash: next to the git on PATH, or where its installer puts it.
    // Never the `bash.exe` in System32 - that one is WSL.
    const git = onPath("git.exe");
    const bashes = [
        ...(git ? [path.join(path.dirname(git), "..", "bin", "bash.exe")] : []),
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    ];
    const bash = bashes.find(file => fs.existsSync(file));

    if (bash)
        shells.push({ id: "gitbash", label: "Git Bash", program: path.resolve(bash), kind: "posix" });

    return shells;
}

function posixShells(): Shell[] {

    const shells: Shell[] = [];
    const seen = new Set<string>();

    const add = (program: string): void => {

        if (seen.has(program) || !fs.existsSync(program))
            return;

        seen.add(program);
        shells.push({ id: path.basename(program), label: path.basename(program), program, kind: "posix" });
    };

    // The person's own shell first - it is the default.
    if (process.env.SHELL)
        add(process.env.SHELL);

    for (const program of ["/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/usr/bin/fish", "/opt/homebrew/bin/fish", "/bin/sh"])
        if (!shells.some(shell => shell.id === path.basename(program)))
            add(program);

    return shells;
}

/** The full path of a program on PATH, or undefined. */
function onPath(name: string): string | undefined {

    for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {

        if (!folder)
            continue;

        const file = path.join(folder, name);

        if (fs.existsSync(file))
            return file;
    }

    return undefined;
}

/** The script file's text and name ending for a shell. */
export function scriptFor(shell: Shell, code: string): { text: string; ext: string; bom: boolean } {

    switch (shell.kind) {

        case "powershell":
            // UTF-8 out, no progress bars, and the last program's exit
            // code as the run's - what a terminal would show.
            return {
                text: [
                    "$ProgressPreference = 'SilentlyContinue'",
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
                    code,
                    "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
                    ""
                ].join("\r\n"),
                ext: ".ps1",
                // Windows PowerShell reads a file with no BOM as the old code page.
                bom: true
            };

        case "cmd":
            return { text: ["@echo off", "chcp 65001 >nul", ...code.split(/\r?\n/), ""].join("\r\n"), ext: ".cmd", bom: false };

        default:
            return { text: code.replace(/\r\n/g, "\n") + "\n", ext: ".sh", bom: false };
    }
}

/** How the shell is started on the script file. */
export function argsFor(shell: Shell, file: string): string[] {

    switch (shell.kind) {

        case "powershell":
            // Bypass is for this one process only: no setting is changed.
            return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];

        case "cmd":
            return ["/d", "/c", file];

        default:
            // Git Bash takes a Windows path with forward slashes.
            return [process.platform === "win32" ? file.replace(/\\/g, "/") : file];
    }
}

interface Run {

    id: string;

    /** The page that started it. */
    view: string;

    stop(): void;
}

/**
 * The runs going now. Output and the end are handed to `send` with the
 * id of the page that started the run; the server finds that page's
 * stream when it sends, so a stream that reconnects keeps getting it.
 */
export class CommandRuns {

    private readonly runs = new Map<string, Run>();

    private next = 1;

    constructor(
        private readonly send: (view: string, id: string, part: { text: string } | { done: RunEnd }) => void,
        private readonly scriptFolder: string = path.join(os.tmpdir(), "eesha-runs")) {
    }

    /** Starts `code` in `folder` with `shell`. Gives the run's id; what it prints comes through `send`. */
    start(view: string, shell: Shell, code: string, folder: string): string {

        const id = `run-${this.next++}`;
        const started = Date.now();
        const script = scriptFor(shell, code);
        const file = path.join(this.scriptFolder, `${process.pid}-${id}${script.ext}`);

        // Git Bash on Windows: the programs the shell starts are tracked
        // by Git Bash itself, and Windows' tree kill does not reach them
        // (a `sleep` outlived Stop). The shell writes its own Git Bash
        // process id first, so Stop can end its whole group the Git Bash
        // way - see `stopGitBashGroup`.
        const pidFile = process.platform === "win32" && shell.kind === "posix" ? `${file}.pid` : undefined;

        if (pidFile)
            script.text = `echo $$ > '${pidFile.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n${script.text}`;

        let ended = false;
        let stopped = false;

        const end = (result: Omit<RunEnd, "ms">): void => {

            if (ended)
                return;

            ended = true;
            this.runs.delete(id);

            try {

                fs.rmSync(file, { force: true });

                if (pidFile)
                    fs.rmSync(pidFile, { force: true });

            } catch {

                // Still held open for a moment on Windows - the temp folder is cleaned by the system.
            }

            this.send(view, id, { done: { ...result, ms: Date.now() - started, ...(stopped ? { stopped: true } : {}) } });
        };

        let child: ReturnType<typeof spawn> | undefined;

        try {

            fs.mkdirSync(this.scriptFolder, { recursive: true });
            fs.writeFileSync(file, (script.bom ? "\uFEFF" : "") + script.text, "utf8");

            child = spawn(shell.program, argsFor(shell, file), {
                cwd: folder,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                // Its own process group, so Stop takes what it started too.
                detached: process.platform !== "win32"
            });

        } catch (error) {

            // Sent after the id is handed back, so the page knows the run.
            setImmediate(() => end({ code: null, problem: (error as Error).message }));

            return id;
        }

        const running = child;

        this.runs.set(id, {
            id,
            view,
            stop: () => {

                if (ended)
                    return;

                stopped = true;

                if (pidFile)
                    stopGitBashGroup(shell, pidFile);

                stopTree(running);

                // Ended now, not when the pipes close: a program Git Bash
                // started can outlive the shell and hold them open.
                running.stdout?.destroy();
                running.stderr?.destroy();
                end({ code: null });
            }
        });

        // One decoder per stream, so a character split across two chunks stays whole.
        for (const stream of [running.stdout, running.stderr]) {

            const decoder = new StringDecoder("utf8");

            stream?.on("data", (chunk: Buffer) => {

                const text = decoder.write(chunk);

                if (text)
                    this.send(view, id, { text });
            });
        }

        running.on("error", error => end({ code: null, problem: error.message }));
        running.on("close", code => end({ code: stopped ? null : code }));

        return id;
    }

    /** Stops one run - only for the page that started it. */
    stop(view: string, id: string): void {

        const run = this.runs.get(id);

        if (run && run.view === view)
            run.stop();
    }

    /** Stops every run a page started - the page is gone. */
    stopView(view: string): void {

        for (const run of [...this.runs.values()])
            if (run.view === view)
                run.stop();
    }

    stopAll(): void {

        for (const run of [...this.runs.values()])
            run.stop();
    }

    /** Whether a page has a run going. */
    has(view: string): boolean {

        return [...this.runs.values()].some(run => run.view === view);
    }
}

/**
 * Ends every program a Git Bash script started, by the group of the
 * shell's own Git Bash process id (written to `pidFile` as the script's
 * first line), with Git Bash's own `kill`. Nothing when the id was not
 * written yet or `kill.exe` is not beside the shell.
 */
function stopGitBashGroup(shell: Shell, pidFile: string): void {

    try {

        const id = fs.readFileSync(pidFile, "utf8").trim();

        if (!/^\d+$/.test(id))
            return;

        const kill = path.resolve(path.dirname(shell.program), "..", "usr", "bin", "kill.exe");

        if (fs.existsSync(kill))
            spawnSync(kill, ["-9", "--", `-${id}`], { windowsHide: true, stdio: "ignore" });

    } catch {

        // No id yet - the shell had not started; the tree kill below does the rest.
    }
}

/** Stops the shell and everything it started. */
function stopTree(child: ReturnType<typeof spawn>): void {

    if (child.exitCode !== null || child.pid === undefined)
        return;

    if (process.platform === "win32") {

        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
    }

    try {

        // The minus: the whole process group.
        process.kill(-child.pid, "SIGTERM");

    } catch {

        child.kill("SIGTERM");
    }
}
