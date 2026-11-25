import React, { useEffect, useMemo, useState } from "react";

import { SessionSearchDialog, type SessionSearchItem } from "../view/ui";
import type { ChatRow, SearchHit } from "../server/protocol";
import { StateDot } from "./ChatList";
import { type Aliases, findChats, folded, folderLine } from "./chatGroups";

/*
 * The search window: the search icon at the top of the strip on the
 * right, or Ctrl+K. The UI library draws it (SessionSearchDialog): a box
 * at the top and the chats found under it, newest first, with its keys.
 * The chat list on the left does not change while searching.
 *
 * This file finds the chats: by name and folder at once, and by what was
 * said in them - the person's messages and the agent's answers - from the
 * server, a moment after typing stops. A chat found by what was said
 * shows the matching line under its name. Pinned and archived chats are
 * found too. The text stays for the next time the window opens.
 */

/** Search starts on the server once this many letters are typed - one letter is in almost every chat. */
const SEARCH_FROM = 2;

/** How long after the last key press the server is asked. */
const SEARCH_WAIT_MS = 200;

export interface SearchDialogProps {

    show: boolean;

    chats: readonly ChatRow[];

    /** The names given to folders. A folder is shown and found by its alias. */
    aliases: Aliases;

    /** The chats whose messages hold this text. Keep it the same function from one draw to the next. */
    searchText(query: string): Promise<readonly SearchHit[]>;

    /** A chat found was picked. The window closes on its own first. */
    onOpen(chatId: string): void;

    onClose(): void;
}

/** Kept on the page while closed, so the text searched for stays for the next time. */
export default function SearchDialog({ show, chats, aliases, searchText, onOpen, onClose }: SearchDialogProps) {

    const [query, setQuery] = useState("");

    /** What the server found for the text searched: chat id to the matching line. */
    const [hits, setHits] = useState<{ query: string; lines: ReadonlyMap<string, string> }>();

    // Asked again when the list changes: a new message may hold the text.
    // Not while the window is closed - it is asked when it opens again.
    useEffect(() => {

        const wanted = folded(query);

        if (!show)
            return;

        if (wanted.length < SEARCH_FROM)
            return setHits(undefined);

        let stale = false;

        const timer = setTimeout(() => {

            void searchText(wanted)
                .then(found => {

                    if (!stale)
                        setHits({ query: wanted, lines: new Map(found.map(hit => [hit.chatId, hit.line])) });
                })
                .catch(() => {

                    if (!stale)
                        setHits({ query: wanted, lines: new Map() });
                });

        }, SEARCH_WAIT_MS);

        return () => {

            stale = true;
            clearTimeout(timer);
        };

    }, [show, query, chats, searchText]);

    const wanted = folded(query);

    // Lines found for an older text are not shown under the new one.
    const lines = hits && hits.query === wanted ? hits.lines : undefined;

    const items = useMemo((): SessionSearchItem[] => findChats(chats, query, aliases, lines).map(chat => {

        // The matching line, unless it only says the chat's name again.
        const said = lines?.get(chat.chatId);
        const hit = said !== undefined && folded(said).toLowerCase() !== folded(chat.title).toLowerCase() ? said : undefined;

        return {
            id: chat.chatId,
            title: chat.title,
            tooltip: `${chat.title}\n${chat.folders.join("\n") || "No workspace - works in its own scratch folder"}`,
            dot: <StateDot chat={chat} />,
            ...(chat.mark ? { mark: chat.mark } : {}),
            folders: folderLine(chat.folders, aliases),
            ...(hit !== undefined ? { hit } : {})
        };

    }), [chats, query, aliases, lines]);

    return (
        <SessionSearchDialog
            show={show}
            query={query}
            onQueryChange={setQuery}
            items={items}
            highlight={wanted}
            // The server has not answered for this text yet.
            searching={wanted.length >= SEARCH_FROM && !lines}
            onOpen={onOpen}
            onClose={onClose} />
    );
}
