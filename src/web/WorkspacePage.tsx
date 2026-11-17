import React, { useEffect, useMemo, useState } from "react";

import { runtimeLabel } from "../view/ChatView";
import { startAgo, startAgoText, waitingHeading } from "../view/start/startText";
import { Button, LibraryWorkspacePage, type StartCard, type StartSession, type WorkspacePageAction, type WorkspaceSpec } from "../view/ui";
import { API, type ChatRow, type SpecExplorerView, type Workspace, workspaceKey } from "../server/protocol";
import { bridge } from "./bridge";
import { specHref } from "./chatGroups";
import { chatAddress } from "./pageRoute";
import { type StartPickBody, useStartPicks } from "./startPicks";
import { useNow } from "./StartPage";
import { stateWord } from "./startView";
import { foldersText, linkLabel, RECENT_SPECS_COUNT, recentSpecFacts, recentSpecId, recentSpecs, runtimeText, specCount, workspaceChats } from "./workspaceView";

/*
 * A workspace's own page, at `/workspace?workspace=<key>`: what the
 * start page is for the whole app, for one workspace. Top to bottom: its
 * name, work item, folders and runtime with Edit workspace and Archive,
 * the sessions here waiting for an answer, a box to start a session
 * here, the cards (Resume, New spec, Spec explorer, Next work item), then
 * its recent specs and recent sessions side by side.
 *
 * The UI library's WorkspacePage draws it. This file picks what goes on
 * it (workspaceView.ts) and reads the workspace's specs from the server,
 * again whenever a spec changes. The spec parts show only with the SDD
 * module on.
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

    /** The SDD module shows. Unknown until the server's hello. */
    sdd: boolean | undefined;

    /** Makes a new session in the workspace, puts `text` in its box and opens it. */
    onStart(workspace: Workspace, text: string, pick?: StartPickBody): void;

    onEdit(workspace: Workspace): void;

    onArchive(workspace: Workspace, archived: boolean): void;

    onNextItem(workspace: Workspace): void;

    /** Opens the New spec window. */
    onNewSpec(): void;

    /** Opens the Spec explorer on the right. */
    onSpecExplorer(): void;
}

export default function WorkspacePage(props: WorkspacePageProps): React.JSX.Element {

    const { workspaces, workspaceKey: key, loaded } = props;

    const workspace = useMemo(() => workspaces.find(one => workspaceKey(one) === key), [workspaces, key]);

    if (!workspace)
        return (
            <div className="eesha-gone">
                <h2>{loaded ? "That workspace is not here" : "Loading the workspace..."}</h2>
                {loaded ? <p>It may have been removed. Pick another one in the session list, or open the start page.</p> : null}
                {loaded ? <Button variant="primary" onClick={() => location.assign(chatAddress(undefined))}>Open the start page</Button> : null}
            </div>
        );

    return <ShownWorkspace {...props} workspace={workspace} />;
}

