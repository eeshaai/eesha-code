import React, { useCallback, useEffect, useRef, useState } from "react";

import { LibraryMenu, PanelBlank, PanelButton, PanelView, StatusDot, UiIcon } from "../view/ui";
import { API, type ChatRow, type SpecExplorerView, type SpecFolderView, type SpecSessionView, type SpecSort, type SpecTreeRow, type Workspace, workspaceKey } from "../server/protocol";
import { runOption } from "../sdd/view/sessionRuns";
import { bridge } from "./bridge";
import { PromptDialog } from "./Dialogs";
import { specHref } from "./chatGroups";
import { chatAddress, type SddAddressMore } from "./pageRoute";
import { specFacts } from "./specFacts";
import { phaseSessions, specGroups, specKey } from "./specTree";

/*
 * The Spec explorer, in the right panel beside the File explorer: every
 * folder of the workspace, and in each the specs kept there - Eesha
 * specs, Kiro specs and Spec Kit specs, each kind under its own
 * heading. A spec opens to its phases, and a phase to its sessions
 * (newest first). A click on a spec or a phase goes to its newest phase
 * chat with the spec open as a tab beside it; a click on a session goes
 * to that session. A spec with no chat yet opens as a tab on the
 * workspace's page.
 *
 * The heading has New spec (in the main folder; each folder has its own
 * + for one there), the sort, and under "⋯" Copy a style, Clear spec
 * history and the Specs guide.
 */

/** The online guide the Specs guide item opens. */
export const SPECS_GUIDE = "https://github.com/eeshaai/eesha-code#specs";

/** What a click in the explorer opens. */
export interface SpecTarget extends SddAddressMore {

    spec: string;
}

export interface SpecExplorerProps {

    /** The workspace whose folders are listed. Nothing: there is none. */
    workspace?: Workspace;

    /** The spec open on this page, if any. */
    current?: { spec: string; folder?: string };

    /** Every session, for the links: a spec's or a phase's newest chat. */
    chats: readonly ChatRow[];

    hidden?: boolean;

    /** New spec, in `folder` - the main folder when absent. */
    onNew(folder?: string): void;

    onCopyStyle(): void;

    /** Opens a spec, at a phase or a session of it when one was clicked. */
    onOpen(target: SpecTarget): void;

    /** A short message for the person - a toast. */
    onNote(text: string): void;
}

/** The last part of a folder path - what a folder row is called. */
function folderName(folder: string): string {

    return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}

