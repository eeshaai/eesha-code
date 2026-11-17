import React, { useEffect, useMemo, useState } from "react";

import { runtimeLabel } from "../view/ChatView";
import { Button, Checkbox, Input, Modal, Select, UiIcon } from "../view/ui";
import { AiOptions, ALIAS_LIMIT, API, Workspace, WorkspaceLink } from "../server/protocol";
import ConnectorPick from "./ConnectorPick";
import { bridge } from "./bridge";
import { FolderChoice, useRecentFolders } from "./WorkspaceFolders";

/*
 * The window behind "Add workspace" (at the top of the AI panel's list)
 * and "Edit workspace" (on a workspace's menu). It sets:
 *
 *   - the name the lists show - empty: the main folder's name;
 *   - its folders - the main folder, where a new session starts and
 *     where SDD keeps the specs, then extra folders every new session
 *     may use. Each is picked from the folders used before, or with a
 *     small folder browser (WorkspaceFolders.tsx);
 *   - the runtime, model and effort every new session in it starts on;
 *   - whether a new session may also use the system temp folder;
 *   - the one ADO work item or GitHub issue it is for, picked through
 *     the connectors; its number and title fill an empty name.
 *
 * A session already there keeps what it has. When editing, the main
 * folder cannot change: sessions are listed under a workspace by it.
 *
 * "Next work item" (on a workspace's menu) opens it for a new workspace
 * on the same folders and with the same start choices, but no name and
 * no item: the item list opens at once. The main folder stays locked.
 */

/** The runtime and model lists' "no default" choice. */
const NONE = "";

