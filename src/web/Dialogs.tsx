import React, { useCallback, useEffect, useMemo, useState } from "react";

import { LibraryPromptDialog, LibraryReviewDialog, LibraryShortcutsDialog, LibraryToasts, type PromptDialogRequest } from "../view/ui";
import { codeDiffSections } from "../view/diff/editorDiff";
import { KEEP_FOLDER, type PromptRequest, type ReviewFile } from "../server/protocol";
import type { ShortcutGroup } from "./shortcuts";

/*
 * What a browser page has to draw for the chat itself:
 * the question pop-up, every changed file at once (Review all), the
 * keyboard shortcut list and short notices. The UI library draws them;
 * this file turns the server's words into what the library takes. A
 * single diff or file opens as a tab instead (EditorArea.tsx).
 */

/** A connector's name as the question says it. */
function connectorName(connector: string): string {

    return connector === "ado" ? "Azure DevOps" : connector === "memory" ? "Memory" : "GitHub";
}

/** A line of text, or yes/no. `onAnswer(undefined)` is backing out. */
export function PromptDialog({ prompt, onAnswer }: { prompt: PromptRequest; onAnswer(value: string | undefined): void }) {

    // A connector write the AI asks to make: asked
    // every time, whatever the permission level. Closing it is a no.
    const request: PromptDialogRequest = prompt.kind === "write"
        ? { kind: "allow", title: `${connectorName(prompt.connector)}: the agent asks to make a change`, text: prompt.text, detail: `Tool: ${prompt.tool}`, ariaLabel: "Allow a connector change" }
        : prompt;

    // A delete that leaves a folder with no session: its Keep tick box,
    // left ticked, goes back as KEEP_FOLDER after the action.
    return <LibraryPromptDialog prompt={request} onAnswer={(value, keep) => onAnswer(value !== undefined && keep ? value + KEEP_FOLDER : value)} />;
}

/** Where the window keeps a file it saw undone: its repository and its path. */
function reviewKey(root: string, file: string): string {

    return `${root}\n${file}`;
}

/**
 * Review all: every file the last turn changed, each with its own Undo.
 * A file the chat reports undone - from here or from the changed-files
 * bar - says so; the chat may still ask first when a file changed again
 * after the turn.
 */
export function ReviewDialog({ files, onUndo, onClose }: { files: ReviewFile[]; onUndo(file: ReviewFile): void; onClose(): void }) {

    const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());

    // The chat's own "Undone: ..." line is what says a file went back.
    useEffect(() => {

        const onMessage = (event: MessageEvent) => {

            const message = event.data as { type?: string; meta?: { kind?: string; changed?: { root: string; files: { path: string }[] } } } | undefined;
            const changed = message?.type === "log" && message.meta?.kind === "files.undone" ? message.meta.changed : undefined;

            if (changed)
                setUndone(current => new Set([...current, ...changed.files.map(file => reviewKey(changed.root, file.path))]));
        };

        window.addEventListener("message", onMessage);

        return () => window.removeEventListener("message", onMessage);

    }, []);

    const shown = useMemo(() => files.map(file => {

        const key = reviewKey(file.changed.root, file.file);

        return {
            key,
            path: file.path,
            file: file.file,
            status: file.status,
            sections: file.binary ? [] : codeDiffSections(file.before, file.after),
            beforeText: file.before,
            afterText: file.after,
            isNew: file.before === undefined,
            binary: file.binary,
            undone: undone.has(key)
        };

    }), [files, undone]);

    return (
        <LibraryReviewDialog
            files={shown}
            onUndo={one => {

                const file = files.find(each => reviewKey(each.changed.root, each.file) === one.key);

                if (file)
                    onUndo(file);
            }}
            onClose={onClose} />
    );
}

/** The keyboard shortcuts - Ctrl+/ or the keyboard button under the chat list. */
export function ShortcutsDialog({ list, onClose }: { list: ShortcutGroup[]; onClose(): void }) {

    return <LibraryShortcutsDialog list={list} onClose={onClose} />;
}

export interface Toast {

    id: number;

    text: string;

    /** A chat waiting for an answer - the toast opens it. */
    chatId?: string;
}

/** Short notices, top right. A plain note goes by itself; one about a waiting chat stays until closed, and Open shows that chat. */
export function Toasts({ toasts, onClose, onOpen }: { toasts: Toast[]; onClose(id: number): void; onOpen(chatId: string): void }) {

    const items = useMemo(() => toasts.map(toast => ({ id: toast.id, text: toast.text, ...(toast.chatId ? { actionLabel: "Open" } : {}) })), [toasts]);

    const open = useCallback((id: number) => {

        const chatId = toasts.find(toast => toast.id === id)?.chatId;

        if (chatId)
            onOpen(chatId);

    }, [toasts, onOpen]);

    return <LibraryToasts toasts={items} onClose={onClose} onAction={open} />;
}
