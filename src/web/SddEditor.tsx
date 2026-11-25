import React, { useEffect, useMemo, useState } from "react";

import { API, type SpecSessionView } from "../server/protocol";
import SddSpecView from "../sdd/view/SddSpecView";
import { focusSdd, setSddHost } from "../sdd/view/host";
import { SpecPageContext, type SpecPageExtras } from "../sdd/view/specPage";
import { Button, type MenuEntry, PopoverDefaults } from "../view/ui";
import { bridge } from "./bridge";
import { chatAddress } from "./pageRoute";
import { sddLine, specLine, type SpecShown } from "./sddLine";
import SpecBox from "./SpecBox";

/*
 * The SDD editor: a spec as an editor tab, beside a session - the spec
 * page. Its phases and the one main button are in its header; the box
 * over the document says what waits for you (SpecBox.tsx); the ⋯ menu
 * holds the other views (Prompt, Logs, Wave graph) and the spec's older
 * chats. The phase's conversation is not here: it is the phase chat, a
 * normal session beside it. Its line to the server is sddLine.ts, set
 * here once when this file loads.
 *
 * Only the tab in front is drawn. Brought to the front again, it opens
 * its spec on the server again and draws from what the server sends.
 */
setSddHost(sddLine);

/** How a chat of a spec is named in the ⋯ menu: its phase - `implement@wave:2` is "implement", one chat holds every wave. */
function ownerName(ownerId: string): string {

    const at = ownerId.indexOf("@");

    return at < 0 ? ownerId : ownerId.slice(0, at);
}

export default function SddEditor({ spec, phase, chatWaits, onGoToChat }: {
    spec: SpecShown;

    /** The phase to show first - the phase of the chat beside it. */
    phase?: string;

    /** A question waits in the chat beside the spec, and that chat is the spec's. */
    chatWaits?: boolean;

    /** Puts the cursor in the message box of the chat beside the spec. */
    onGoToChat(): void;
}) {

    const id = JSON.stringify([spec.workspace, spec.spec, spec.folder ?? ""]);

    /** Bumped by "Show it here instead", which opens the spec here again. */
    const [round, setRound] = useState(0);

    /** What the line said of this spec: nothing yet, why it did not open, or that another browser tab took it. */
    const [state, setState] = useState<{ at: string; problem?: string; moved?: boolean } | undefined>();

    const at = `${id}#${round}`;

    /** The spec's chats, newest first - the ⋯ menu's "Chats of this spec". */
    const [sessions, setSessions] = useState<SpecSessionView[]>([]);

    useEffect(() => {

        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const read = () => void bridge.request<{ sessions?: SpecSessionView[] }>(API.sddSessions, { workspace: spec.workspace, spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) })
            .then(answer => {

                if (!live)
                    return;

                // Newest first, each chat once: the runs of one chat (the waves) are one row.
                const seen = new Set<string>();

                setSessions((answer.sessions ?? [])
                    .filter(one => one.chatId)
                    .sort((left, right) => right.at - left.at)
                    .filter(one => !seen.has(one.chatId!) && seen.add(one.chatId!) !== undefined));
            })
            .catch(() => undefined);

        read();

        const off = bridge.onPage(message => {

            if (message.type === "eesha.specsChanged") {

                clearTimeout(timer);
                timer = setTimeout(read, 300);
            }
        });

        return () => { live = false; clearTimeout(timer); off(); };

    }, [id]);

    const extras = useMemo((): SpecPageExtras => {

        const tab = { spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) };

        const menu: MenuEntry[] = sessions.length
            ? [
                "divider",
                { heading: "Chats of this spec" },
                ...sessions.slice(0, 12).map((one): MenuEntry => ({
                    label: `${ownerName(one.ownerId)} · ${new Date(one.at).toLocaleDateString()}`,
                    href: chatAddress(one.chatId, tab),
                    end: one.chatId === bridge.chatId ? "this chat" : one.current ? undefined : "older"
                }))
            ]
            : [];

        return {
            box: <SpecBox workspace={spec.workspace} spec={spec.spec} folder={spec.folder} phase={phase} chatWaits={chatWaits} onGoToChat={onGoToChat} />,
            menu
        };

    }, [sessions, spec.workspace, spec.spec, spec.folder, phase, chatWaits, onGoToChat]);

    useEffect(() => {

        specLine.show(spec, {
            problem: text => setState({ at, problem: text }),
            moved: () => setState({ at, moved: true })
        });

        setState({ at });

        // A wave chat's phase is `implement@wave:2`: the view finds its phase from it.
        if (phase)
            focusSdd(phase.includes("@") ? { ownerId: phase } : { phase });

        return () => specLine.show(undefined);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [at]);

    // Drawn only once the line shows this spec, so the view reads its own page state.
    if (state?.at !== at)
        return null;

    if (state.moved)
        return (
            <div className="eesha-spec-tab">
                <div className="eesha-gone">
                    <h2>This spec is open in another tab</h2>
                    <p>A spec is shown in one browser tab at a time, and it was opened in another one.</p>
                    <Button variant="primary" onClick={() => setRound(now => now + 1)}>Show it here instead</Button>
                </div>
            </div>
        );

    if (state.problem !== undefined)
        return (
            <div className="eesha-spec-tab">
                <div className="eesha-gone">
                    <h2>That spec is not here</h2>
                    <p>{state.problem}</p>
                </div>
            </div>
        );

    return (
        <div className="eesha-spec-tab">
            <PopoverDefaults compactBelow={false}>
                <SpecPageContext.Provider value={extras}>
                    <SddSpecView key={at} />
                </SpecPageContext.Provider>
            </PopoverDefaults>
        </div>
    );
}
