import * as fs from "fs";
import * as path from "path";

/**
 * Where a command resolves on `PATH`, the way a shell would find it.
 *
 * Shared by the two CLI lookups ({@link ./copilotCli} and
 * {@link ./claudeCli}): both SDKs spawn a separate CLI that is not
 * bundled, and an npm global install is where it usually is.
 *
 * `PATHEXT` on Windows because the npm-installed entry point is
 * `name.cmd`, not `name`. Returns the path rather than a yes/no because
 * the callers walk from it to the real executable.
 *
 * `env` supplies PATH and PATHEXT; this module never reads
 * `process.env`.
 */
export function commandOnPath(env: Record<string, string>, name: string): string | undefined {

    const directories = (envValue(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);

    const extensions = process.platform === "win32"
        ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];

    for (const directory of directories)
        for (const extension of extensions) {

            const candidate = path.join(directory, name + extension);

            try {

                if (fs.statSync(candidate).isFile())
                    return candidate;

            } catch {

                // Missing, or not statable - not where the CLI is.
            }
        }

    return undefined;
}

/**
 * One name from a plain env object, the way the OS would read it.
 *
 * `process.env` is case-insensitive on Windows and the real variable
 * is spelled `Path` - a plain copy of it keeps that spelling, so an
 * exact `env.PATH` lookup quietly finds nothing. Exact match first,
 * case-insensitive scan second.
 */
export function envValue(env: Record<string, string>, name: string): string | undefined {

    if (env[name] !== undefined)
        return env[name];

    const upper = name.toUpperCase();

    const key = Object.keys(env).find(candidate => candidate.toUpperCase() === upper);

    return key === undefined ? undefined : env[key];
}
