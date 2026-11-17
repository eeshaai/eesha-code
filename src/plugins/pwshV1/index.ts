import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Shell } from "../../core/models/task";
import { ProcessRunner } from "../ProcessRunner";
import { PluginContext, PluginResult } from "../../core/plugins/Plugin";

/**
 * `pwsh@1` - runs PowerShell, inline or from a `.ps1` file.
 *
 * Id, version, args and artifacts live in `plugin.json`, so a task is
 * validated without running any of this.
 *
 * The manifest's `default:` values are applied by the plugin host, not
 * here. An input arriving as `undefined` means the caller bypassed the
 * schema, and is read as "not specified", never "use the default".
 */
interface PwshInputs {

    script?: string;

    file?: string;

    additionalArgs?: string;

    shell?: string;

    /** `stop` (the manifest's default), `continue`, `silentlyContinue` or `default`. */
    errorActionPreference?: string;

    /** `silentlyContinue` (the manifest's default), or any of the above. */
    progressPreference?: string;

    /** When true anything on stderr fails the task, even on a zero exit. */
    failOnStderr?: boolean;

    /** When true a non-zero exit is reported but does not fail the task. */
    ignoreExitCode?: boolean;
}

/**
 * PowerShell's own casing, keyed by the manifest's option values.
 * `default` is absent from the map so nothing is emitted for it;
 * assigning `$ErrorActionPreference` at all would override the
 * machine's profile.
 */
const PREFERENCE_VALUES: Readonly<Record<string, string>> = {
    stop: "Stop",
    continue: "Continue",
    silentlyContinue: "SilentlyContinue"
};

/**
 * Sequences that end the current statement, or start a new one inside
 * it. See {@link sanitiseArgs} for why the list is a denial rather than
 * an escape.
 */
const ARG_INJECTIONS: readonly string[] = [";", "&", "|", "`", "$(", "@(", ">", "<", "\n", "\r"];

/**
 * Written at the head of the generated file. Without it PowerShell reads
 * the script in the machine's active codepage and mangles non-ASCII.
 */
const BOM = "\uFEFF";

/**
 * The BOM settles how PowerShell reads the script; this settles how it
 * writes back. Without it stdout is encoded in the console's codepage,
 * so accented letters and em dashes reach the log changed.
 */
const OUTPUT_ENCODING = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

const processRunner = new ProcessRunner();

export async function execute(args: PwshInputs, ctx: PluginContext): Promise<PluginResult> {

    let script: string;

    try {

        rejectCmd(args.shell);

        script = prelude(args) + body(args, ctx.cwd);

    } catch (error) {

        return { success: false, message: message(error) };
    }

    let scriptPath: string;

    try {

        scriptPath = writeScript(script, ctx);

    } catch (error) {

        return { success: false, message: `Failed to stage the script: ${message(error)}` };
    }

    try {

        return await run(scriptPath, args, ctx);

    } finally {

        // Best effort. A failure to remove a temp file must not replace
        // the task's real result.
        try {

            fs.rmSync(scriptPath, { force: true });

        } catch {

            // Deliberately ignored.
        }
    }
}

async function run(scriptPath: string, args: PwshInputs, ctx: PluginContext): Promise<PluginResult> {

    // Captured so a later task can read them via `${{ run.context.NAME.stdout }}`.
    let stdout = "";
    let stderr = "";

    let process;

    try {

        process = processRunner.start(
            `& '${quote(scriptPath)}'`,
            ctx.cwd,
            output => {

                if (output.stream === "stdout")
                    stdout += output.text;
                else
                    stderr += output.text;

                ctx.log(output.text, output.stream);
            },
            parseShell(),
            { ...ctx.env }
        );

    } catch (error) {

        return { success: false, message: `Failed to start pwsh: ${message(error)}` };
    }

    ctx.onCancel(process.kill);

    let exitCode: number;

    try {

        exitCode = await process.exitCode;

    } catch (error) {

        return { success: false, message: `Failed to run pwsh: ${message(error)}` };
    }

    const artifacts = { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };

    // Checked before the exit code: a task that opted in wants to hear
    // about stderr, not about the zero exit that hid it.
    if (args.failOnStderr === true && stderr.trim())
        return {
            success: false,
            artifacts,
            message: "Wrote to stderr, and 'failOnStderr' is set."
        };

    const success = exitCode === 0 || args.ignoreExitCode === true;

    return {
        success,
        artifacts,
        message: exitCode === 0 ? undefined : `Process exited with code ${exitCode}.`
    };
}

/**
 * The `$SomethingPreference` assignments that go above the script.
 *
 * Without `$ErrorActionPreference = 'Stop'` a failing cmdlet is
 * non-terminating: it writes to stderr, leaves `$LASTEXITCODE` alone,
 * and PowerShell exits 0, so the task reports success. Exit-code
 * propagation only mirrors what a native command returned.
 */
