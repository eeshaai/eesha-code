import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EnvService } from "../core/env/envService";
import { EnvVars, Shell } from "../core/models/task";

const IS_WINDOWS = process.platform === "win32";

/**
 * What a task with no explicit `shell:` runs through: whatever this OS
 * already provides. `pwsh` must be named with `shell: pwsh`.
 */
function defaultShell(): Shell {

    return IS_WINDOWS ? "cmd" : "bash";
}

/**
 * pwsh.exe on a Windows-Store/winget install resolves through this "app
 * execution alias" folder. A process reads PATH once at launch, so if pwsh
 * was installed after that, the folder is missing from
 * `process.env.PATH` and spawn fails with `spawn pwsh.exe ENOENT`.
 * Appending it fixes that without a restart. Windows-only.
 */
const WINDOWS_APPS_DIR = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps");

export interface ProcessOutput {

    stream: "stdout" | "stderr";

    text: string;
}

export interface RunningProcess {

    /** Resolves with the process exit code once the process has finished. */
    readonly exitCode: Promise<number>;

    /** Requests termination of the process (and its child tree). */
    kill(): void;
}

/**
 * Executes a single shell command as a child process.
 *
 * A task cannot pick an operating system, but executable resolution
 * and process termination are platform-aware.
 * `shell: cmd` is rejected clearly off Windows rather than failing with
 * a bare `ENOENT`.
 */
export class ProcessRunner {

    public start(
        command: string,
        cwd: string,
        onOutput: (output: ProcessOutput) => void,
        shell: Shell = defaultShell(),
        env?: EnvVars
    ): RunningProcess {

        if (shell === "cmd" && !IS_WINDOWS) {

            throw new Error(
                `shell: cmd is only supported on Windows (current platform: ${process.platform}). Use shell: bash instead.`
            );
        }

        this.requireDirectory(cwd);

        // Merge on top of the machine's own environment so commands still
        // see PATH. The snapshot comes through the EnvService, the one
        // module that reads `process.env`.
        const mergedEnv: NodeJS.ProcessEnv = { ...EnvService.machine(), ...env };

        if (IS_WINDOWS)
            this.ensureWindowsAppsOnPath(mergedEnv);

        const child = this.spawnFor(shell, command, cwd, mergedEnv);

        child.stdout?.on("data", data => {

            onOutput({ stream: "stdout", text: data.toString() });
        });

        child.stderr?.on("data", data => {

            onOutput({ stream: "stderr", text: data.toString() });
        });

        const exitCode = new Promise<number>((resolve, reject) => {

            child.on("error", reject);

            // Node reports a signal-killed child as `code: null,
            // signal: "SIGKILL"`. Mapping null to 0 would report an
            // OOM-killed build as success. 128+n is the shells' own
            // convention for death by signal.
            child.on("close", (code, signal) => resolve(
                code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 0)));
        });

        return {

            exitCode,

            kill: () => {

                if (!child.pid) {

                    child.kill();
                    return;
                }

                if (IS_WINDOWS) {

                    // /T kills the whole process tree, /F forces termination.
                    spawn("taskkill", ["/pid", child.pid.toString(), "/t", "/f"]);

                } else {

                    // Negative pid signals the whole process group (see the
                    // `detached: true` below).
                    try {

                        process.kill(-child.pid, "SIGKILL");

                    } catch {

                        child.kill("SIGKILL");
                    }
                }
            }
        };
    }

    /**
     * `cmd.exe` and `bash` already mirror a failing native command's
     * exit code as their own, so only `pwsh` needs the `$LASTEXITCODE`
     * workaround below.
     */
    private spawnFor(shell: Shell, command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {

        if (shell === "cmd")
            return spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true, env });

        if (shell === "bash")
            return spawn(
                "bash",
                ["-c", command],
                {
                    cwd,
                    windowsHide: true,
                    env,
                    // See the pwsh branch below for why this matters for `kill()`.
                    detached: !IS_WINDOWS
                }
            );

        return spawn(
            IS_WINDOWS ? "pwsh.exe" : "pwsh",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", this.withExitCodePropagation(command)],
            {
                cwd,
                windowsHide: true,
                env,
                // On POSIX, run the child as its own process group leader
                // so `kill()` above can signal the whole group. On
                // Windows `taskkill /t` already walks the process tree.
                detached: !IS_WINDOWS
            }
        );
    }

    /**
     * PowerShell does not propagate a failing native command's exit code
     * by default: `pwsh -Command "npm run build"` exits 0 even when npm
     * failed. This makes pwsh's exit code mirror the last native
     * command's. `$LASTEXITCODE` stays `$null` for pure cmdlets, which
     * this leaves alone.
     */
    private withExitCodePropagation(command: string): string {

        return `${command}\nif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }`;
    }

    /**
     * Node reports a missing cwd as `spawn <exe> ENOENT`, the same error
     * it gives when the shell itself is missing. Name the real cause
     * before the spawn.
     */
    private requireDirectory(cwd: string): void {

        const stat = fs.statSync(cwd, { throwIfNoEntry: false });

        if (!stat)
            throw new Error(`Working directory does not exist: ${cwd}`);

        if (!stat.isDirectory())
            throw new Error(`Working directory is not a directory: ${cwd}`);
    }

    /** Appends {@link WINDOWS_APPS_DIR} to PATH in place if it is missing. */
    private ensureWindowsAppsOnPath(env: NodeJS.ProcessEnv): void {

        const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "Path";

        const current = env[pathKey] ?? "";

        if (!current.toLowerCase().includes(WINDOWS_APPS_DIR.toLowerCase())) {

            env[pathKey] = current ? `${current};${WINDOWS_APPS_DIR}` : WINDOWS_APPS_DIR;
        }
    }

}
