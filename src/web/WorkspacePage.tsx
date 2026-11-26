import React, { useMemo, useState } from "react";

import { startAgoText } from "../view/start/startText";
import { Button, PermissionLevelPicker, ProviderLine, type StartCard, StartCardView } from "../view/ui";
import { type ChatRow, type Workspace, workspaceKey } from "../server/protocol";
import { chatAddress, goTo } from "./pageRoute";
import { type StartPickBody, useStartPicks } from "./startPicks";
import { useNow } from "./StartPage";
import { stateWord } from "./startView";
import { readWatched } from "./widgets/watchedSpec";
import { lastSpecChat, runtimeText, type SpecPlace, workspaceChats } from "./workspaceView";

/*
 * A workspace's own page, at `/<workspace name>` (shared/pageAddress.ts). Top to bottom:
 * a box to start a session here, then the cards Resume, New spec and Next
 * work item.
 *
 * No heading: the header's workspace picker names the workspace, and its
 * menu has Edit workspace and Archive. The workspace's specs, sessions
 * and the ones waiting for you are in the Sessions section of the
 * workspace panel.
 *
 * Beside a spec (a spec tab in front) the page is the spec's own pane,
 * not the workspace's:
 * 1. The spec has a session (its newest phase chat, or a normal chat tied
 *    to it): the page goes to that session, with the spec beside it -
 *    App.tsx does the move; this only says so until it happens.
 * 2. No session has worked on it: a box whose Send starts the spec's
 *    next phase, with what you typed handed to that phase's first pass.
 *
 * Drawn from the UI library's start page parts, not its WorkspacePage:
 * that one has a heading the header already says, and a box whose button
 * says "Start session", too wide for the narrow column beside a spec.
 */

export interface WorkspacePageProps {

    /** The workspace's key, from the address. */
    workspaceKey: string;

    /** Every workspace - archived ones too. */
    workspaces: readonly Workspace[];

    /** Every session from the server. */
    chats: readonly ChatRow[];

    /** False until the first list of sessions and workspaces came. */
    loaded: boolean;

    /** The spec whose tab is in front, beside the page: the page is that spec's pane. */
    besideSpec?: SpecPlace;

    /** Makes a new session in the workspace, puts `text` in its box and opens it. */
    onStart(workspace: Workspace, text: string, pick?: StartPickBody): void;

    /**
     * The spec's box: starts the spec's next phase with `text` for its
     * first pass. Done when the page moves to the phase chat, or when it
     * did not start (a notice says why).
     */
    onSpecSend(spec: SpecPlace, text: string): Promise<void>;

    onNextItem(workspace: Workspace): void;

    /** Opens the New spec window. */
    onNewSpec(): void;
}

export default function WorkspacePage(props: WorkspacePageProps): React.JSX.Element {

    const { workspaces, workspaceKey: key, loaded } = props;

    const workspace = useMemo(() => workspaces.find(one => workspaceKey(one) === key), [workspaces, key]);

    if (!workspace)
        return (
            <div className="eesha-gone">
                <h2>{loaded ? "That workspace is not here" : "Loading the workspace..."}</h2>
                {loaded ? <p>It may have been removed. Pick another one in the header, or open the start page.</p> : null}
                {loaded ? <Button variant="primary" onClick={() => goTo(chatAddress(undefined))}>Open the start page</Button> : null}
            </div>
        );

    return props.besideSpec
        ? <SpecPane {...props} spec={props.besideSpec} />
        : <ShownWorkspace {...props} workspace={workspace} />;
}

