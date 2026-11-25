import React, { useCallback, useEffect, useState } from "react";

import { Button, ChoiceButtons, ConfirmModal, Input, Modal, Select, Textarea, Toggle } from "../view/ui";
import { API, type ConnectorAccess, type MemoryChoices, type MemoryEdit, type MemoryGroup, type MemoryLevel, type MemoryRow, type MemoryView } from "../server/protocol";
import { bridge } from "./bridge";
import { settingsAddress } from "./pageRoute";

/*
 * Memory in Settings, two places:
 *
 *   MemoryPage       the Memory section: every memory, grouped as Global,
 *                    each workspace and each folder. Add, Edit (the text,
 *                    or where it belongs), Delete, and for a folder that
 *                    was moved, give its memories to the folder it is now.
 *   MemoryConnector  the Memory block of the Connectors section: what the
 *                    agent may do, whether its saves ask first, and
 *                    Claude's own memory.
 *
 * Both ask the server for the same MemoryView and show what comes back.
 */

const ACCESS: { value: ConnectorAccess; label: string }[] = [
    { value: "off", label: "Off" },
    { value: "read", label: "Read" },
    { value: "write", label: "Read and write" }
];

const LEVELS: { value: MemoryLevel; label: string }[] = [
    { value: "global", label: "Global" },
    { value: "workspace", label: "A workspace" },
    { value: "folder", label: "A folder" }
];

const ACCESS_WORDS: Record<ConnectorAccess, string> = {
    off: "Memory is off: no session gets it.",
    read: "The agent may read the memory. It may not change it.",
    write: "The agent may read the memory, and save, change and delete memories."
};

/** Asks the server and keeps its answer. Every change comes back as the whole view. */
function useMemoryView() {

    const [view, setView] = useState<MemoryView | undefined>();
    const [problem, setProblem] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    const send = useCallback(async (route: string, body: Record<string, unknown>): Promise<boolean> => {

        setBusy(true);
        setProblem(undefined);

        try {

            const answer = await bridge.request<Partial<MemoryView>>(route, body);

            if (answer.problem || !answer.groups || !answer.choices) {

                setProblem(answer.problem ?? "The server did not answer.");

                return false;
            }

            setView(answer as MemoryView);

            return true;

        } catch (error) {

            setProblem(`Could not reach the server: ${(error as Error).message}`);

            return false;

        } finally {

            setBusy(false);
        }
    }, []);

    useEffect(() => { void send(API.memory, {}); }, [send]);

    return { view, problem, busy, send, setProblem };
}

/** What the Add or Edit window holds. */
interface Draft {

    id?: number;

    level: MemoryLevel;

    /** The workspace's key. */
    workspace: string;

    /** The folder's full path. */
    folder: string;

    title: string;

    text: string;
}