export default function SpecExplorer({ workspace, current, chats, hidden, onNew, onCopyStyle, onOpen, onNote }: SpecExplorerProps) {

    const key = workspace ? workspaceKey(workspace) : undefined;

    const [view, setView] = useState<SpecExplorerView | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    /** What is open: folders start open (a closed one is kept here), specs and phases start closed. */
    const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(new Set());
    const [openSpecs, setOpenSpecs] = useState<ReadonlySet<string>>(() => new Set(current ? [specKey(current.folder ?? "", current.spec)] : []));
    const [openPhases, setOpenPhases] = useState<ReadonlySet<string>>(new Set());

    /** Each open spec's sessions, by its key. */
    const [sessions, setSessions] = useState<Record<string, SpecSessionView[] | undefined>>({});

    const [asking, setAsking] = useState(false);

    /** Read again on every change, so the timers and the open specs are this draw's. */
    const openRef = useRef(openSpecs);

    openRef.current = openSpecs;

    /** The folder as the server is told it: only when it is not the main one. */
    const folderArg = (folder: SpecFolderView) => folder.main ? {} : { folder: folder.folder };

    const readSessions = useCallback(async (folder: SpecFolderView, spec: string) => {

        if (!key)
            return;

        const answer = await bridge.request<{ sessions?: SpecSessionView[] }>(API.sddSessions, { workspace: key, ...folderArg(folder), spec })
            .catch(() => ({ sessions: undefined }));

        setSessions(now => ({ ...now, [specKey(folder.main ? "" : folder.folder, spec)]: answer.sessions ?? [] }));

    }, [key]);

    useEffect(() => {

        if (!key)
            return;

        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const read = () => void bridge.request<SpecExplorerView>(API.sddExplorer, { workspace: key })
            .then(answer => {

                if (!live)
                    return;

                if (answer.problem || !Array.isArray(answer.folders))
                    return setProblem(answer.problem ?? "The server sent no list.");

                setProblem(undefined);
                setView(answer);

                // The open specs' sessions may have moved on too.
                for (const folder of answer.folders)
                    for (const spec of folder.specs)
                        if (openRef.current.has(specKey(folder.main ? "" : folder.folder, spec.name)))
                            void readSessions(folder, spec.name);
            })
            .catch(() => undefined);

        setView(undefined);
        read();

        // A phase writing its document says so many times in a row: read once.
        const off = bridge.onPage(message => {

            if (message.type === "eesha.specsChanged" || message.type === "eesha.hello") {

                clearTimeout(timer);
                timer = setTimeout(read, 300);
            }
        });

        return () => { live = false; clearTimeout(timer); off(); };

    }, [key, workspace?.folders.join("|"), readSessions]);

    const toggle = <T,>(set: ReadonlySet<T>, item: T): Set<T> => {

        const next = new Set(set);

        if (!next.delete(item))
            next.add(item);

        return next;
    };

    const toggleSpec = (folder: SpecFolderView, spec: string) => {

        const id = specKey(folder.main ? "" : folder.folder, spec);

        if (!openSpecs.has(id))
            void readSessions(folder, spec);

        setOpenSpecs(toggle(openSpecs, id));
    };

    const setSort = async (sort: SpecSort): Promise<void> => {

        if (!key)
            return;

        const answer = await bridge.request(API.sddSort, { workspace: key, sort });

        if (answer.problem)
            onNote(answer.problem);
    };

    const clearHistory = async (): Promise<void> => {

        if (!key)
            return;

        const answer = await bridge.request<{ removed?: number }>(API.sddClearHistory, { workspace: key });

        if (answer.problem || typeof answer.removed !== "number")
            return onNote(answer.problem ?? "Could not clear the spec history.");

        onNote(answer.removed === 0
            ? "Nothing to clear - the main folder has no spec history."
            : `Cleared ${answer.removed} stored cop${answer.removed === 1 ? "y" : "ies"} of spec documents.`);
    };

    const actions = workspace
        ? (
            <>
                <PanelButton icon="add" label="New spec" onClick={() => onNew()} />
                {view
                    ? (
                        // Shows the other order.
                        view.sort === "alpha"
                            ? <PanelButton icon="history" label="Sort by most recently changed" onClick={() => void setSort("recent")} />
                            : <PanelButton icon="sort-az" label="Sort A to Z" onClick={() => void setSort("alpha")} />
                    )
                    : null}
                <LibraryMenu
                    ariaLabel="More spec actions"
                    placement="bottom"
                    items={[
                        { label: "Copy a style…", icon: "copy", onSelect: onCopyStyle },
                        { label: "Clear spec history…", icon: "clear-all", onSelect: () => setAsking(true) },
                        // A new browser tab, so this page stays where it is.
                        { label: "Specs guide", icon: "book", href: SPECS_GUIDE, onSelect: () => void window.open(SPECS_GUIDE, "_blank", "noopener,noreferrer") }
                    ]}
                    // The menu opens from a click on its wrapper; the button itself does nothing.
                    trigger={<PanelButton icon="more" label="More spec actions" onClick={() => undefined} />} />
            </>
        )
        : undefined;

    /** A chevron that opens and closes a row. */
    const chevron = (open: boolean, label: string, onClick: () => void) => (
        <button type="button" className="eesha-spec-tree__toggle" aria-expanded={open} aria-label={label} title={label} onClick={onClick}>
            <UiIcon name={open ? "expand" : "chevron-right"} size="sm" />
        </button>
    );

    /**
     * A link that opens the spec. A plain click is the page's: it goes to
     * the phase chat. Its address is for a new browser tab: the session's
     * own page when the row is a session, else the newest chat of the spec
     * or of the phase, with the spec as a tab - or the workspace's page
     * with the spec as a tab, when no chat has started yet.
     */
    const opener = (folder: SpecFolderView, target: SpecTarget, text: React.ReactNode, title: string, active = false, chatId?: string) => {

        const more: SpecTarget = { ...target, ...(folder.main ? {} : { folder: folder.folder }) };

        return (
            <a
                className="eesha-spec-tree__open"
                href={chatId
                    ? chatAddress(chatId, { spec: target.spec, ...(more.folder ? { folder: more.folder } : {}) })
                    : key ? specHref(chats, key, target.spec, more.folder, target.session?.ownerId ?? target.phase) : undefined}
                aria-current={active ? "page" : undefined}
                title={title}
                onClick={event => {

                    // A plain click: the page decides - the spec on screen
                    // moves without a reload. Ctrl or middle click: a new tab.
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0)
                        return;

                    event.preventDefault();
                    onOpen(more);
                }}>
                {text}
            </a>
        );
    };

    const sessionRows = (folder: SpecFolderView, spec: SpecTreeRow, phaseId: string, list: SpecSessionView[]) => (
        <ul className="eesha-spec-tree__list" aria-label={`Sessions of ${phaseId}`}>
            {list.map(one => (
                <li key={`${one.ownerId}#${one.iteration}`} className="eesha-spec-tree__row eesha-spec-tree__row--session">
                    <span className="eesha-spec-tree__spacer" />
                    <UiIcon name="chat" size="sm" className="eesha-spec-tree__mark" />
                    {opener(
                        folder,
                        { spec: spec.name, session: one.current ? { ownerId: one.ownerId } : { ownerId: one.ownerId, iteration: one.iteration } },
                        runOption(one, one.status === "failed" ? "failed" : undefined),
                        `${runOption(one)}${one.model ? `\nModel: ${one.model}` : ""}${one.current ? "" : "\nAn earlier session"}`,
                        false,
                        one.chatId)}
                </li>
            ))}
        </ul>
    );

    const phaseRows = (folder: SpecFolderView, spec: SpecTreeRow) => {

        const id = specKey(folder.main ? "" : folder.folder, spec.name);
        const known = sessions[id];

        if (!spec.phases.length)
            return <p className="eesha-spec-tree__none">No style could place this spec, so it has no phases.</p>;

        return (
            <ul className="eesha-spec-tree__list" aria-label={`Phases of ${spec.name}`}>
                {spec.phases.map(phase => {

                    const list = known ? phaseSessions(known, phase.id) : [];
                    const phaseId = `${id}|${phase.id}`;
                    const open = openPhases.has(phaseId);

                    return (
                        <li key={phase.id}>
                            <div className={`eesha-spec-tree__row eesha-spec-tree__row--phase eesha-spec-tree__row--${phase.status}`}>
                                {list.length
                                    ? chevron(open, `${open ? "Hide" : "Show"} the sessions of ${phase.label}`, () => setOpenPhases(toggle(openPhases, phaseId)))
                                    : <span className="eesha-spec-tree__spacer" />}
                                <UiIcon
                                    name={phase.status === "done" ? "check" : phase.status === "next" ? "dot" : "pending"}
                                    size="sm"
                                    className="eesha-spec-tree__mark" />
                                {opener(folder, { spec: spec.name, phase: phase.id }, phase.label, `${phase.label} - ${phase.status === "done" ? "done" : phase.status === "next" ? "the one to run now" : "later"}`)}
                                <span className="eesha-spec-tree__facts">
                                    {phase.chatless
                                        ? "no chat"
                                        : known === undefined
                                            ? ""
                                            : list.length === 1 ? "1 session" : list.length ? `${list.length} sessions` : ""}
                                </span>
                            </div>
                            {open && list.length ? sessionRows(folder, spec, phase.id, list) : null}
                        </li>
                    );
                })}
            </ul>
        );
    };

    const specRows = (folder: SpecFolderView, specs: SpecTreeRow[]) => (
        <ul className="eesha-spec-tree__list">
            {specs.map(spec => {

                const id = specKey(folder.main ? "" : folder.folder, spec.name);
                const open = openSpecs.has(id);
                const active = current?.spec === spec.name && (current.folder ?? "") === (folder.main ? "" : folder.folder);

                return (
                    <li key={spec.name}>
                        <div className={`eesha-spec-tree__row eesha-spec-tree__row--spec${active ? " eesha-spec-tree__row--active" : ""}`}>
                            {chevron(open, `${open ? "Hide" : "Show"} the phases of ${spec.name}`, () => toggleSpec(folder, spec.name))}
                            {opener(folder, { spec: spec.name }, <span className="eesha-spec-tree__name">{spec.name}</span>, `${spec.name}\n${specFacts(spec)}`, active)}
                            {spec.elsewhere ? <span className="eesha-spec-tree__tag" title="Made in another workspace on this folder - another work item">other work item</span> : null}
                            <span className="eesha-spec-tree__facts">{spec.phase ?? ""}</span>
                            {spec.waiting
                                ? <StatusDot tone="waiting" label="waiting for your answer" />
                                : spec.working ? <StatusDot tone="working" label="working" /> : null}
                        </div>
                        {open ? phaseRows(folder, spec) : null}
                    </li>
                );
            })}
        </ul>
    );

    const folderRows = (folder: SpecFolderView) => {

        const open = !closedFolders.has(folder.folder);
        const name = folderName(folder.folder);

        return (
            <li key={folder.folder} className="eesha-spec-tree__folder">
                <div className="eesha-spec-tree__row eesha-spec-tree__row--folder" title={folder.folder}>
                    {chevron(open, `${open ? "Close" : "Open"} ${name}`, () => setClosedFolders(toggle(closedFolders, folder.folder)))}
                    <span className="eesha-spec-tree__folder-name">{name}</span>
                    {folder.main ? <span className="eesha-spec-tree__tag">main</span> : null}
                    <span className="eesha-spec-tree__grow" />
                    <PanelButton icon="add" label={`New spec in ${name}`} onClick={() => onNew(folder.main ? undefined : folder.folder)} />
                </div>
                {open
                    ? (
                        <div className="eesha-spec-tree__inside">
                            {folder.problem ? <p className="eesha-spec-tree__problem" role="alert">{folder.problem}</p> : null}
                            {folder.notes.length
                                ? <ul className="eesha-spec-notes">{folder.notes.map(note => <li key={note}>{note}</li>)}</ul>
                                : null}
                            {folder.specs.length
                                ? specGroups(folder).map(group => (
                                    <section key={group.key} className="eesha-spec-tree__group" aria-label={`${group.label} specs in ${name}`}>
                                        <h3 className="eesha-spec-tree__heading">
                                            {group.label}
                                            <span className="eesha-spec-tree__root">{group.root}</span>
                                        </h3>
                                        {specRows(folder, group.specs)}
                                    </section>
                                ))
                                : folder.problem
                                    ? null
                                    : (
                                        <p className="eesha-spec-tree__none">
                                            No specs in this folder.{" "}
                                            <a href="#" onClick={event => { event.preventDefault(); onNew(folder.main ? undefined : folder.folder); }}>New spec</a>
                                        </p>
                                    )}
                        </div>
                    )
                    : null}
            </li>
        );
    };

    return (
        <PanelView title="Spec explorer" label="Spec explorer" hidden={hidden} className="eesha-spec-explorer" actions={actions}>
            {!workspace
                ? <PanelBlank title="No workspace" text="Specs live in a workspace's folders. Open a session in a workspace, or add one with Add workspace in the AI panel." />
                : problem
                    ? <PanelBlank title="Could not read the specs" text={problem} />
                    : !view
                        ? null
                        : <ul className="eesha-spec-tree eesha-scroll" aria-label="Folders">{view.folders.map(folderRows)}</ul>}
            {asking
                ? (
                    <PromptDialog
                        prompt={{
                            kind: "confirm",
                            text: "Throw away every copy of a spec document put aside for the \"What changed\" view, for every spec in the workspace's main folder? Until each phase runs again, its document will have nothing to compare against. Nothing in your repository is touched.",
                            action: "Clear"
                        }}
                        onAnswer={value => { setAsking(false); if (value !== undefined) void clearHistory(); }} />
                )
                : null}
        </PanelView>
    );
}
