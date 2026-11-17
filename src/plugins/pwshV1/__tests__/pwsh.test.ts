import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginContext } from "../../../core/plugins/Plugin";
import manifest from "../plugin.json";
import { execute } from "../index";
import { PluginManifest, pluginFromManifest } from "../../../core/plugins/PluginManifest";

let root: string;

beforeEach(() => {

    root = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-pwsh-"));
});

afterEach(() => {

    fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<PluginContext> = {}) {

    const logged: string[] = [];

    const ctx: PluginContext = {
        runId: "run-1",
        taskId: "s#0",
        attempt: 1,
        cwd: root,
        root,
        env: {},
        secret: () => undefined,
        log: text => logged.push(text),
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined,
        ...overrides
    };

    return { ctx, logged, text: () => logged.join("") };
}

describe("pwsh@1", () => {

    const plugin = pluginFromManifest(manifest as PluginManifest, execute as never, "pwshV1");

    it("declares the id and version its reference resolves to", () => {

        expect(plugin.id).toBe("pwsh");
        expect(plugin.version).toBe("1");
    });

    it("runs an inline script and succeeds", async () => {

        const { ctx, text } = context();

        const result = await plugin.execute({ script: "Write-Output 'from-inline'" }, ctx);

        expect(result.success).toBe(true);
        expect(text()).toContain("from-inline");
    });

    it("captures stdout as an output so a later task can read it", async () => {

        const { ctx } = context();

        const result = await plugin.execute({ script: "Write-Output 'captured'" }, ctx);

        expect(result.artifacts?.stdout).toBe("captured");
        expect(result.artifacts?.exitCode).toBe(0);
    });

    it("fails on a non-zero exit and reports the code", async () => {

        const { ctx } = context();

        const result = await plugin.execute({ script: "exit 3" }, ctx);

        expect(result.success).toBe(false);
        expect(result.artifacts?.exitCode).toBe(3);
        expect(result.message).toContain("3");
    });

    it("can be told to ignore a non-zero exit", async () => {

        const { ctx } = context();

        const result = await plugin.execute({ script: "exit 3", ignoreExitCode: true }, ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts?.exitCode).toBe(3);
    });

    it("runs a .ps1 file relative to the working directory", async () => {

        fs.writeFileSync(path.join(root, "hello.ps1"), "Write-Output 'from-file'\n", "utf8");

        const { ctx, text } = context();

        const result = await plugin.execute({ file: "hello.ps1" }, ctx);

        expect(result.success).toBe(true);
        expect(text()).toContain("from-file");
    });

    it("passes additionalArgs to a .ps1 file", async () => {

        fs.writeFileSync(
            path.join(root, "greet.ps1"),
            "param([string]$Name)\nWrite-Output \"hello $Name\"\n",
            "utf8"
        );

        const { ctx, text } = context();

        const result = await plugin.execute({ file: "greet.ps1", additionalArgs: '-Name "World"' }, ctx);

        expect(result.success).toBe(true);
        expect(text()).toContain("hello World");
    });

    it("runs a .ps1 whose path contains a space", async () => {

        const dir = path.join(root, "my scripts");
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "run.ps1"), "Write-Output 'spaced'\n", "utf8");

        const { ctx, text } = context();

        const result = await plugin.execute({ file: "my scripts/run.ps1" }, ctx);

        expect(result.success).toBe(true);
        expect(text()).toContain("spaced");
    });

    it("propagates a failing .ps1's exit code", async () => {

        fs.writeFileSync(path.join(root, "fail.ps1"), "exit 2\n", "utf8");

        const { ctx } = context();

        const result = await plugin.execute({ file: "fail.ps1" }, ctx);

        expect(result.success).toBe(false);
        expect(result.artifacts?.exitCode).toBe(2);
    });

    it("passes env through to the script", async () => {

        const { ctx, text } = context({ env: { MY_VALUE: "from-env" } });

        await plugin.execute({ script: "Write-Output $env:MY_VALUE" }, ctx);

        expect(text()).toContain("from-env");
    });

    it("fails when given neither script nor file", async () => {

        const { ctx } = context();

        const result = await plugin.execute({}, ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("script");
    });

    it("fails when given both script and file, rather than silently preferring one", async () => {

        const { ctx } = context();

        const result = await plugin.execute({ script: "Write-Output 'a'", file: "b.ps1" }, ctx);

        expect(result.success).toBe(false);
    });

    // A cmdlet error is *non-terminating* by default: PowerShell writes it
    // to stderr, leaves $LASTEXITCODE alone, and exits 0. These two are the
    // difference between a task that reports what happened and one that
    // reports success regardless.
    describe("errorActionPreference", () => {

        const failing = "Get-Item 'no-such-file-xyz'";

        it("fails the task on a cmdlet error when set to stop", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ script: failing, errorActionPreference: "stop" }, ctx);

            expect(result.success).toBe(false);
            expect(result.artifacts?.exitCode).not.toBe(0);
        });

        it("lets the same script pass when set to continue", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ script: failing, errorActionPreference: "continue" }, ctx);

            expect(result.success).toBe(true);
        });

        it("defaults to stop in the manifest, so a task that says nothing gets it", () => {

            const declared = manifest.args.find(input => input.name === "errorActionPreference");

            expect(declared?.default).toBe("stop");
            expect(declared?.options).toContain("silentlyContinue");
        });

        it("defaults progress to silentlyContinue, so progress bars stay out of the log", () => {

            const declared = manifest.args.find(input => input.name === "progressPreference");

            expect(declared?.default).toBe("silentlyContinue");
        });
    });

    describe("failOnStderr", () => {

        // Writes to stderr without failing - the case an exit code cannot catch.
        const noisy = "$ErrorActionPreference = 'Continue'; Write-Error 'noise'; exit 0";

        it("fails a zero-exit task that wrote to stderr", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ script: noisy, failOnStderr: true }, ctx);

            expect(result.success).toBe(false);
            expect(result.message).toContain("stderr");
        });

        it("leaves the same task passing when not set", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ script: noisy }, ctx);

            expect(result.success).toBe(true);
        });

        it("captures stderr as an output either way", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ script: noisy }, ctx);

            expect(String(result.artifacts?.stderr)).toContain("noise");
        });
    });

    describe("file validation", () => {

        it("names the missing file rather than letting PowerShell fail on the wrapper", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ file: "nope.ps1" }, ctx);

            expect(result.success).toBe(false);
            expect(result.message).toContain("nope.ps1");
        });

        it("rejects a file that is not a .ps1", async () => {

            fs.writeFileSync(path.join(root, "script.txt"), "Write-Output 'x'\n", "utf8");

            const { ctx } = context();

            const result = await plugin.execute({ file: "script.txt" }, ctx);

            expect(result.success).toBe(false);
            expect(result.message).toContain(".ps1");
        });
    });

    describe("additionalArgs sanitising", () => {

        // `additionalArgs` is written verbatim into the generated script and arrives
        // after template resolution, so a value from an earlier task is
        // code unless something says otherwise.
        const injections = [
            "-Name a; Write-Output 'pwned'",
            "-Name $(Write-Output 'pwned')",
            "-Name a && Write-Output 'pwned'",
            "-Name a | Write-Output",
            "-Name a > out.txt",
            "-Name `a`"
        ];

        it.each(injections)("rejects %j", async injected => {

            fs.writeFileSync(path.join(root, "greet.ps1"), "param([string]$Name)\n", "utf8");

            const { ctx } = context();

            const result = await plugin.execute({ file: "greet.ps1", additionalArgs: injected }, ctx);

            expect(result.success).toBe(false);
            expect(result.message).toContain("additionalArgs");
        });

        it("still allows ordinary quoted arguments", async () => {

            fs.writeFileSync(
                path.join(root, "greet.ps1"),
                "param([string]$Name, [switch]$Loud)\nWrite-Output \"hi $Name\"\n",
                "utf8"
            );

            const { ctx, text } = context();

            const result = await plugin.execute({ file: "greet.ps1", additionalArgs: '-Name "Wor ld" -Loud' }, ctx);

            expect(result.success).toBe(true);
            expect(text()).toContain("hi Wor ld");
        });
    });

    describe("script staging", () => {

        // Counting every .ps1 in the temp directory would race the other
        // suites, which run in parallel and stage scripts of their own.
        // The name carries the run, so look only for this one's.
        it("does not leave its temp script behind", async () => {

            const { ctx } = context({ runId: "cleanup-probe" });

            await plugin.execute({ script: "Write-Output 'x'" }, ctx);

            const left = fs.readdirSync(os.tmpdir()).filter(name => name.includes("cleanup-probe"));

            expect(left).toEqual([]);
        });

        it("runs a script far longer than a command line would carry", async () => {

            // Comfortably past the ~32k Windows command-line limit that a `-Command` route caps out at.
            const padding = "# ".padEnd(40_000, "x");

            const { ctx } = context();

            const result = await plugin.execute({ script: `${padding}\nWrite-Output 'long'` }, ctx);

            expect(result.success).toBe(true);
            expect(result.artifacts?.stdout).toBe("long");
        });

        it("survives quotes that two rounds of parsing would have mangled", async () => {

            const { ctx } = context();

            const result = await plugin.execute(
                { script: `Write-Output 'He said "hello" & left'` },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.artifacts?.stdout).toBe('He said "hello" & left');
        });

        it("keeps non-ASCII intact, which is what the BOM is for", async () => {

            const { ctx } = context();

            const result = await plugin.execute({ script: "Write-Output 'héllo — naïve'" }, ctx);

            expect(result.success).toBe(true);
            expect(result.artifacts?.stdout).toBe("héllo — naïve");
        });
    });

    it("rejects shell: cmd with an explanation rather than running a .ps1 through cmd.exe", async () => {

        const { ctx } = context();

        const result = await plugin.execute({ script: "Write-Output 'x'", shell: "cmd" }, ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("run:");
    });
});