/** "3 Nov 2026" - the day a memory was last changed. */
function dayOf(at: number): string {

    return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function groupHeading(group: MemoryGroup): string {

    return group.level === "global" ? "Global" : group.level === "workspace" ? `Workspace: ${group.label}` : `Folder: ${group.label}`;
}

export default function MemoryPage() {

    const { view, problem, busy, send, setProblem } = useMemoryView();
    const [draft, setDraft] = useState<Draft | undefined>();
    const [removing, setRemoving] = useState<MemoryRow | undefined>();

    /** The folder group being given to another folder, and the path typed. */
    const [moving, setMoving] = useState<{ group: MemoryGroup; to: string } | undefined>();

    if (!view)
        return problem
            ? <p className="ee-settings__problem" role="alert">{problem}</p>
            : <p className="ee-settings__quiet">Loading…</p>;

    const startAdding = (group?: MemoryGroup): void => {

        setProblem(undefined);

        setDraft({
            level: group?.level ?? "global",
            workspace: group?.level === "workspace" ? group.owner : view.workspaces[0]?.key ?? "",
            folder: group?.level === "folder" ? group.label : view.folders[0] ?? "",
            title: "",
            text: ""
        });
    };

    const startEditing = (group: MemoryGroup, row: MemoryRow): void => {

        setProblem(undefined);

        setDraft({
            id: row.id,
            level: row.level,
            workspace: row.level === "workspace" ? row.owner : view.workspaces[0]?.key ?? "",
            folder: row.level === "folder" ? group.label : view.folders[0] ?? "",
            title: row.title,
            text: row.text
        });
    };

    const save = async (): Promise<void> => {

        if (!draft)
            return;

        const memory: MemoryEdit = {
            ...(draft.id !== undefined ? { id: draft.id } : {}),
            level: draft.level,
            ...(draft.level === "workspace" ? { owner: draft.workspace } : draft.level === "folder" ? { owner: draft.folder } : {}),
            title: draft.title,
            text: draft.text
        };

        if (await send(API.memorySave, { memory }))
            setDraft(undefined);
    };

    const remove = async (row: MemoryRow): Promise<void> => {

        setRemoving(undefined);

        await send(API.memoryRemove, { id: row.id });
    };

    const move = async (): Promise<void> => {

        if (moving && await send(API.memoryRepoint, { from: moving.group.owner, to: moving.to }))
            setMoving(undefined);
    };

    // The workspace a memory is already in may be archived or gone: it stays on offer for that memory.
    const workspaceItems = [
        ...view.workspaces,
        ...view.groups
            .filter(group => group.level === "workspace" && !view.workspaces.some(one => one.key === group.owner))
            .map(group => ({ key: group.owner, name: `${group.label} (${group.missing === "archived" ? "archived" : "gone"})` }))
    ];

    const count = view.groups.reduce((sum, group) => sum + group.memories.length, 0);

    return (
        <div className="eesha-memory">
            <section aria-label="Memory">
                <p>
                    Memories are short facts kept between sessions. Every runtime gets the same ones: the titles are told to each new session, and the agent reads the rest with its memory tools.
                </p>
                <p className="ee-settings__quiet">
                    {ACCESS_WORDS[view.choices.access]} Change it under <a href={settingsAddress("connectors")}>Connectors</a>. In the message box, <code>&gt;memory</code> puts one memory into a message.
                </p>
                {problem && !draft && !moving ? <p className="ee-settings__problem" role="alert">{problem}</p> : null}
                <p>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => startAdding()}>Add a memory</Button>
                    <span className="ee-settings__quiet"> {count === 1 ? "1 memory saved." : `${count} memories saved.`}</span>
                </p>
            </section>

            {view.groups.map(group => (
                <section key={`${group.level}:${group.owner}`} aria-label={groupHeading(group)}>
                    <h2 className="eesha-memory__heading">
                        <span className={group.level === "folder" ? "ee-settings__path ee-settings__path--wrap" : undefined}>{groupHeading(group)}</span>
                        {group.missing === "archived" ? <span className="ee-settings__tag">Archived</span> : null}
                        {group.missing === "gone" ? <span className="ee-settings__tag">{group.level === "folder" ? "Not on this machine" : "Workspace removed"}</span> : null}
                        {group.level === "folder"
                            ? <Button size="xs" fill="outline" disabled={busy} onClick={() => { setProblem(undefined); setMoving({ group, to: "" }); }}>Folder moved…</Button>
                            : null}
                    </h2>
                    {group.level === "global" ? <p className="ee-settings__quiet">Every session gets these.</p> : null}
                    {group.level === "workspace" ? <p className="ee-settings__quiet">Only sessions in this workspace get these.</p> : null}
                    {group.level === "folder" ? <p className="ee-settings__quiet">Any session that has this folder gets these.</p> : null}
                    {group.memories.length
                        ? (
                            <ul className="eesha-memory__list">
                                {group.memories.map(row => (
                                    <li key={row.id}>
                                        <div className="eesha-memory__body">
                                            <div>
                                                <strong>{row.title}</strong>
                                                <span className="ee-settings__quiet"> - memory {row.id}, {row.author === "ai" ? "saved by an agent" : "written by you"}, {dayOf(row.updated)}</span>
                                            </div>
                                            <p className="eesha-memory__text">{row.text}</p>
                                        </div>
                                        <Button size="sm" fill="outline" disabled={busy} aria-label={`Edit ${row.title}`} onClick={() => startEditing(group, row)}>Edit</Button>
                                        <Button size="sm" variant="danger" fill="outline" disabled={busy} aria-label={`Delete ${row.title}`} onClick={() => setRemoving(row)}>Delete</Button>
                                    </li>
                                ))}
                            </ul>
                        )
                        : <p className="ee-settings__quiet">Nothing saved here yet.</p>}
                </section>
            ))}

            {draft
                ? (
                    <Modal show onHide={() => setDraft(undefined)} className="eesha-wide-modal">
                        <Modal.Header closeButton onClose={() => setDraft(undefined)}>
                            <Modal.Title>{draft.id === undefined ? "Add a memory" : "Edit the memory"}</Modal.Title>
                        </Modal.Header>
                        <Modal.Body>
                            <div className="eesha-memory__form">
                                <label htmlFor="eesha-memory-title">Title</label>
                                <Input id="eesha-memory-title" value={draft.title} maxLength={120} autoFocus placeholder="One short line that says what the fact is about" onChange={event => setDraft({ ...draft, title: event.target.value })} />

                                <label htmlFor="eesha-memory-text">Text</label>
                                <Textarea id="eesha-memory-text" rows={8} value={draft.text} maxLength={8000} placeholder="The fact itself, in plain sentences" onChange={event => setDraft({ ...draft, text: event.target.value })} />

                                <span id="eesha-memory-level">Who gets it</span>
                                <ChoiceButtons label="Who gets it" options={LEVELS} value={draft.level} onChange={level => setDraft({ ...draft, level })} />

                                {draft.level === "workspace"
                                    ? (
                                        <>
                                            <span id="eesha-memory-workspace">Workspace</span>
                                            {workspaceItems.length
                                                ? <Select items={workspaceItems} labelKey="name" valueKey="key" value={draft.workspace} hideSearch={workspaceItems.length < 8} aria-labelledby="eesha-memory-workspace" onChange={key => setDraft({ ...draft, workspace: String(key) })} />
                                                : <span className="ee-settings__quiet">There is no workspace yet.</span>}
                                        </>
                                    )
                                    : null}

                                {draft.level === "folder"
                                    ? (
                                        <>
                                            <label htmlFor="eesha-memory-folder">Folder</label>
                                            <Input id="eesha-memory-folder" list="eesha-memory-folders" value={draft.folder} placeholder="The folder's full path" onChange={event => setDraft({ ...draft, folder: event.target.value })} />
                                        </>
                                    )
                                    : null}
                            </div>
                            <datalist id="eesha-memory-folders">
                                {view.folders.map(folder => <option key={folder} value={folder} />)}
                            </datalist>
                            {problem ? <p className="ee-settings__problem" role="alert">{problem}</p> : null}
                        </Modal.Body>
                        <Modal.Footer>
                            <Button variant="secondary" fill="outline" onClick={() => setDraft(undefined)}>Cancel</Button>
                            <Button variant="primary" disabled={busy || !draft.title.trim() || !draft.text.trim()} onClick={() => void save()}>Save</Button>
                        </Modal.Footer>
                    </Modal>
                )
                : null}

            {moving
                ? (
                    <Modal show onHide={() => setMoving(undefined)} className="eesha-wide-modal">
                        <Modal.Header closeButton onClose={() => setMoving(undefined)}>
                            <Modal.Title>Folder moved</Modal.Title>
                        </Modal.Header>
                        <Modal.Body>
                            <p>
                                The {moving.group.memories.length === 1 ? "memory" : `${moving.group.memories.length} memories`} of <code>{moving.group.label}</code> go to the folder you give here. Use it when the folder was moved or renamed.
                            </p>
                            <div className="eesha-memory__form">
                                <label htmlFor="eesha-memory-move">New folder</label>
                                <Input id="eesha-memory-move" list="eesha-memory-move-folders" value={moving.to} autoFocus placeholder="The folder's full path" onChange={event => setMoving({ ...moving, to: event.target.value })} />
                            </div>
                            <datalist id="eesha-memory-move-folders">
                                {view.folders.map(folder => <option key={folder} value={folder} />)}
                            </datalist>
                            {problem ? <p className="ee-settings__problem" role="alert">{problem}</p> : null}
                        </Modal.Body>
                        <Modal.Footer>
                            <Button variant="secondary" fill="outline" onClick={() => setMoving(undefined)}>Cancel</Button>
                            <Button variant="primary" disabled={busy || !moving.to.trim()} onClick={() => void move()}>Move</Button>
                        </Modal.Footer>
                    </Modal>
                )
                : null}

            {removing
                ? (
                    <ConfirmModal
                        text={`Delete the memory "${removing.title}"? It cannot be brought back.`}
                        confirm="Delete"
                        onCancel={() => setRemoving(undefined)}
                        onConfirm={() => void remove(removing)} />
                )
                : null}
        </div>
    );
}