export default function WorkspaceDialog({ editing, editKey, next, onClose }: {

    /** The workspace changed - or, for a folder sessions work in that is no workspace yet, the one it becomes. Nothing: a new one. */
    editing?: Workspace;

    /** The key of the workspace being changed. Absent: the save adds a workspace. */
    editKey?: string;

    /** "Next work item": a new workspace like this one. */
    next?: Workspace;

    onClose(): void;
}) {

    const [options, setOptions] = useState<AiOptions | undefined>();
    const recent = useRecentFolders();

    // What the fields start with: the workspace changed, else the one the next work item follows.
    const base = editing ?? next;
    const locked = base !== undefined;

    const [name, setName] = useState(editing?.name ?? "");
    const [folders, setFolders] = useState<string[]>(base?.folders ?? []);
    const [runtime, setRuntime] = useState(base?.runtime ?? NONE);
    const [model, setModel] = useState(base?.model ?? NONE);
    const [effort, setEffort] = useState(base?.effort ?? NONE);
    const [tempFolder, setTempFolder] = useState(base?.tempFolder === true);
    const [problem, setProblem] = useState<string | undefined>();
    const [saving, setSaving] = useState(false);

    /** The work item or issue this workspace is for. */
    const [link, setLink] = useState<WorkspaceLink | undefined>(editing?.link);
    const [picking, setPicking] = useState(next !== undefined);

    /** The name was filled from the item, not typed: picking another item changes it too. */
    const [autoName, setAutoName] = useState(false);

    useEffect(() => {

        let live = true;

        void bridge.request<AiOptions>(API.aiOptions, {}).then(answer => {

            if (live && Array.isArray(answer.runtimes))
                setOptions(answer);
        });

        return () => { live = false; };
    }, []);

    const runtimes = useMemo(() => (options?.runtimes ?? []).map(id => ({ id, label: runtimeLabel(id) })), [options]);
    const defaultName = options?.defaultRuntime ? runtimeLabel(options.defaultRuntime) : "the default runtime";

    // The runtime whose models the model list shows: the one picked, or on
    // "Server default" the server's default runtime.
    const listRuntime = runtime || options?.defaultRuntime || NONE;

    const models = listRuntime && options?.models[listRuntime]
        ? options.models[listRuntime]!.map(one => ({ id: one.id, label: one.name ?? one.id, disabled: one.disabled === true }))
        : undefined;

    // A model belongs to one runtime, so picking one on "Server default"
    // saves the default runtime with it - the runtime list then shows it.
    const pickModel = (id: string) => {

        setModel(id);
        setEffort(NONE);

        if (id && !runtime && listRuntime)
            setRuntime(listRuntime);
    };

    // The effort levels of the model picked, when the list knows any.
    const efforts = listRuntime && model
        ? options?.models[listRuntime]?.find(one => one.id === model)?.efforts
        : undefined;

    // Where the work item list can start, for the connectors set up: your
    // own items first, then the whole connector.
    const pickFrom = useMemo(() => (options?.connectors ?? []).flatMap(id => id === "ado"
        ? [{ id: "ado>mine>workitems", label: "My Azure DevOps work items" }, { id: "ado", label: "All of Azure DevOps" }]
        : [{ id: "github>mine>issues", label: "My GitHub issues" }, { id: "github", label: "All of GitHub" }]), [options]);

    const [from, setFrom] = useState<string | undefined>();
    const fromRoot = from ?? pickFrom[0]?.id;

    const pickItem = async (path: string[]): Promise<string | undefined> => {

        const answer = await bridge.request<{ link?: WorkspaceLink }>(API.workspaceItem, { path });

        if (!answer.link)
            return answer.problem ?? "Could not read that item.";

        setLink(answer.link);
        setPicking(false);

        // The name follows the item while it is empty or was filled from an item.
        if (!name.trim() || autoName) {
            setName(itemName(answer.link));
            setAutoName(true);
        }

        return undefined;
    };

    const mainFolder = folders[0];
    const extras = folders.slice(1);

    // A new main folder takes the first place. If it was an extra folder,
    // it is no longer one.
    const pickMain = (folder: string) => setFolders(current => [folder, ...current.slice(1).filter(one => !samePath(one, folder))]);
    const addExtra = (folder: string) => setFolders(current => current.some(one => samePath(one, folder)) ? current : [...current, folder]);
    const removeExtra = (folder: string) => setFolders(current => [current[0]!, ...current.slice(1).filter(one => one !== folder)]);

    const save = async (): Promise<void> => {

        if (!folders[0]) {
            setProblem("Pick the main folder first.");
            return;
        }

        setSaving(true);
        setProblem(undefined);

        try {

            const answer = await bridge.request(API.saveWorkspace, {
                ...(editKey ? { key: editKey } : {}),
                name: name.trim(),
                folders,
                ...(runtime ? { runtime } : {}),
                ...(runtime && model ? { model } : {}),
                ...(runtime && model && effort && efforts?.includes(effort) ? { effort } : {}),
                ...(tempFolder ? { tempFolder: true } : {}),
                ...(link ? { link: link.path } : {})
            });

            if (answer.problem)
                setProblem(answer.problem);
            else
                onClose();

        } catch (error) {

            setProblem(`Could not reach the server: ${(error as Error).message}`);

        } finally {

            setSaving(false);
        }
    };

    return (
        <Modal show onHide={onClose} className="eesha-workspace-modal">
            <Modal.Header closeButton onClose={onClose}>
                <Modal.Title>{editing ? "Workspace" : next ? "Next work item" : "Add a workspace"}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <p className="eesha-workspace-quiet">
                    {editing
                        ? "What a new session in this workspace starts with. Sessions already in it keep what they have."
                        : next
                            ? `A new workspace on the same folders as '${next.name}', for the next work item. Its sessions are listed apart from the old ones.`
                            : "A group of folders in your session list. A new session in it starts with the choices below."}
                </p>

                <label className="eesha-workspace-field">
                    <span>Name</span>
                    <Input size="sm" aria-label="Name" placeholder="Empty: the main folder's name" value={name} onChange={event => { setName(event.target.value); setAutoName(false); }} />
                </label>

                <h3 className="eesha-ws-heading">Folders</h3>

                <div className="eesha-workspace-field eesha-workspace-field--top">
                    <span className="eesha-ws-label">Main folder</span>
                    {locked
                        // Sessions are listed under a workspace by its main folder, so it stays.
                        ? (
                            <div className="eesha-ws-folder" title="Sessions are listed under this folder, so it cannot change.">
                                <span className="eesha-ws-path">{mainFolder}</span>
                                <span className="eesha-ws-tag">SDD specs here</span>
                            </div>
                        )
                        : (
                            <div>
                                <FolderChoice recent={recent} value={mainFolder} skip={folders} label="Main folder" placeholder="Pick the main folder" onPick={pickMain} />
                                <p className="eesha-ws-hint">New sessions start here. SDD keeps the specs here.</p>
                            </div>
                        )}
                </div>

                <div className="eesha-workspace-field eesha-workspace-field--top">
                    <span className="eesha-ws-label">Extra folders</span>
                    <div>
                        {extras.length
                            ? (
                                <ul className="eesha-ws-extras">
                                    {extras.map(folder => (
                                        <li key={folder} className="eesha-ws-folder">
                                            <span className="eesha-ws-path" title={folder}>{folder}</span>
                                            <Button size="xs" fill="ghost" variant="secondary" aria-label={`Remove ${folder}`} onClick={() => removeExtra(folder)}>
                                                <UiIcon name="close" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )
                            : null}
                        <FolderChoice
                            recent={recent}
                            skip={folders}
                            label="Add an extra folder"
                            placeholder={mainFolder ? "Add an extra folder" : "Pick the main folder first"}
                            disabled={!mainFolder}
                            onPick={addExtra} />
                    </div>
                </div>

                <h3 className="eesha-ws-heading">New sessions start with</h3>

                <div className="eesha-ws-start">
                    <label>
                        <span>Runtime</span>
                        <Select
                            aria-label="Runtime"
                            size="sm"
                            sort={false}
                            hideSearch
                            disabled={!options}
                            placeholder="Loading runtimes…"
                            items={[{ id: NONE, label: `Server default (${defaultName})` }, ...runtimes]}
                            labelKey="label"
                            valueKey="id"
                            value={options ? runtime : undefined}
                            onChange={id => {
                                setRuntime(String(id));
                                setModel(NONE);
                                setEffort(NONE);
                            }} />
                    </label>

                    <label>
                        <span>Model</span>
                        {listRuntime && !models
                            // No list known for this runtime yet: the id is typed.
                            ? <Input size="sm" aria-label="Model" placeholder="Empty: the runtime's default" value={model} onChange={event => pickModel(event.target.value)} />
                            : (
                                <Select
                                    aria-label="Model"
                                    size="sm"
                                    sort={false}
                                    disabled={!listRuntime}
                                    disabledKey="disabled"
                                    items={[
                                        { id: NONE, label: listRuntime ? "Runtime's default" : "Pick a runtime first", disabled: false },
                                        ...(models ?? [])
                                    ]}
                                    labelKey="label"
                                    valueKey="id"
                                    value={model}
                                    onChange={id => pickModel(String(id))} />
                            )}
                    </label>

                    <label>
                        <span>Effort</span>
                        {/* Greyed out until the model picked lists effort levels. */}
                        <Select
                            aria-label="Effort"
                            size="sm"
                            sort={false}
                            hideSearch
                            disabled={!efforts?.length}
                            items={[{ id: NONE, label: "Model's default" }, ...(efforts ?? []).map(level => ({ id: level, label: level }))]}
                            labelKey="label"
                            valueKey="id"
                            value={efforts?.includes(effort) ? effort : NONE}
                            onChange={id => setEffort(String(id))} />
                    </label>
                </div>

                <div className="eesha-ws-temp">
                    <Checkbox
                        size="sm"
                        label="The AI may also use the system temp folder"
                        checked={tempFolder}
                        onChange={event => setTempFolder(event.target.checked)} />
                </div>

                <h3 className="eesha-ws-heading">Work item</h3>

                {link
                    ? (
                        <div className="eesha-ws-folder eesha-ws-item">
                            <span className="eesha-ws-tag">{link.kind === "workitem" ? `ADO ${link.id}` : link.id}</span>
                            <span className="eesha-ws-item-title" title={link.title}>{link.title}</span>
                            {pickFrom.length
                                ? <Button size="xs" fill="ghost" variant="secondary" aria-expanded={picking} onClick={() => setPicking(open => !open)}>{picking ? "Hide" : "Change"}</Button>
                                : null}
                            <Button size="xs" fill="ghost" variant="secondary" aria-label="Remove the work item" onClick={() => { setLink(undefined); setPicking(false); }}>
                                <UiIcon name="close" />
                            </Button>
                        </div>
                    )
                    : !options
                        ? <p className="eesha-workspace-quiet">Loading…</p>
                        : !pickFrom.length
                            ? <p className="eesha-workspace-quiet">Connect Azure DevOps or GitHub on the Connectors page to link a work item or an issue.</p>
                            : picking
                                ? null
                                : (
                                    <div>
                                        <Button size="sm" variant="secondary" fill="outline" onClick={() => setPicking(true)}>Pick a work item or issue</Button>
                                        <p className="eesha-ws-hint">Its number and title become the name when Name is empty.</p>
                                    </div>
                                )}

                {picking && fromRoot
                    ? (
                        <div className="eesha-ws-pick">
                            <div className="eesha-ws-pick-from">
                                <Select
                                    aria-label="Pick from"
                                    size="sm"
                                    sort={false}
                                    hideSearch
                                    items={pickFrom}
                                    labelKey="label"
                                    valueKey="id"
                                    value={fromRoot}
                                    onChange={id => setFrom(String(id))} />
                                <Button size="sm" variant="secondary" fill="outline" onClick={() => setPicking(false)}>Cancel</Button>
                            </div>
                            <ConnectorPick
                                key={fromRoot}
                                root={fromRoot.split(">")}
                                emptyText="Nothing here."
                                onPick={pickItem} />
                        </div>
                    )
                    : null}

                {link ? <p className="eesha-ws-hint">Sessions here tell the AI about it, and the "&gt;" list offers it first.</p> : null}

                {problem ? <p className="eesha-new-spec-problem" role="alert">{problem}</p> : null}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" fill="outline" size="sm" onClick={onClose}>Cancel</Button>
                <Button variant="primary" size="sm" disabled={saving || !mainFolder} onClick={() => void save()}>{editing && editKey ? "Save" : "Add workspace"}</Button>
            </Modal.Footer>
        </Modal>
    );
}

function samePath(left: string, right: string): boolean {

    return left.toLowerCase() === right.toLowerCase();
}

/**
 * The name a workspace gets from its item: "12345 Login fails" for a work
 * item, "#12 Crash on start" for an issue. Cut to the longest name allowed.
 */
function itemName(link: WorkspaceLink): string {

    const number = link.kind === "workitem" ? link.id : `#${link.id.split("#").pop()}`;

    return `${number} ${link.title}`.replace(/\s+/g, " ").trim().slice(0, ALIAS_LIMIT).trim();
}
