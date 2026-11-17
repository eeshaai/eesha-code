import React, { useEffect, useRef, useState } from "react";

import { Button, Input, Select, UiIcon } from "../view/ui";
import { API, FolderListing } from "../server/protocol";
import { bridge } from "./bridge";
import { useFolderBrowser } from "./FolderPicker";

/*
 * The folder part of the workspace window (WorkspaceDialog.tsx): a list
 * of the folders used before, then the git repos in the working folders
 * (Settings > General), with "Browse for another…" as its last choice.
 * That choice opens a small folder browser under the list: walk the
 * working folders, drives and folders, or type a path, then press "Use
 * this folder".
 *
 * The UI library's folder picker is not used here: it always shows its
 * big browser. Other windows use it.
 */

/** The list's "Browse for another…" choice - no folder path looks like it. */
const BROWSE = "\u0000browse";

/**
 * The folders used before, newest first, then the git repos in the
 * working folders, last git activity first - read once from the server.
 * The server leaves out of the repos the ones used before.
 */
export function useRecentFolders(): string[] {

    const [recent, setRecent] = useState<string[]>([]);

    useEffect(() => {

        let live = true;

        void bridge.request<FolderListing>(API.folders, {}).then(answer => {

            if (live && Array.isArray(answer.recent))
                setRecent([...answer.recent, ...(answer.repos ?? [])]);
        }).catch(() => undefined);

        return () => { live = false; };
    }, []);

    return recent;
}

function same(left: string, right: string): boolean {

    return left.toLowerCase() === right.toLowerCase();
}

/**
 * One folder choice: the list of folders used before, then "Browse for
 * another…". `value` is the folder picked, or nothing. `skip` are folders
 * the list leaves out - ones already in the workspace.
 */
export function FolderChoice({ recent, value, skip = [], placeholder, label, disabled, onPick }: {
    recent: string[];
    value?: string;
    skip?: string[];
    placeholder: string;
    label: string;
    disabled?: boolean;
    onPick(folder: string): void;
}) {

    const [browsing, setBrowsing] = useState(false);

    const offered = recent.filter(one => !skip.some(other => same(one, other)) || (value !== undefined && same(one, value)));
    const withValue = value && !offered.some(one => same(one, value)) ? [value, ...offered] : offered;

    const items = [
        ...withValue.map(one => ({ id: one, label: one })),
        { id: BROWSE, label: "Browse for another…" }
    ];

    return (
        <div className="eesha-ws-choice">
            <Select
                aria-label={label}
                size="sm"
                sort={false}
                hideSearch={withValue.length < 8}
                disabled={disabled}
                placeholder={placeholder}
                items={items}
                labelKey="label"
                valueKey="id"
                value={value}
                onChange={id => {

                    const picked = String(id);

                    if (picked === BROWSE)
                        setBrowsing(true);
                    else if (picked) {
                        setBrowsing(false);
                        onPick(picked);
                    }
                }} />

            {browsing
                ? <FolderBrowse onPick={folder => { setBrowsing(false); onPick(folder); }} onCancel={() => setBrowsing(false)} />
                : null}
        </div>
    );
}

/** The small folder browser under a folder choice. */
function FolderBrowse({ onPick, onCancel }: { onPick(folder: string): void; onCancel(): void }) {

    const { listing, loading, problem, browse: load } = useFolderBrowser();
    const [typed, setTyped] = useState("");

    /** True once the person types in the box, until they ask for another folder level. */
    const edited = useRef(false);

    // A new folder level: its path in the box - unless the person typed
    // there since asking, so a level that arrives late does not wipe it.
    useEffect(() => {

        if (listing && !edited.current)
            setTyped(listing.path);
    }, [listing]);

    /** Asks for another folder level; its path goes in the box when it comes. */
    const browse = (folder?: string): void => {

        edited.current = false;
        load(folder);
    };

    const top = listing !== undefined && listing.path === "";

    // The top level: the working folders, by their full path, above the drives.
    const working = top ? (listing.working ?? []).map(one => ({ name: one, path: one })) : [];
    const folders = [...working, ...(listing?.entries ?? []).filter(one => !one.file)];

    return (
        <section className="eesha-ws-browse" aria-label="Browse folders">
            <form
                className="eesha-ws-browse-path"
                onSubmit={event => {
                    event.preventDefault();
                    browse(typed.trim() || undefined);
                }}>
                <Button size="sm" fill="ghost" variant="secondary" type="button" aria-label="Up one folder" disabled={!listing || top || loading} onClick={() => browse(listing?.parent || undefined)}>
                    <UiIcon name="arrow-up" />
                </Button>
                <Input size="sm" aria-label="Folder path" placeholder="Type or paste a folder path, then press Enter" value={typed} onChange={event => { edited.current = true; setTyped(event.target.value); }} />
            </form>

            <ul className="eesha-ws-browse-list" aria-busy={loading}>
                {folders.map((one, index) => (
                    <li key={(index < working.length ? "working:" : "") + one.path}>
                        <button type="button" className="eesha-ws-browse-entry" onClick={() => browse(one.path)}>
                            <UiIcon name="folder-open" /> <span>{one.name}</span>
                        </button>
                    </li>
                ))}
                {listing && !top && !folders.length ? <li className="eesha-workspace-quiet">No folders in here.</li> : null}
            </ul>

            {problem ? <p className="eesha-new-spec-problem" role="alert">{problem}</p> : null}

            <div className="eesha-ws-browse-actions">
                <Button size="sm" variant="secondary" fill="outline" onClick={onCancel}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={!typed.trim() || loading} onClick={() => onPick(typed.trim())}>Use this folder</Button>
            </div>
        </section>
    );
}