/** The Memory block of the Connectors section. */
export function MemoryConnector() {

    const { view, problem, busy, send } = useMemoryView();

    const change = (choices: Partial<MemoryChoices>): void => void send(API.memoryChoices, { choices });

    return (
        <div className="eesha-memory eesha-memory--card">
            <section aria-label="Memory">
                <h2>Memory</h2>
                <p className="ee-settings__quiet">
                    Eesha Code's own memory: short facts kept between sessions, the same for every runtime. Every new session is told the titles and gets tools to read them. In the message box, <code>&gt;memory&gt;global&gt;12</code> puts one into a message. <a href={settingsAddress("memory")}>See and edit the memories</a>.
                </p>
                {problem ? <p className="ee-settings__problem" role="alert">{problem}</p> : null}
                {view
                    ? (
                        <ul className="eesha-memory__choices">
                            <li>
                                <span>
                                    <strong>What the agent may do</strong>
                                    <span className="ee-settings__quiet"> - {ACCESS_WORDS[view.choices.access]}</span>
                                </span>
                                <ChoiceButtons label="What the agent may do with the memory" options={ACCESS} value={view.choices.access} disabled={busy} onChange={access => change({ access })} />
                            </li>
                            <li>
                                <span id="eesha-memory-ask">
                                    <strong>Ask me before the agent saves, changes or deletes a memory</strong>
                                    <span className="ee-settings__quiet"> - Off: it does it and shows a short notice.</span>
                                </span>
                                <Toggle size="sm" checked={view.choices.askOnSave} disabled={busy || view.choices.access !== "write"} aria-labelledby="eesha-memory-ask" onChange={askOnSave => change({ askOnSave })} />
                            </li>
                            <li>
                                <span id="eesha-memory-claude">
                                    <strong>Claude's own memory is off in Eesha Code's sessions</strong>
                                    <span className="ee-settings__quiet"> - While memory is on, a Claude session starts only when this is on. Claude Code in your terminal is not changed.</span>
                                </span>
                                <Toggle size="sm" checked={view.choices.claudeMemoryOff} disabled={busy} aria-labelledby="eesha-memory-claude" onChange={claudeMemoryOff => change({ claudeMemoryOff })} />
                            </li>
                        </ul>
                    )
                    : problem ? null : <p className="ee-settings__quiet">Loading…</p>}
            </section>
        </div>
    );
}
