import * as os from "os";
import * as path from "path";

import { WORKFLOWS_DIR } from "./constants";

/**
 * The profile folder set at start, used instead of the default
 * `~/.eesha`.
 */
let chosen: string | undefined;

/**
 * Points the profile folder somewhere else for the rest of this
 * process - its settings.json, chat history, model lists. Called once,
 * at start. Nothing resets it back except `undefined`, which a test may
 * use.
 */
export function useProfileDirectory(directory: string | undefined): void {

    chosen = directory;
}

/**
 * The user profile's `.eesha`, same folder shape as a
 * workspace's - or the folder set at start (see
 * {@link useProfileDirectory}). A function rather than a constant so a
 * test can point `os.homedir` at a temporary directory.
 */
export function profileDirectory(): string {

    return chosen ?? path.join(os.homedir(), WORKFLOWS_DIR);
}

/**
 * The name this app gives itself when it connects to an agent or an MCP
 * server: its profile folder's name without the dot.
 */
export function appName(): string {

    return path.basename(profileDirectory()).replace(/^\./, "");
}

/** A path inside the profile folder, e.g. `profilePath("plugins")`. */
export function profilePath(...segments: string[]): string {

    return path.join(profileDirectory(), ...segments);
}