function prelude(args: PwshInputs): string {

    const preferences = [
        ["ErrorActionPreference", args.errorActionPreference],
        ["ProgressPreference", args.progressPreference]
    ]
        .map(([variable, chosen]) => {

            const value = chosen ? PREFERENCE_VALUES[chosen] : undefined;

            return value ? `$${variable} = '${value}'` : undefined;
        })
        .filter((line): line is string => Boolean(line));

    return [OUTPUT_ENCODING, ...preferences].join("\n") + "\n";
}

/**
 * The script itself: either the inline one, or a call to the `.ps1`.
 *
 * A `file:` is resolved to an absolute path and invoked with a leading
 * `&`, so a path with spaces still runs as a command. Existence and
 * extension are checked here because PowerShell's own message for a
 * missing script names the generated wrapper instead of the input.
 *
 * @throws when the args cannot describe exactly one script to run.
 */
function body(args: PwshInputs, cwd: string): string {

    const hasScript = typeof args.script === "string" && args.script.length > 0;
    const hasFile = typeof args.file === "string" && args.file.length > 0;

    if (hasScript === hasFile)
        throw new Error("pwsh@1 needs either 'script' or 'file' - and not both.");

    if (hasScript)
        return args.script!;

    const file = path.resolve(cwd, args.file!);

    if (path.extname(file).toLowerCase() !== ".ps1")
        throw new Error(`'${args.file}' is not a .ps1 file.`);

    if (!fs.existsSync(file))
        throw new Error(`Script file not found: ${file}`);

    const additional = sanitiseArgs(args.additionalArgs);

    return additional ? `& '${quote(file)}' ${additional}` : `& '${quote(file)}'`;
}

/**
 * Rejects `additionalArgs` that could start a statement of their own.
 *
 * `additionalArgs` is written verbatim into a generated script after
 * template resolution, so `-Name ${{ run.context.x.stdout }}` carries
 * whatever the previous task produced. The reviewer approved the
 * template, not the expansion.
 *
 * A denylist rather than quoting, because the input is a fragment of
 * PowerShell (`-Name "World" -Force`), not a value, and cannot be quoted
 * as a whole. Anything that needs these characters wants `script:`.
 *
 * @throws when a rejected sequence is present.
 */
function sanitiseArgs(args: string | undefined): string | undefined {

    if (!args)
        return undefined;

    const found = ARG_INJECTIONS.find(sequence => args.includes(sequence));

    if (found)
        throw new Error(
            `'additionalArgs' contains ${describe(found)}, which could run something other than the script. ` +
            `Use 'script:' if the call really needs it.`);

    return args;
}

/**
 * Stages the script as a real file, and returns its path.
 *
 * `pwsh -Command` would put the whole script on the command line: capped
 * at the OS's argument limit, parsed twice, and visible to anything that
 * can list processes. That last one matters: `${{ }}` expressions may
 * have expanded to a secret, and the masker only guards the log.
 *
 * Named after the task so a file left behind by a killed process says
 * which one left it.
 */
function writeScript(script: string, ctx: PluginContext): string {

    // The ids are for a human reading the temp directory, not for
    // uniqueness: sanitising punctuation to `_` can make two ids
    // collide. The random suffix is what keeps the path unique.
    const name = `eesha-${ctx.runId}-${ctx.taskId}-${ctx.attempt}`.replace(/[^A-Za-z0-9._-]/g, "_");

    const scriptPath = path.join(os.tmpdir(), `${name}-${randomToken()}.ps1`);

    fs.writeFileSync(scriptPath, BOM + script, { encoding: "utf8" });

    return scriptPath;
}

/** Short enough to keep the Windows-limited path readable, random enough that two calls never collide. */
function randomToken(): string {

    return globalThis.crypto.randomUUID().slice(0, 8);
}

/** Escapes a path for a PowerShell single-quoted string, where `'` doubles. */
function quote(value: string): string {

    return value.replace(/'/g, "''");
}

/** Names a rejected sequence in a way that reads in a sentence. */
function describe(sequence: string): string {

    if (sequence === "\n")
        return "a newline";

    if (sequence === "\r")
        return "a carriage return";

    return `'${sequence}'`;
}

/**
 * The script is staged as a `.ps1` and invoked with `&`, which `cmd.exe`
 * cannot run. The error says what to use instead.
 *
 * @throws when the shell is `cmd`.
 */
function rejectCmd(shell: string | undefined): void {

    if (shell === "cmd")
        throw new Error(
            "pwsh@1 does not support 'shell: cmd' - it stages a .ps1, which cmd.exe cannot run. " +
            "Use a 'run:' task with 'shell: cmd' instead.");
}

/**
 * Always `pwsh`, never `ProcessRunner`'s platform default (`cmd`/`bash`):
 * the staged `.ps1` is invoked with `& 'path'`, which only PowerShell
 * understands.
 */
function parseShell(): Shell {

    return "pwsh";
}

function message(error: unknown): string {

    return error instanceof Error ? error.message : String(error);
}
