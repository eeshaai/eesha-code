import * as fs from "fs";
import * as path from "path";
import { commandOnPath } from "./cliOnPath";

/**
 * Where the Copilot CLI is, and what to say when it is nowhere.
 *
 * Its own module so it can be tested without loading the SDK and its
 * native stack, which {@link ./CopilotProvider} imports at the top.
 */

/**
 * Refuses the session when the Copilot CLI cannot be found.
 *
 * The SDK spawns the CLI, a separate ~340 MB-per-platform program that
 * is not bundled. Without this check the failure is a `koffi` load
 * error or a spawn error naming a path in `node_modules`, which reads
 * as "Eesha Code is broken" rather than "install this one thing".
 */
export function requireCli(env: Record<string, string>): void {

    // The provider has already tried every resolvable path, so an
    // unset value means all of them missed. The PATH check is not
    // redundant: the CLI can be on PATH in a layout this cannot walk to
    // a binary, and the SDK's own resolution is the remaining chance.
    if (env.COPILOT_CLI_PATH || copilotOnPath(env))
        return;

    throw new Error(
        "GitHub Copilot CLI not found. The Copilot CLI program itself is "
        + "needed, and it is not bundled (it is ~340 MB per platform). Install it with "
        + "`npm install -g @github/copilot`, or point COPILOT_CLI_PATH at a copy you already have.");
}

/**
 * The Copilot CLI executable, wherever this machine keeps it.
 *
 * The copy shipped beside the SDK first (it is what this build was
 * tested against), then an npm global install. Returns undefined rather
 * than throwing so the SDK's own resolution still applies.
 *
 * `env` supplies PATH and PATHEXT; this module never reads
 * `process.env`.
 */
export function cliBinary(env: Record<string, string>): string | undefined {

    try {

        // The `@github` scope packaged with this build, found as a
        // sibling of `@github/copilot` rather than resolved by name:
        // the platform packages declare an `exports` map with no
        // `./package.json` entry, so `require.resolve` on them throws.
        const shipped = path.dirname(path.dirname(require.resolve("@github/copilot/package.json")));

        const beside = platformBinaryIn(shipped);

        if (beside)
            return beside;

    } catch {

        // Not packaged with this build - the global install below is
        // the remaining route.
    }

    const shim = copilotOnPath(env);

    return shim ? globalCliBinary(shim) : undefined;
}

/**
 * The executable belonging to the `copilot` a shell would find.
 *
 * What `PATH` finds is an npm shim (`copilot.cmd` on Windows), and the
 * SDK spawns any non-`.js` path directly with no shell - Node refuses
 * to spawn a `.cmd` that way (`spawn EINVAL`). The real executable is
 * in the platform package, so this walks from the shim to it, trying
 * both npm global layouts: shim beside `node_modules` (Windows), and a
 * symlink into `lib/node_modules` (POSIX), followed via realpath.
 *
 * Exported for its own tests: going through {@link cliBinary} would
 * pass on the shipped copy and not exercise this.
 */
export function globalCliBinary(shim: string): string | undefined {

    const scopes = [path.join(path.dirname(shim), "node_modules", "@github")];

    try {

        // `.../node_modules/@github/copilot/index.js` when the shim is
        // a link, so the scope is two levels up from the file.
        const real = fs.realpathSync(shim);

        if (real !== shim)
            scopes.push(path.dirname(path.dirname(real)));

    } catch {

        // A shim that cannot be read is not a route to anything.
    }

    for (const scope of scopes) {

        const binary = platformBinaryIn(scope);

        if (binary)
            return binary;
    }

    return undefined;
}

/** Where `copilot` resolves on `PATH` - see {@link commandOnPath}. */
function copilotOnPath(env: Record<string, string>): string | undefined {

    return commandOnPath(env, "copilot");
}

/**
 * The platform package's executable inside one `@github` directory.
 *
 * The file name is read from the package's own `exports["."]` rather
 * than guessed - it differs by platform (`copilot.exe` on Windows).
 */
function platformBinaryIn(scope: string): string | undefined {

    for (const variant of process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform]) {

        const name = `copilot-${variant}-${process.arch}`;

        // Hoisted beside its owner, or nested under it - both are
        // layouts npm produces.
        for (const root of [path.join(scope, name), path.join(scope, "copilot", "node_modules", "@github", name)]) {

            try {

                const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
                    exports?: Record<string, unknown>;
                };

                const exported = manifest.exports?.["."];

                if (typeof exported === "string" && fs.existsSync(path.join(root, exported)))
                    return path.join(root, exported);

            } catch {

                // No package here, or an unreadable one - try the next.
            }
        }
    }

    return undefined;
}
