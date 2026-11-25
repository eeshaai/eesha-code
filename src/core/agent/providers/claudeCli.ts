import * as fs from "fs";
import * as path from "path";
import { commandOnPath, envValue } from "./cliOnPath";

/**
 * Where the Claude Code CLI is, and what to say when it is nowhere.
 *
 * The Agent SDK spawns `claude` as a child process. It looks for the
 * binary in exactly one place: the per-platform package
 * (`@anthropic-ai/claude-agent-sdk-win32-x64` and seven siblings) that
 * npm installs as an optional dependency *beside* the SDK. That package
 * is ~320 MB per platform, so Eesha Code does not ship it - which means
 * on every machine that installed it from a package, the
 * SDK's own lookup finds nothing and the session dies with "Native CLI
 * binary for win32-x64 not found. Reinstall ... without --omit=optional",
 * a message that sends the reader the wrong way.
 *
 * This module does what {@link ./copilotCli} does for Copilot: finds a
 * CLI the machine already has and hands it to the SDK as
 * `pathToClaudeCodeExecutable`. Its own module so it can be tested
 * without loading the SDK.
 */

/** The engine's own env name for naming the binary outright. Configuration, not a credential. */
export const CLAUDE_CLI_PATH = "CLAUDE_CLI_PATH";

/**
 * Refuses the session when no CLI could be found.
 *
 * Called with what {@link cliBinary} returned, so an `undefined` means
 * every route below missed. Better this than the SDK's error, which
 * talks about reinstalling a package the user never installed.
 */
export function requireCli(binary: string | undefined): void {

    if (binary)
        return;

    throw new Error(
        "Claude Code CLI not found. "
        + "Install it with `npm install -g @anthropic-ai/claude-code`, or point "
        + `${CLAUDE_CLI_PATH} at a copy you already have.`);
}

/**
 * The Claude Code executable, wherever this machine keeps it.
 *
 * In order:
 *
 *   1. `CLAUDE_CLI_PATH` in `env` - the explicit override.
 *   2. The platform package beside the SDK - what a checkout running
 *      from source has, and what this build was tested against.
 *   3. `claude` on `PATH`, walked to its real executable - what
 *      `npm install -g @anthropic-ai/claude-code` or the native
 *      installer leaves behind.
 *
 * Returns undefined when all three miss; {@link requireCli} turns that
 * into the message. `env` supplies the override, PATH and PATHEXT;
 * this module never reads `process.env`.
 */
export function cliBinary(env: Record<string, string>): string | undefined {

    const named = envValue(env, CLAUDE_CLI_PATH);

    if (named)
        return named;

    try {

        // `require.resolve` on the bare name gives `sdk.mjs`; the
        // platform package is a sibling of its folder. Not resolved
        // by name: the platform packages declare no `exports`, and the
        // SDK's own `package.json` is not exported either.
        const scope = path.dirname(path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")));

        const beside = platformBinaryIn(scope);

        if (beside)
            return beside;

    } catch {

        // Not packaged with this build - the global install below is
        // the remaining route.
    }

    const shim = commandOnPath(env, "claude");

    return shim ? globalCliBinary(shim) : undefined;
}

/**
 * The executable belonging to the `claude` a shell would find.
 *
 * Three shapes turn up on `PATH`:
 *
 *   - A native executable: `claude.exe` or a bare `claude` binary from
 *     the native installer, possibly a symlink into a versions folder.
 *     Used as-is, after `realpath`.
 *   - npm's shim: `claude.cmd` on Windows, a symlink to a `.js` entry
 *     on POSIX. The SDK spawns a non-`.js` path directly with no
 *     shell, and Node refuses to spawn a `.cmd` that way (`spawn
 *     EINVAL`); a `.js` path would be run through `process.execPath`,
 *     which may not be a plain Node program. So neither is
 *     handed over - the walk below finds the binary the shim runs.
 *
 * The walk tries both npm global layouts: shim beside `node_modules`
 * (Windows), and a symlink into `lib/node_modules` (POSIX), followed
 * via realpath. Exported for its own tests: going through
 * {@link cliBinary} would pass on the shipped copy and not exercise
 * this.
 */
export function globalCliBinary(shim: string): string | undefined {

    let real = shim;

    try {

        real = fs.realpathSync(shim);

    } catch {

        // A shim that cannot be read is not a route to anything.
        return undefined;
    }

    if (!isScript(real))
        return real;

    const scopes = [path.join(path.dirname(shim), "node_modules", "@anthropic-ai")];

    // `.../node_modules/@anthropic-ai/claude-code/cli.js` when the shim
    // is a link, so the scope is two levels up from the file.
    if (real !== shim)
        scopes.push(path.dirname(path.dirname(real)));

    for (const scope of scopes) {

        const binary = platformBinaryIn(scope);

        if (binary)
            return binary;
    }

    return undefined;
}

/** Things npm puts on PATH that stand in for the executable rather than being it. */
function isScript(file: string): boolean {

    return [".cmd", ".bat", ".ps1", ".js", ".cjs", ".mjs"].includes(path.extname(file).toLowerCase());
}

/**
 * The CLI executable inside one `@anthropic-ai` directory.
 *
 * Two packages carry it under two names, and npm may hoist the
 * platform package beside its owner or nest it underneath:
 *
 *   - `claude-code/bin/claude(.exe)` - what `@anthropic-ai/claude-code`'s
 *     install step leaves, and what its shim runs.
 *   - `claude-code-<platform>-<arch>/claude(.exe)` - that package's
 *     optional platform dependency.
 *   - `claude-agent-sdk-<platform>-<arch>/claude(.exe)` - the SDK's.
 */
function platformBinaryIn(scope: string): string | undefined {

    const name = "claude" + (process.platform === "win32" ? ".exe" : "");

    const variants = process.platform === "linux"
        ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
        : [`${process.platform}-${process.arch}`];

    const candidates = [path.join(scope, "claude-code", "bin", name)];

    for (const variant of variants)
        for (const owner of ["claude-code", "claude-agent-sdk"]) {

            const platformPackage = `${owner}-${variant}`;

            candidates.push(
                path.join(scope, platformPackage, name),
                path.join(scope, owner, "node_modules", "@anthropic-ai", platformPackage, name));
        }

    for (const candidate of candidates) {

        try {

            if (fs.statSync(candidate).isFile())
                return candidate;

        } catch {

            // Not this one.
        }
    }

    return undefined;
}
