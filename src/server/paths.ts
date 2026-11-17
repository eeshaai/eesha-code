import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/*
 * Where Eesha Code keeps its files: `~/.eesha`, its own profile.
 *
 *   settings.json      the same shape as ~/.eesha/settings.json,
 *                      plus `eesha: { port, theme }`
 *   key                the secret the page and the command prove
 *                      themselves with - see security.ts
 *   server.json        the running server's pid and port; gone when it stops
 *   state.json         saved picks, chat names, the Permissions level per runtime
 *   permissions.json   the answers saved from permission cards
 *   sessions/<id>.json the folders each chat works in
 *   events/            the chats themselves (the engine's own layout)
 *   models/            the model lists the pickers show
 *   cache/connectors.json  the lists the connectors keep - see connectors/cache.ts
 *   memory.db          the memories kept between sessions - see memory/memoryStore.ts
 *   scratch/<id>/      uploaded files and handover notes of one chat
 *   trash/             files an Undo removed
 *   logs/              the server's log, one file a day
 *
 * Nothing here reads or writes ~/.eesha or a repository's
 * .eesha folder.
 */

export const PROFILE_FOLDER = ".eesha";

/** `~/.eesha`. A function so a test can move the home folder. */
export function eeshaHome(): string {

    return path.join(os.homedir(), PROFILE_FOLDER);
}

/** A path inside `~/.eesha`. */
export function eeshaPath(...segments: string[]): string {

    return path.join(eeshaHome(), ...segments);
}

/**
 * Writes a file whole or not at all: to a temporary name first, then
 * renamed over the real one, so a crash mid-write never leaves half a
 * file that the next start cannot read.
 */
export function writeAtomic(file: string, text: string): void {

    fs.mkdirSync(path.dirname(file), { recursive: true });

    const temporary = `${file}.${process.pid}.tmp`;

    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, file);
}

/** A JSON file's value, or nothing when it is missing or not JSON. */
export function readJson(file: string): unknown {

    try {

        return JSON.parse(fs.readFileSync(file, "utf8"));

    } catch {

        return undefined;
    }
}
