import * as fs from "fs";
import * as path from "path";

import { eeshaPath } from "./paths";
import { isChatId, readSession, sessionIds } from "./sessions";

/*
 * What the settings page's Storage part counts and clears:
 *
 *   ~/.eesha/trash     files an Undo moved there
 *   ~/.eesha/scratch   the scratch folders of chats that were deleted -
 *                          a deleted chat's scratch folder stays when it has
 *                          files in it
 *
 * Only ever inside those two folders. A scratch folder that a saved chat
 * works in, or that a copy made by going back shares, is never touched.
 */

/** Files and bytes under a folder. Links are counted as themselves, never followed. */
function sizeOf(folder: string): { files: number; bytes: number } {

    let files = 0;
    let bytes = 0;

    const walk = (current: string): void => {

        let entries: fs.Dirent[];

        try {

            entries = fs.readdirSync(current, { withFileTypes: true });

        } catch {

            return;
        }

        for (const entry of entries) {

            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {

                walk(full);

                continue;
            }

            files++;

            try {

                bytes += fs.lstatSync(full).size;

            } catch {

                // Gone meanwhile.
            }
        }
    };

    walk(folder);

    return { files, bytes };
}

/** What is in ~/.eesha/trash. */
export function trashStats(): { files: number; bytes: number } {

    return sizeOf(eeshaPath("trash"));
}

/** Deletes everything in ~/.eesha/trash. The folder itself stays. */
export function emptyTrash(): void {

    const trash = eeshaPath("trash");

    let names: string[];

    try {

        names = fs.readdirSync(trash);

    } catch {

        return;
    }

    for (const name of names)
        fs.rmSync(path.join(trash, name), { recursive: true, force: true });
}

/**
 * The scratch folders no chat uses: no saved chat has that id, and no
 * saved chat shares it (a copy made by going back). `inUse` adds the
 * chats the server holds right now.
 */
export function orphanScratch(inUse: ReadonlySet<string>): string[] {

    let names: string[];

    try {

        names = fs.readdirSync(eeshaPath("scratch"));

    } catch {

        return [];
    }

    const used = new Set(inUse);

    for (const chatId of sessionIds()) {

        used.add(chatId);

        const scratchOf = readSession(chatId)?.scratchOf;

        if (scratchOf)
            used.add(scratchOf);
    }

    return names
        .filter(name => isChatId(name) && !used.has(name))
        .map(name => eeshaPath("scratch", name))
        .filter(folder => {

            try {

                return fs.lstatSync(folder).isDirectory();

            } catch {

                return false;
            }
        });
}

/** How many scratch folders no chat uses, and their size. */
export function scratchStats(inUse: ReadonlySet<string>): { folders: number; bytes: number } {

    const folders = orphanScratch(inUse);

    return { folders: folders.length, bytes: folders.reduce((sum, folder) => sum + sizeOf(folder).bytes, 0) };
}

/** Deletes the scratch folders no chat uses. */
export function removeOrphanScratch(inUse: ReadonlySet<string>): void {

    for (const folder of orphanScratch(inUse))
        fs.rmSync(folder, { recursive: true, force: true });
}

/**
 * Moves a file or folder to ~/.eesha/trash instead of deleting it -
 * an Undo of an added file, or the git panel's Discard of a file git does
 * not track. Each one gets its own stamped folder, so names never clash.
 */
export async function moveToTrash(absolute: string): Promise<void> {

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

    const target = path.join(eeshaPath("trash", `${stamp}-${Math.random().toString(36).slice(2, 6)}`), path.basename(absolute));

    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    try {

        await fs.promises.rename(absolute, target);

    } catch (error) {

        // Another drive: a rename cannot cross it.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV")
            throw error;

        await fs.promises.cp(absolute, target, { recursive: true });
        await fs.promises.rm(absolute, { recursive: true, force: true });
    }
}
