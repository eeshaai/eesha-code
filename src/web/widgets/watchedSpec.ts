/*
 * The spec a normal chat is tied to: a line over its thread names the
 * spec, with Open spec, and a question in the chat marks the spec as
 * waiting. A phase chat needs none of this: SDD made it for a spec.
 *
 * Tied in two ways. By pick: a `>spec>NAME>...` path was used in the
 * chat. By itself: a turn of the chat wrote a file inside a spec's
 * folder. A pick always wins. There is no untie: a tie stays for the
 * chat's life, and a later pick or write only moves it to another spec.
 *
 * Kept in this browser, by chat. Nothing is written on the server: the
 * chat stays a normal chat, with its own prompt and model.
 */

export interface WatchedSpec {

    spec: string;

    folder?: string;

    by: "pick" | "auto";
}

const key = (chatId: string) => `eesha.widget.spec:${chatId}`;

export function readWatched(chatId: string | undefined): WatchedSpec | undefined {

    if (!chatId)
        return undefined;

    try {

        // An older build kept `{ off: true }` for an untied chat: read as tied to nothing.
        const kept = JSON.parse(localStorage.getItem(key(chatId)) ?? "null") as Partial<{ spec: unknown; folder: unknown; by: unknown }> | null;

        return kept && typeof kept.spec === "string" && kept.spec
            ? { spec: kept.spec, ...(typeof kept.folder === "string" && kept.folder ? { folder: kept.folder } : {}), by: kept.by === "auto" ? "auto" : "pick" }
            : undefined;

    } catch {

        // No storage, or what it held is not JSON: tied to nothing.
        return undefined;
    }
}

export function writeWatched(chatId: string | undefined, watched: WatchedSpec | undefined): void {

    if (!chatId)
        return;

    try {

        if (watched)
            localStorage.setItem(key(chatId), JSON.stringify(watched));
        else
            localStorage.removeItem(key(chatId));

    } catch {

        // Storage full or blocked: tied for this page load only.
    }
}

/** Where each kind of spec keeps its folders: Eesha's, Kiro's, Spec Kit's. */
const SPEC_FILE = /(?:^|\/)(?:\.eesha\/specs|\.kiro\/specs|specs)\/([^/]+)\/[^/]+\.md$/i;

/**
 * The spec whose folder the last of these files is in - a Markdown file
 * right inside `<spec root>/<name>/`. Only a guess from the path: the
 * server is asked whether a spec of that name is there. Nothing: no
 * file is in a spec folder.
 */
export function specOfFiles(paths: readonly string[]): string | undefined {

    for (let index = paths.length - 1; index >= 0; index--) {

        const found = SPEC_FILE.exec(paths[index]!.replace(/\\/g, "/"));

        if (found)
            return found[1];
    }

    return undefined;
}