/** The pane beside a spec - see the note at the top of this file. */
function SpecPane({ chats, loaded, workspaceKey: key, spec, onSpecSend }: WorkspacePageProps & { spec: SpecPlace }): React.JSX.Element {

    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);

    const last = lastSpecChat(chats, key, spec, chatId => readWatched(chatId));

    if (!loaded || last)
        return (
            <div className="ee-start eesha-workspace-page">
                <div className="ee-start__column">
                    <p className="ee-start__note">{last ? `Opening ${last.title}...` : "Reading the spec's sessions..."}</p>
                </div>
            </div>
        );

    const send = (): void => {

        if (sending)
            return;

        setSending(true);
        void onSpecSend(spec, text).finally(() => setSending(false));
    };

    return (
        <div className="ee-start eesha-workspace-page">
            <div className="ee-start__column">
                <section className="ee-start__box" aria-label="Start the spec">
                    <div className="ee-start__box-head">
                        <span>Start the next phase of {spec.spec}</span>
                    </div>
                    <textarea
                        className="ee-start__text"
                        aria-label="What should the next phase know?"
                        placeholder="What should the next phase know? Optional - Send with nothing typed starts it as the main button does."
                        rows={4}
                        value={text}
                        disabled={sending}
                        onChange={event => setText(event.target.value)}
                        onKeyDown={event => {

                            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {

                                event.preventDefault();
                                send();
                            }
                        }} />
                    <div className="ee-start__box-foot">
                        <div className="ee-start__picks">
                            <span className="ee-start__note">Runs on the runtime and model style.yml names for the phase. Ctrl+Enter to send</span>
                        </div>
                        <Button variant="primary" size="lg" className="ee-start__go" disabled={sending} onClick={send}>Send</Button>
                    </div>
                </section>
            </div>
        </div>
    );
}

/** The page of a workspace that is there, with no spec in front. */
function ShownWorkspace({ workspace, chats, onStart, onNextItem, onNewSpec }: WorkspacePageProps & { workspace: Workspace }): React.JSX.Element {

    const key = workspaceKey(workspace);
    const now = useNow();
    const [text, setText] = useState("");
    const picks = useStartPicks(workspace);
    const here = useMemo(() => workspaceChats(chats, key), [chats, key]);

    const last = here.last;
    const open = !workspace.archived;

    const cards: StartCard[] = [
        ...(last
            ? [{
                key: "resume",
                icon: "chat" as const,
                title: `Resume: ${last.title}`,
                note: [startAgoText(last.at, now), stateWord(last)].filter(Boolean).join(" · "),
                href: chatAddress(last.chatId)
            }]
            : []),
        ...(open
            ? [{ key: "new-spec", icon: "file-new" as const, title: "New spec", note: workspace.link ? "From this workspace's work item" : "Start a spec here", onClick: onNewSpec }]
            : []),
        ...(open
            ? [{ key: "next", icon: "next-step" as const, title: "Next work item", note: "A new workspace on the same folders", onClick: () => onNextItem(workspace) }]
            : [])
    ];

    const runtime = runtimeText(workspace);
    const send = (): void => onStart(workspace, text, picks.pickBody());

    return (
        <div className="ee-start eesha-workspace-page" data-testid="eesha-workspace">
            <div className="ee-start__column">

                {open
                    ? (
                        <section className="ee-start__box" aria-label="Start a session">
                            <div className="ee-start__box-head">
                                <span>New session in {workspace.name}</span>
                                {runtime && !picks.ready ? <span className="ee-start__note ee-start__defaults">{runtime}</span> : null}
                            </div>
                            <textarea
                                className="ee-start__text"
                                aria-label="What do you want to do?"
                                placeholder="What do you want to do? @ for files, / for commands"
                                rows={3}
                                value={text}
                                onChange={event => setText(event.target.value)}
                                onKeyDown={event => {

                                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {

                                        event.preventDefault();
                                        send();
                                    }
                                }} />
                            <div className="ee-start__box-foot">
                                <div className="ee-start__picks">
                                    {picks.parts.length ? <ProviderLine parts={picks.parts} look="menus" testId="eesha-workspace" capitalizeNames /> : null}
                                    {picks.permission ? <PermissionLevelPicker {...picks.permission} /> : null}
                                    <span className="ee-start__note">Ctrl+Enter to send</span>
                                </div>
                                <Button variant="primary" size="lg" className="ee-start__go" onClick={send}>Send</Button>
                            </div>
                        </section>
                    )
                    : <p className="eesha-workspace-archived">This workspace is archived. Unarchive it in the header's workspace menu to start sessions and specs in it again.</p>}

                {cards.length
                    ? (
                        <div className="ee-start__cards">
                            {cards.map(card => <StartCardView key={card.key} card={card} />)}
                        </div>
                    )
                    : null}
            </div>
        </div>
    );
}
