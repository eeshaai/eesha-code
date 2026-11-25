import { Shell } from "../../core/models/task";
import { ProcessRunner } from "../ProcessRunner";
import { PluginContext, PluginResult } from "../../core/plugins/Plugin";

/**
 * `shell@1` - runs a command line through the OS shell.
 *
 * This is what a task's `run:` desugars to: the parser rewrites
 * `run: dotnet build` into `uses: shell@1` with the command as
 * `script:`, so the engine has no spawn code of its own.
 *
 * Thin on purpose: no staging, no preferences, no file mode. Anything
 * that wants PowerShell semantics wants `pwsh@1`.
 */
interface ShellInputs {

    script?: string;

    /** `pwsh`, `cmd` or `bash`. Absent means the OS default - see `ProcessRunner`. */
    shell?: string;
}

const processRunner = new ProcessRunner();

export async function execute(args: ShellInputs, ctx: PluginContext): Promise<PluginResult> {

    const script = args.script;

    if (typeof script !== "string" || script.length === 0)
        return { success: false, message: "shell@1 needs a 'script' to run." };

    // A task's log opens with what ran, after resolution.
    ctx.log(`Run ${script}`, "system");

    // Captured so a later task can read them via `${{ run.context.NAME.stdout }}`.
    let stdout = "";
    let stderr = "";

    let process;

    try {

        process = processRunner.start(
            script,
            ctx.cwd,
            output => {

                if (output.stream === "stdout")
                    stdout += output.text;
                else
                    stderr += output.text;

                ctx.log(output.text, output.stream);
            },
            parseShell(args.shell),
            { ...ctx.env }
        );

    } catch (error) {

        return { success: false, message: `Failed to start task: ${message(error)}` };
    }

    ctx.onCancel(process.kill);

    let exitCode: number;

    try {

        exitCode = await process.exitCode;

    } catch (error) {

        return { success: false, message: `Failed to run task: ${message(error)}` };
    }

    return {
        success: exitCode === 0,
        artifacts: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode },
        message: exitCode === 0 ? undefined : `Process exited with code ${exitCode}.`
    };
}

/** A recognised shell passes through; anything else defers to the OS default rather than failing. */
function parseShell(value: string | undefined): Shell | undefined {

    return value === "pwsh" || value === "cmd" || value === "bash" ? value : undefined;
}

function message(error: unknown): string {

    return error instanceof Error ? error.message : String(error);
}
