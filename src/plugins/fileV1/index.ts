import * as fs from "fs";
import * as path from "path";

import { PluginContext, PluginResult } from "../../core/plugins/Plugin";

/**
 * `file@1` - reads a file into a run variable, or writes one from a value.
 *
 * An `ai` task in `mode: ask` proposes and touches nothing; this one
 * touches and proposes nothing. A phase becomes two tasks, propose then
 * execute, with the gate between them.
 *
 * Cross-platform, unlike writing a file through `pwsh@1`.
 *
 * Relative paths resolve against `ctx.cwd`, never `process.cwd()`: a
 * definition shipped inside Eesha Code must still write into the
 * workspace (see `builtInDefinitionRoot.test.ts`).
 */
interface FileArgs {

    operation: string;

    path: string;

    content?: string;

    createDirectories?: boolean;
}

export async function execute(args: FileArgs, ctx: PluginContext): Promise<PluginResult> {

    const target = path.isAbsolute(args.path)
        ? args.path
        : path.join(ctx.cwd, args.path);

    if (args.operation === "read")
        return read(target, ctx);

    if (args.operation === "write")
        return write(target, args, ctx);

    if (args.operation === "mkdir")
        return mkdir(target, ctx);

    return {
        success: false,
        message: `Unknown operation '${args.operation}'. Expected 'read', 'write' or 'mkdir'.`
    };
}

/**
 * Creates a spec folder without PowerShell. The Specs list is built from
 * folders on disk, so a run that fails before its first document would
 * otherwise vanish from the list with its error message.
 */
function mkdir(target: string, ctx: PluginContext): PluginResult {

    fs.mkdirSync(target, { recursive: true });

    ctx.log(`Folder: ${target}`, "system");

    return { success: true, artifacts: { path: target } };
}

function read(target: string, ctx: PluginContext): PluginResult {

    if (!fs.existsSync(target))
        return { success: false, message: `No file at ${target}.` };

    const content = fs.readFileSync(target, "utf8");

    ctx.log(`Read ${target} (${lineCount(content)} lines).`, "system");

    return {
        success: true,
        artifacts: { content, path: target, lines: lineCount(content) }
    };
}

function write(target: string, args: FileArgs, ctx: PluginContext): PluginResult {

    // Absent, not empty: writing an empty file is a valid request.
    if (args.content === undefined)
        return { success: false, message: "Nothing to write - 'content' was not supplied." };

    // The manifest's default is applied by the host, so `undefined` here
    // means the caller bypassed the schema. Read as "not specified".
    if (args.createDirectories !== false)
        fs.mkdirSync(path.dirname(target), { recursive: true });

    fs.writeFileSync(target, args.content, "utf8");

    const lines = lineCount(args.content);

    ctx.log(`Wrote ${target} (${lines} lines).`, "system");

    return {
        success: true,
        artifacts: { content: args.content, path: target, lines }
    };
}

/**
 * Lines as a person counts them: a trailing newline does not add one.
 * Document sizes are compared with this number.
 */
function lineCount(content: string): number {

    if (!content)
        return 0;

    return content.replace(/\n$/, "").split("\n").length;
}
