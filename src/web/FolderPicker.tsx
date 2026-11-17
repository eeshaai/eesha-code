import React, { useCallback, useEffect, useState } from "react";

import { LibraryFolderPicker } from "../view/ui";
import { API, FolderListing } from "../server/protocol";
import { bridge } from "./bridge";

/*
 * The folder browser: walk the drives and folders, add folders to the
 * list, and save them. The first folder in the list is where the chat
 * works; the others the agent may also use. With none, the agent works
 * in the chat's own scratch folder.
 *
 * The UI library draws it (FolderPicker there). This file asks the
 * server for each folder level and passes it on.
 */

/** A folder level from the server, and asking for another. */
export interface FolderBrowser {

    listing?: FolderListing;

    loading: boolean;

    problem?: string;

    /** Read this folder's level. Nothing: the top level. */
    browse(folder?: string): void;
}

/**
 * Reads folder levels from the server. Opens on `start`, or with none on
 * the top level: the drives, and the folders used before. `withFiles`:
 * each level lists its files too, for picking files.
 */
export function useFolderBrowser(start?: string, withFiles = false): FolderBrowser {

    const [listing, setListing] = useState<FolderListing | undefined>();
    const [problem, setProblem] = useState<string | undefined>();
    const [loading, setLoading] = useState(false);

    const browse = useCallback((folder?: string): void => {

        void (async () => {

            setLoading(true);

            try {

                const answer = await bridge.request<FolderListing>(API.folders, { ...(folder ? { path: folder } : {}), ...(withFiles ? { files: true } : {}) });

                if (answer.problem && !answer.entries) {

                    setProblem(answer.problem);

                    return;
                }

                setListing(answer);
                setProblem(answer.problem);

            } catch (error) {

                setProblem(`Could not reach the server: ${(error as Error).message}`);

            } finally {

                setLoading(false);
            }
        })();
    }, [withFiles]);

    // Only on the first draw: `start` is where the browser opens, not a level it keeps going back to.
    useEffect(() => browse(start), [browse]);

    return { listing, loading, problem, browse };
}

export interface FolderPickerProps {

    /** The folders already chosen - the session's, when editing them. */
    initial: string[];

    /** Editing a live chat: its first folder stays first and cannot be removed. */
    lockFirst?: boolean;

    /** The chat works in its scratch folder for good: every folder here is an extra, none is "works here". */
    allExtras?: boolean;

    /** An empty list may be saved - the chat then works in its scratch folder. */
    allowEmpty?: boolean;

    submitLabel: string;

    /** Resolves to a problem to show, or nothing when it worked. */
    onSubmit(folders: string[]): Promise<string | undefined>;

    onCancel?(): void;

    /** Shown above the list - why the picker is up. */
    intro?: string;

    /** The chosen list's heading. Default "Folders for this session". */
    heading?: string;

    /** What the list says while it is empty and an empty list cannot be saved. */
    emptyText?: string;

    /** More fields, under the folder browser and above the buttons. */
    extra?: React.ReactNode;

    disabled?: boolean;

    /** The tag beside the first folder. Default here: "main folder", the workspace's word for it. */
    firstTag?: string;
}

/** The tag beside the first folder in Eesha Code: the workspace's main folder, where a session starts. */
export const MAIN_FOLDER_TAG = "main folder";

export default function FolderPicker(props: FolderPickerProps) {

    const { listing, loading, problem, browse } = useFolderBrowser();

    return <LibraryFolderPicker firstTag={MAIN_FOLDER_TAG} {...props} listing={listing} loading={loading} problem={problem} onBrowse={browse} />;
}
