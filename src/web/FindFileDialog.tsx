import React, { useEffect, useMemo, useState } from "react";

import { LibraryFindFileDialog } from "../view/ui";
import { API, type FileItem, type GitStatus } from "../server/protocol";
import { bridge } from "./bridge";
import { gitIgnored, isIgnored, pathKey } from "./fileMarks";

/*
 * The find-a-file window: the search button in the Files panel's title
 * row, or Ctrl+P. The UI library draws it (FindFileDialog there): a box
 * at the top and the files found under it, with the same look and keys
 * as the search window. This file reads the file names and finds the
 * ones that match.
 *
 * When the window opens, it reads the names of every file in the
 * session's folders. The server has no call that lists a folder deeply,
 * so it reads one folder at a time, the same call the Files panel uses,
 * a few at once. It stops at MAX_FILES files or MAX_FOLDERS folders. It
 * skips .git and node_modules, and every folder git ignores.
 *
 * The box finds files by name first, then by their path. The text stays
 * for the next time the window opens.
 */

/** Reading stops after this many files. */
export const MAX_FILES = 5000;

/** And after this many folders, so a tree of empty folders cannot go on for long. */
const MAX_FOLDERS = 2000;

/** How many folders are read at the same time. */
const AT_ONCE = 6;

/** How many files the list shows. */
export const MAX_SHOWN = 50;

/** Folders never read, whatever git says. */
const SKIPPED = new Set([".git", "node_modules"]);

/** One file the window can find. */
export interface FoundFile {

    name: string;

    /** The full path - what `onOpen` gets. */
    path: string;

    /** The path from the session folder that holds it, with "/" - the folder's own name first. */
    shown: string;
}

/**
 * The files that match the text, best first, at most `limit`. Case does
 * not count, and "\" in the text is taken as "/". Best first: the name is
 * the text, then the name starts with it, then the name holds it, then
 * only the path holds it. A shorter path wins a tie, then the A to Z order.
 */
export function findFiles(files: readonly FoundFile[], query: string, limit = MAX_SHOWN): FoundFile[] {

    const wanted = query.trim().toLowerCase().replace(/\\/g, "/");

    if (!wanted)
        return [];

    const scored: { file: FoundFile; rank: number }[] = [];

    for (const file of files) {

        const name = file.name.toLowerCase();

        const rank = name === wanted ? 0
            : name.startsWith(wanted) ? 1
            : name.includes(wanted) ? 2
            : file.shown.toLowerCase().includes(wanted) ? 3
            : -1;

        if (rank >= 0)
            scored.push({ file, rank });
    }

    scored.sort((a, b) => a.rank - b.rank
        || a.file.shown.length - b.file.shown.length
        || a.file.shown.localeCompare(b.file.shown));

    return scored.slice(0, limit).map(one => one.file);
}

/** The folder's own name: the last part of its path. */
function baseName(folder: string): string {

    return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}

/** How a read of the folders went. */
interface Reading {

    files: FoundFile[];

    /** Still reading. */
    busy: boolean;

    /** Stopped at MAX_FILES or MAX_FOLDERS. */
    cut: boolean;

    /** Folders that could not be read. */
    failed: number;
}

export default function FindFileDialog({ show, folders, onOpen, onClose }: {
    show: boolean;

    /** The session's folders (full paths). */
    folders: readonly string[];

    /** The full path of the file picked. The window closes on its own first. */
    onOpen(path: string): void;

    onClose(): void;
}): React.JSX.Element | null {

    const [query, setQuery] = useState("");
    const [reading, setReading] = useState<Reading>({ files: [], busy: false, cut: false, failed: 0 });

    const folderKey = folders.join("|");

    // Each time the window opens: read the folders' files again, since
    // files may have come or gone since the last time.
    useEffect(() => {

        if (!show)
            return;

        let gone = false;

        void (async () => {

            setReading({ files: [], busy: true, cut: false, failed: 0 });

            // What git ignores is skipped. No git: nothing is skipped but .git and node_modules.
            let ignored = gitIgnored([]);

            try {

                const answer = await bridge.request<{ repos?: GitStatus[] }>(API.gitStatus, { view: bridge.view });

                ignored = gitIgnored(answer.repos ?? []);

            } catch {

                // Read everything then.
            }

            const files: FoundFile[] = [];
            const queue = folders.map(folder => ({ path: folder, shown: baseName(folder) }));
            let read = 0;
            let failed = 0;
            let cut = false;

            while (queue.length && !gone) {

                if (files.length >= MAX_FILES || read >= MAX_FOLDERS) {

                    cut = true;
                    break;
                }

                const wave = queue.splice(0, AT_ONCE);

                read += wave.length;

                const answers = await Promise.all(wave.map(folder =>
                    bridge.request<{ entries?: FileItem[] }>(API.files, { view: bridge.view, path: folder.path })
                        .then(answer => answer.entries, () => undefined)));

                answers.forEach((entries, index) => {

                    if (!entries)
                        return void failed++;

                    for (const entry of entries) {

                        const shown = `${wave[index].shown}/${entry.name}`;

                        if (entry.folder) {

                            if (!SKIPPED.has(entry.name) && !isIgnored(pathKey(entry.path), ignored))
                                queue.push({ path: entry.path, shown });

                        } else if (files.length < MAX_FILES) {

                            files.push({ name: entry.name, path: entry.path, shown });

                        } else {

                            cut = true;
                        }
                    }
                });

                if (!gone)
                    setReading({ files: [...files], busy: true, cut, failed });
            }

            if (!gone)
                setReading({ files, busy: false, cut: cut || queue.length > 0, failed });
        })();

        return () => { gone = true; };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [show, folderKey]);

    const found = useMemo(() => findFiles(reading.files, query).map(file => ({
        name: file.name,
        path: file.path,
        where: file.shown.slice(0, file.shown.length - file.name.length - 1)
    })), [reading.files, query]);

    return (
        <LibraryFindFileDialog
            show={show}
            query={query}
            onQueryChange={setQuery}
            files={found}
            reading={{ count: reading.files.length, busy: reading.busy, cut: reading.cut, failed: reading.failed }}
            noFolders={!folders.length}
            onOpen={onOpen}
            onClose={onClose} />
    );
}
