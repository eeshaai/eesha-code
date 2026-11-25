// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { argsFor, CommandRuns, findShells, scriptFor, type RunEnd, type Shell } from "../commands";
import { endText, shellFor, shownOutput } from "../../web/runOutput";

/*
 * Run on a command block: the shells found, the script
 * file each one gets, and a real run in the default shell.
 */

describe("the script a shell runs", () => {

    const powershell: Shell = { id: "powershell", label: "PowerShell", program: "powershell.exe", kind: "powershell" };
    const cmd: Shell = { id: "cmd", label: "Command Prompt", program: "cmd.exe", kind: "cmd" };
    const bash: Shell = { id: "bash", label: "bash", program: "/bin/bash", kind: "posix" };

    it("gives PowerShell UTF-8 output, a BOM, and the last program's exit code", () => {

        const script = scriptFor(powershell, "npm test");

        expect(script.ext).toBe(".ps1");
        expect(script.bom).toBe(true);
        expect(script.text).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
        expect(script.text).toContain("npm test\r\nif ($LASTEXITCODE) { exit $LASTEXITCODE }");
        expect(argsFor(powershell, "C:\t\a.ps1")).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\t\a.ps1"]);
    });

    it("turns echo off for cmd and keeps each line", () => {

        const script = scriptFor(cmd, "echo a\ncd");

        expect(script.text).toBe("@echo off\r\nchcp 65001 >nul\r\necho a\r\ncd\r\n");
        expect(argsFor(cmd, "C:\t\a.cmd")).toEqual(["/d", "/c", "C:\t\a.cmd"]);
    });

    it("gives a POSIX shell plain lines", () => {

        expect(scriptFor(bash, "echo a\r\npwd").text).toBe("echo a\npwd\n");
    });

    it("finds at least one shell, and on Windows PowerShell first and never WSL's bash", () => {

        const shells = findShells();

        expect(shells.length).toBeGreaterThan(0);

        if (process.platform === "win32") {

            expect(shells[0]!.kind).toBe("powershell");
            expect(shells.some(shell => /system32[\/]bash\.exe$/i.test(shell.program))).toBe(false);
        }
    });
});

describe("a real run in the default shell", () => {

    it("prints UTF-8 text and ends with the program's exit code; the script file is removed", async () => {

        const shell = findShells()[0]!;
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-run-"));
        const scripts = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-scripts-"));

        const code = shell.kind === "powershell"
            ? "Write-Output 'héllo'\ncmd /c exit 5"
            : shell.kind === "cmd" ? "echo héllo\r\nexit /b 5" : "echo héllo\nexit 5";

        let text = "";

        const ended = new Promise<RunEnd>(resolve => {

            const runs = new CommandRuns((_view, _id, part) => {

                if ("text" in part)
                    text += part.text;
                else
                    resolve(part.done);

            }, scripts);

            runs.start("view-1", shell, code, folder);
        });

        const done = await ended;

        expect(text).toContain("héllo");
        expect(done.code).toBe(5);
        expect(fs.readdirSync(scripts)).toEqual([]);

    }, 30_000);
});

describe("Stop", () => {

    it("ends the run at once, even while a program the shell started still holds its output open", async () => {

        const shell = findShells().find(one => one.kind === "posix") ?? findShells()[0]!;
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-run-"));

        const code = shell.kind === "posix" ? "echo start; sleep 20; echo end"
            : shell.kind === "powershell" ? "Write-Output start; Start-Sleep 20; Write-Output end"
                : "echo start\nping -n 20 127.0.0.1 >nul\necho end";

        let text = "";
        let id = "";
        let started: () => void = () => undefined;
        const printed = new Promise<void>(resolve => { started = resolve; });

        const runs = new CommandRuns((_view, _id, part) => {

            if ("text" in part) {

                text += part.text;

                if (text.includes("start"))
                    started();
            }
            else
                ended(part.done);
        });

        let ended: (done: RunEnd) => void = () => undefined;
        const done = new Promise<RunEnd>(resolve => { ended = resolve; });

        const at = Date.now();

        id = runs.start("view-1", shell, code, folder);

        await printed;

        runs.stop("view-1", id);

        const result = await done;

        expect(result.stopped).toBe(true);
        expect(result.code).toBeNull();
        expect(Date.now() - at).toBeLessThan(10_000);
        expect(text).not.toContain("end");

    }, 30_000);

    const gitBash = process.platform === "win32" ? findShells().find(one => one.id === "gitbash") : undefined;

    // Without this, Stop ends the run but a `sleep` the Git Bash script
    // started keeps running - Windows' tree kill does not see Git Bash's
    // own children.
    it.runIf(gitBash)("ends the programs a Git Bash script started, not only the shell", async () => {

        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-run-"));
        const beat = path.join(folder, "beat.txt").replace(/\\/g, "/");

        let ended: (done: RunEnd) => void = () => undefined;
        const done = new Promise<RunEnd>(resolve => { ended = resolve; });

        const runs = new CommandRuns((_view, _id, part) => { if (!("text" in part)) ended(part.done); });

        // A second Git Bash shell under the script, writing a line every 100 ms.
        const id = runs.start("view-1", gitBash!, `sh -c 'while true; do echo x >> "${beat}"; sleep 0.1; done'`, folder);

        const size = () => fs.existsSync(beat) ? fs.statSync(beat).size : 0;
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        while (size() === 0)
            await wait(100);

        runs.stop("view-1", id);
        await done;
        await wait(500);

        const after = size();

        await wait(1_000);

        expect(size()).toBe(after);

    }, 30_000);
});

describe("what the page shows of a run", () => {

    it("takes out colour codes and shows a rewritten line as it ended", () => {

        expect(shownOutput("\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\ndone")).toBe("ok\n100%\ndone");
    });

    it("starts a block on the shell its language names, unless the last pick is of that kind", () => {

        const windows = [
            { id: "pwsh", label: "PowerShell", kind: "powershell" as const },
            { id: "powershell", label: "Windows PowerShell", kind: "powershell" as const },
            { id: "cmd", label: "Command Prompt", kind: "cmd" as const },
            { id: "gitbash", label: "Git Bash", kind: "posix" as const }
        ];

        expect(shellFor(windows, "powershell", "gitbash")?.id).toBe("pwsh");
        expect(shellFor(windows, "PS1", "powershell")?.id).toBe("powershell");
        expect(shellFor(windows, "bash", undefined)?.id).toBe("gitbash");
        expect(shellFor(windows, "bat", "pwsh")?.id).toBe("cmd");

        // No kind in the language: the last pick, else the first shell.
        expect(shellFor(windows, "shell", "cmd")?.id).toBe("cmd");
        expect(shellFor(windows, "shell", undefined)?.id).toBe("pwsh");

        // A kind not on this machine: the last pick.
        expect(shellFor(windows.slice(0, 3), "bash", "cmd")?.id).toBe("cmd");

        const mac = [
            { id: "zsh", label: "zsh", kind: "posix" as const },
            { id: "bash", label: "bash", kind: "posix" as const },
            { id: "fish", label: "fish", kind: "posix" as const }
        ];

        expect(shellFor(mac, "fish", undefined)?.id).toBe("fish");
        expect(shellFor(mac, "bash", "zsh")?.id).toBe("zsh");
        expect(shellFor(mac, "powershell", "bash")?.id).toBe("bash");
    });

    it("says how a run ended", () => {

        expect(endText({ code: 0, ms: 3200 })).toBe("Exit 0 · 3.2s");
        expect(endText({ code: null, ms: 400, stopped: true })).toBe("Stopped · 400ms");
    });
});