/** The page of a workspace that is there. */
function ShownWorkspace({ workspace, chats, loaded, sdd, onStart, onEdit, onArchive, onNextItem, onNewSpec, onSpecExplorer }: WorkspacePageProps & { workspace: Workspace }): React.JSX.Element {

    const key = workspaceKey(workspace);
    const now = useNow();
    const [text, setText] = useState("");
    const picks = useStartPicks(workspace);
    const here = useMemo(() => workspaceChats(chats, key), [chats, key]);

    // The specs, read again whenever one changes. Only with the SDD module
    // on: the spec parts are not drawn without it.
    const [specs, setSpecs] = useState<SpecExplorerView | undefined>();
    const [specProblem, setSpecProblem] = useState<string | undefined>();

    useEffect(() => {

        if (sdd !== true || workspace.archived)
            return;

        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const read = () => void bridge.request<SpecExplorerView>(API.sddExplorer, { workspace: key })
            .then(answer => {

                if (!live)
                    return;

                if (answer.problem || !Array.isArray(answer.folders))
                    return setSpecProblem(answer.problem ?? "The server sent no list.");

                setSpecProblem(undefined);
                setSpecs(answer);
            })
            .catch(() => undefined);

        read();

        // A phase writing its document says so many times in a row: read once.
        const off = bridge.onPage(message => {

            if (message.type === "eesha.specsChanged" || message.type === "eesha.hello") {

                clearTimeout(timer);
                timer = setTimeout(read, 300);
            }
        });

        return () => { live = false; clearTimeout(timer); off(); };

    }, [sdd, key, workspace.archived, workspace.folders.join("|")]);

    const toSession = (chat: ChatRow): StartSession => ({
        id: chat.chatId,
        title: chat.title,
        href: chatAddress(chat.chatId),
        // Every session here is in this workspace: no folder name on the rows.
        folder: "",
        ago: startAgo(chat.at, now),
        state: stateWord(chat),
        waitingText: chat.waiting
    });

    const sddOn = sdd === true && !workspace.archived;

    const recent = specs ? recentSpecs(specs, RECENT_SPECS_COUNT) : [];
    const total = specs ? specCount(specs) : 0;

    const specRows: WorkspaceSpec[] = recent.map(one => ({
        id: recentSpecId(one),
        name: one.spec.name,
        href: specHref(chats, key, one.spec.name, one.folder),
        facts: recentSpecFacts(one.spec),
        ago: one.spec.modified !== undefined ? startAgo(one.spec.modified, now) : "",
        state: one.spec.waiting ? "waiting" : one.spec.working ? "working" : undefined,
        ...(one.folder ? { tip: `In ${one.folder}` } : {})
    }));

    const last = here.last;

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
        ...(sddOn
            ? [
                { key: "new-spec", icon: "file-new" as const, title: "New spec", note: workspace.link ? "From this workspace's work item" : "Start a spec here", onClick: onNewSpec },
                { key: "explorer", icon: "checklist" as const, title: "Spec explorer", note: "Every spec here", onClick: onSpecExplorer }
            ]
            : []),
        ...(!workspace.archived
            ? [{ key: "next", icon: "next-step" as const, title: "Next work item", note: "A new workspace on the same folders", onClick: () => onNextItem(workspace) }]
            : [])
    ];

    const actions: WorkspacePageAction[] = [
        { label: "Edit workspace", icon: "tune", onClick: () => onEdit(workspace) },
        workspace.archived
            ? { label: "Unarchive", icon: "unarchive", onClick: () => onArchive(workspace, false) }
            : { label: "Archive", icon: "archive", onClick: () => onArchive(workspace, true) }
    ];

    const runtime = runtimeText(workspace);

    const facts = [
        foldersText(workspace),
        workspace.runtime ? `${runtimeLabel(workspace.runtime)}${workspace.model ? ` · ${workspace.model}` : ""}` : "the server's default runtime"
    ].join(" · ");

    return (
        <LibraryWorkspacePage
            name={workspace.name}
            facts={facts}
            factsTip={workspace.folders.join("\n")}
            link={workspace.link ? { label: linkLabel(workspace.link), ...(workspace.link.url ? { href: workspace.link.url } : {}) } : undefined}
            actions={actions}
            archivedText={workspace.archived ? "This workspace is archived. Unarchive it to start sessions and specs in it again." : undefined}
            waiting={here.waiting.map(toSession)}
            waitingHeading={waitingHeading(here.waiting.length)}
            defaultsNote={runtime && !picks.ready ? runtime : undefined}
            text={text}
            onTextChange={setText}
            providerParts={picks.parts}
            permission={picks.permission}
            onStart={() => onStart(workspace, text, picks.pickBody())}
            testId="eesha-workspace"
            cards={cards}
            specs={sddOn
                ? {
                    rows: specRows,
                    loaded: specs !== undefined,
                    ...(specProblem ? { problem: specProblem } : {}),
                    emptyText: "No specs here yet. Make one with New spec.",
                    ...(total > RECENT_SPECS_COUNT ? { more: { label: `Show more (${total - RECENT_SPECS_COUNT} more)`, onClick: onSpecExplorer } } : {})
                }
                : undefined}
            recent={here.recent.map(toSession)}
            loaded={loaded}
        />
    );
}
