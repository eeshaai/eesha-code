import React, { useEffect, useRef, useState } from "react";

import { CommandBlockView } from "../view/ui";
import { API, type FileItem, type RunDone, type ShellChoice } from "../server/protocol";
import { bridge } from "./bridge";
import { endText, shellFor, shownOutput } from "./runOutput";

/*
 * A shell command the agent wrote, with Run. The shell
 * list and Run sit in the block's header beside Copy. Run starts the
 * command once in one of the session's folders - a pop-up asks which when
 * there are several - and what it prints shows under the block as it
 * comes. Nobody types into it; Stop ends it. Nothing is kept: switching
 * sessions or reloading the page stops a run still going.
 *
 * The library's CommandBlock draws it. This file starts and stops the run
 * on the server and keeps what it printed.
 */

/** The most output kept under one block. Older text is dropped from the top. */
const OUTPUT_LIMIT = 200_000;

/** In the browser: the shell last picked, so the next block starts on it. */
const SHELL_KEY = "eesha.shell";

// -------------------------------------------------------------------
// Output of every run, kept here as it arrives. A run's first lines can
// come before the request that started it has answered with its id.
// -------------------------------------------------------------------

interface RunOutput {

    text: string;

    /** Older text was dropped to stay under OUTPUT_LIMIT. */
    cut: boolean;

    done?: RunDone;
}

const outputs = new Map<string, RunOutput>();

const watchers = new Set<() => void>();

let listening = false;

function listen(): void {

    if (listening)
        return;

    listening = true;

    bridge.onPage(message => {

        if (message.type !== "eesha.run")
            return;

        const now = outputs.get(message.id) ?? { text: "", cut: false };
        let text = now.text + (message.text ?? "");
        let cut = now.cut;

        if (text.length > OUTPUT_LIMIT) {

            text = text.slice(text.length - OUTPUT_LIMIT);
            cut = true;
        }

        outputs.set(message.id, { text, cut, done: message.done ?? now.done });

        for (const watcher of watchers)
            watcher();
    });
}

let shellsAsked: Promise<ShellChoice[]> | undefined;

/** The shells on the server's machine, asked once per page. */
function loadShells(): Promise<ShellChoice[]> {

    shellsAsked ??= bridge.request<{ shells?: ShellChoice[] }>(API.shells, {})
        .then(answer => answer.shells ?? [])
        .catch(() => {

            shellsAsked = undefined;

            return [];
        });

    return shellsAsked;
}

function savedShell(): string | undefined {

    try {

        return localStorage.getItem(SHELL_KEY) ?? undefined;

    } catch {

        return undefined;
    }
}

function saveShell(id: string): void {

    try {

        localStorage.setItem(SHELL_KEY, id);

    } catch {

        // Private window or blocked storage: the pick lasts until reload.
    }
}

/** The run under this block: where it runs, and its id once the server gave one. */
interface Shown {

    folder: string;

    id?: string;

    /** The server would not start it. */
    problem?: string;
}

export function CommandBlock({ code, language }: { code: string; language: string }) {

    const [shells, setShells] = useState<ShellChoice[]>();
    /** Picked on this block's own list. Until then, the block's language picks (see `shellFor`). */
    const [picked, setPicked] = useState<string>();
    const [shown, setShown] = useState<Shown>();
    const [picking, setPicking] = useState<FileItem[]>();
    const [starting, setStarting] = useState(false);
    const [, redraw] = useState(0);

    /** The run going now, for Stop when the block goes away. */
    const live = useRef<string | undefined>(undefined);

    useEffect(() => {

        let on = true;

        void loadShells().then(found => on && setShells(found));

        return () => { on = false; };
    }, []);

    useEffect(() => {

        listen();

        const watcher = (): void => redraw(count => count + 1);

        watchers.add(watcher);

        return () => { watchers.delete(watcher); };
    }, []);

    // Leaving the page part this block is on stops what it started.
    useEffect(() => () => {

        if (live.current) {

            void bridge.request(API.runStop, { view: bridge.view, id: live.current });
            outputs.delete(live.current);
        }
    }, []);

    const shell = shells && (shells.find(one => one.id === picked) ?? shellFor(shells, language, savedShell()));
    const output = shown?.id ? outputs.get(shown.id) : undefined;
    const running = starting || (!!shown?.id && !output?.done);

    if (live.current && output?.done)
        live.current = undefined;

    const start = async (folder: FileItem): Promise<void> => {

        if (!shell)
            return;

        setPicking(undefined);
        setStarting(true);

        if (shown?.id)
            outputs.delete(shown.id);

        const answer = await bridge.request<{ id?: string }>(API.run, { view: bridge.view, code, shell: shell.id, folder: folder.path })
            .catch(error => ({ problem: (error as Error).message, id: undefined }));

        setStarting(false);

        if (!answer.id) {

            setShown({ folder: folder.name, problem: answer.problem ?? "The server did not start it." });
            return;
        }

        live.current = answer.id;
        setShown({ folder: folder.name, id: answer.id });
    };

    const run = async (): Promise<void> => {

        setStarting(true);

        const answer = await bridge.request<{ entries?: FileItem[] }>(API.files, { view: bridge.view })
            .catch(error => ({ problem: (error as Error).message, entries: undefined }));

        setStarting(false);

        const folders = answer.entries ?? [];

        if (!folders.length)
            return setShown({ folder: "", problem: answer.problem ?? "This session has no folder to run in." });

        if (folders.length === 1)
            return void start(folders[0]!);

        setPicking(folders);
    };

    const stop = (): void => {

        if (shown?.id)
            void bridge.request(API.runStop, { view: bridge.view, id: shown.id });
    };

    const close = (): void => {

        if (shown?.id)
            outputs.delete(shown.id);

        setShown(undefined);
    };

    const done = output?.done;

    return (
        <CommandBlockView
            code={code}
            language={language}
            shells={shells}
            shell={shell?.id}
            onShell={id => { setPicked(id); saveShell(id); }}
            busy={running}
            runDisabled={!shell || running}
            runTitle={shell ? `Run in ${shell.label}` : "Looking for shells…"}
            onRun={() => void run()}
            run={shown && {
                folder: shown.folder,
                shell: shell?.label,
                running,
                text: output?.text ? shownOutput(output.text) : undefined,
                cut: output?.cut,
                problem: shown.problem ?? done?.problem,
                ended: done ? endText(done) : undefined,
                failed: done ? done.code !== 0 : undefined,
                stopped: done?.stopped
            }}
            onStop={stop}
            onClose={close}
            folders={picking}
            onFolder={folder => { const item = picking?.find(one => one.path === folder.path); if (item) void start(item); }}
            onCancelFolder={() => setPicking(undefined)} />
    );
}
