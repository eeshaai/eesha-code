import React, { useEffect, useState } from "react";

import { Button, Input, LibraryFolderPicker, Modal, Select, Textarea } from "../view/ui";
import { API, type NewSpecAsk, type NewSpecOffers } from "../server/protocol";
import { bridge } from "./bridge";
import ConnectorPick from "./ConnectorPick";
import { useFolderBrowser } from "./FolderPicker";
import type { SddPlace } from "./workspacePick";

/*
 * The New spec window. It asks first how the spec runs: with one of
 * this workspace's Eesha styles, with Kiro's own spec process, or with
 * Spec Kit's own commands.
 *
 * Kiro: a name and a description. Create makes the folder under
 * `.kiro/specs` and the spec opens with Requirements already started in
 * Kiro's Spec mode, sent the description.
 *
 * Spec Kit: a description only. Create opens a new chat with
 * `/speckit.specify` and the description in its box - you press Send.
 * Spec Kit's script names the folder and makes the branch, so it cannot
 * be done here ahead of it.
 *
 * An Eesha style asks, in one window:
 *
 *   - what kind of spec it is, listed as "[style] kind";
 *   - where it starts from: a line you type, an ADO work item, a GitHub
 *     issue, or files you already have. Not asked when `sdd.source` in
 *     settings.json settles it;
 *   - what that source needs: the line, the work item's id or link, the
 *     issue's number or link, or the files, picked in the folder browser;
 *   - the spec's name, which becomes its folder's name.
 *
 * Create writes the folder and idea.md, with no AI, and opens the
 * spec. No phase starts by itself: you press Next.
 *
 * In a workspace linked to a work item or issue, the window starts from
 * that item: the source is ADO or GitHub and the box holds its link. It
 * can still be changed. Not when `sdd.source` fixes another source.
 */

export interface NewSpecDialogProps {

    place: SddPlace;

    onClose(): void;

    /** The spec was made: its name. */
    onMade(name: string): void;

    /** The "Copy a built-in style" link: this window closes and the Copy a style window opens. */
    onCopyStyle?(): void;

    /** Spec Kit: open a new chat in `folder` with `text` waiting in its box. */
    onChat(folder: string, text: string, workspace: string): void;
}

/** The "How it runs" pick for this workspace's own Eesha styles. */
const EESHA = "eesha";

/** What the source's box asks for. */
function pointerField(source: string): { label: string; placeholder: string } {

    switch (source) {

        case "ado": return { label: "Work item", placeholder: "The work item id, or paste its link: 48213" };
        case "gh": return { label: "Issue", placeholder: "The issue number, or paste its link: 412" };
        default: return { label: "The ask", placeholder: "One line. It goes into idea.md, and you can add more there after." };
    }
}

/** Where each source's picker starts: ADO at its work items, GitHub at its repos (then a repo's issues). */
const PICK_ROOT: Record<string, string[]> = { ado: ["ado", "workitems"], gh: ["github"] };

export default function NewSpecDialog({ place, onClose, onMade, onCopyStyle, onChat }: NewSpecDialogProps) {

    const [offers, setOffers] = useState<NewSpecOffers | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    const [how, setHow] = useState(EESHA);

    const [type, setType] = useState(0);
    const [source, setSource] = useState("manual");
    const [text, setText] = useState("");
    const [files, setFiles] = useState<string[]>([]);

    // The files with the ask are picked in the folder browser, opened on the workspace's main folder.
    const fileBrowser = useFolderBrowser(place.folder ?? place.mainFolder, true);

    /** The folder the spec goes in, for the server - only when it is not the main one. */
    const inFolder = place.folder ? { folder: place.folder } : {};
    const [name, setName] = useState("");
    const [making, setMaking] = useState(false);
    const [picking, setPicking] = useState(false);
    const [pickedLine, setPickedLine] = useState<string | undefined>();

    useEffect(() => {

        let live = true;

        void bridge.request<NewSpecOffers>(API.sddOffers, { workspace: place.key, ...inFolder }).then(answer => {

            if (!live)
                return;

            if (answer.problem || !Array.isArray(answer.types))
                return setProblem(answer.problem ?? "The server sent nothing to offer.");

            setOffers(answer);

            if (answer.source)
                setSource(answer.source);

            // The workspace's own item, when the source may be its kind.
            const link = place.link;
            const linkSource = link ? (link.connector === "ado" ? "ado" : "gh") : undefined;

            if (link && linkSource && (!answer.source || answer.source === linkSource) && answer.sources.some(one => one.id === linkSource)) {

                setSource(linkSource);
                setText(link.url ?? link.id);
                setPickedLine(`This workspace's ${link.kind === "workitem" ? "work item" : "issue"}: ${link.id} ${link.title}`);
            }
        });

        return () => { live = false; };

    }, [place.key, place.link, place.folder]);

    const picked = offers?.types[type];
    const native = offers?.native?.find(one => one.id === how);
    const root = native ? native.root : picked ? offers?.roots[picked.styleId] : undefined;
    const field = pointerField(source);

    /** Kiro or Spec Kit: the description goes with their first command. */
    const createNative = async () => {

        if (!native)
            return;

        setMaking(true);
        setProblem(undefined);

        const ask: NewSpecAsk = {
            workspace: place.key,
            ...inFolder,
            styleId: native.id,
            specTypeId: "",
            source: "manual",
            name: name.trim(),
            text: text.trim()
        };

        const answer = await bridge.request<Partial<{ name: string; chat: { folder: string; workspace: string; text: string } }>>(API.sddCreate, { ...ask })
            .catch((error: Error) => ({ problem: `Could not reach the server: ${error.message}` } as { problem: string } & Partial<{ name: string; chat: undefined }>));

        setMaking(false);

        if (answer.chat)
            return onChat(answer.chat.folder, answer.chat.text, answer.chat.workspace);

        if (answer.problem || !answer.name)
            return setProblem(answer.problem ?? "The server did not make the spec.");

        onMade(answer.name);
    };

    const create = async () => {

        if (native)
            return createNative();

        if (!picked)
            return;

        setMaking(true);
        setProblem(undefined);

        const ask: NewSpecAsk = {
            workspace: place.key,
            ...inFolder,
            styleId: picked.styleId,
            specTypeId: picked.specTypeId,
            source,
            name: name.trim(),
            ...(source === "file"
                ? { files }
                : { text: text.trim() })
        };

        const answer = await bridge.request<{ name?: string }>(API.sddCreate, { ...ask })
            .catch((error: Error) => ({ problem: `Could not reach the server: ${error.message}`, name: undefined }));

        setMaking(false);

        if (answer.problem || !answer.name)
            return setProblem(answer.problem ?? "The server did not make the spec.");

        onMade(answer.name);
    };

    return (
        <Modal show onHide={onClose} className="eesha-wide-modal">
            <Modal.Header closeButton onClose={onClose}>
                <Modal.Title>New spec</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                {!offers
                    ? <p className="eesha-workspace-quiet">{problem ?? "Reading the styles…"}</p>
                    : (
                        <section className="eesha-workspace-fields eesha-new-spec" aria-label="New spec">
                            {offers.native?.length
                                ? (
                                    <label className="eesha-workspace-field">
                                        <span>How it runs</span>
                                        <Select
                                            aria-label="How it runs"
                                            size="sm"
                                            sort={false}
                                            hideSearch
                                            items={[
                                                { id: EESHA, label: "Eesha style" },
                                                ...offers.native.map(one => ({ id: one.id, label: one.problem ? `${one.label} - not set up here` : one.label }))
                                            ]}
                                            labelKey="label"
                                            valueKey="id"
                                            value={how}
                                            onChange={id => { setHow(String(id)); setProblem(undefined); }} />
                                    </label>
                                )
                                : null}

                            {native
                                ? (
                                    <>
                                        <p className="eesha-workspace-quiet">{native.detail}</p>
                                        {native.problem ? <p className="eesha-new-spec-problem">{native.problem}</p> : null}

                                        <label className="eesha-workspace-field eesha-workspace-field--top">
                                            <span>Description</span>
                                            <Textarea
                                                aria-label="Description"
                                                rows={4}
                                                placeholder="What the spec is about. Sent with the first command."
                                                value={text}
                                                onChange={event => setText(event.target.value)} />
                                        </label>

                                        {native.id === "kiro"
                                            ? (
                                                <>
                                                    <label className="eesha-workspace-field">
                                                        <span>Name</span>
                                                        <Input size="sm" aria-label="Spec name" placeholder="rate-limits" value={name} onChange={event => setName(event.target.value)} />
                                                    </label>
                                                    <p className="eesha-workspace-quiet">The spec folder's name: letters, digits, dots, dashes and underscores. Made under {root}.</p>
                                                </>
                                            )
                                            : <p className="eesha-workspace-quiet">Spec Kit makes the folder under {root} and checks out a branch of the same name.</p>}

                                        {problem ? <p className="eesha-new-spec-problem" role="alert">{problem}</p> : null}
                                    </>
                                )
                                : <>
                            <p className="eesha-workspace-quiet">
                                Writes the spec's folder and its idea.md, with no AI. Then the spec opens; press Next yourself to start its first phase.
                            </p>

                            <label className="eesha-workspace-field">
                                <span>Kind</span>
                                <Select
                                    aria-label="Kind of spec"
                                    size="sm"
                                    sort={false}
                                    hideSearch
                                    disabled={!offers.types.length}
                                    placeholder="No style offers a spec"
                                    items={offers.types.map((one, index) => ({ id: index, label: one.label }))}
                                    labelKey="label"
                                    valueKey="id"
                                    value={offers.types.length ? type : undefined}
                                    onChange={id => setType(Number(id))} />
                            </label>

                            {onCopyStyle
                                ? (
                                    <p className="eesha-workspace-quiet">
                                        Want your own phases?{" "}
                                        <a href="#" onClick={event => { event.preventDefault(); onCopyStyle(); }}>Copy a built-in style</a>
                                        {" "}and change the copy.
                                    </p>
                                )
                                : null}

                            {offers.broken.map(one => (
                                <p key={one.id} className="eesha-new-spec-problem">Style '{one.id}' in sdd.styles could not be loaded: {one.error}</p>
                            ))}

                            <label className="eesha-workspace-field">
                                <span>Starts from</span>
                                {offers.source
                                    ? <span>{offers.sources.find(one => one.id === offers.source)?.label ?? offers.source} <span className="eesha-workspace-quiet">- fixed by sdd.source in settings.json</span></span>
                                    : (
                                        <Select
                                            aria-label="Starts from"
                                            size="sm"
                                            sort={false}
                                            hideSearch
                                            items={offers.sources}
                                            labelKey="label"
                                            valueKey="id"
                                            value={source}
                                            onChange={id => { setSource(String(id)); setPicking(false); setPickedLine(undefined); }} />
                                    )}
                            </label>

                            {source === "file"
                                ? (
                                    <div className="eesha-new-spec-files">
                                        <LibraryFolderPicker
                                            files
                                            initial={files}
                                            heading="Files with the ask"
                                            emptyText="None yet - browse below and click a file, or paste its full path and press Add this file. They are copied into the spec folder."
                                            listing={fileBrowser.listing}
                                            loading={fileBrowser.loading}
                                            problem={fileBrowser.problem}
                                            onBrowse={fileBrowser.browse}
                                            onChange={setFiles} />
                                    </div>
                                )
                                : (
                                    <>
                                        <label className={"eesha-workspace-field" + (PICK_ROOT[source] ? " eesha-workspace-field--button" : "")}>
                                            <span>{field.label}</span>
                                            <Input
                                                size="sm"
                                                aria-label={field.label}
                                                placeholder={field.placeholder}
                                                value={text}
                                                onChange={event => { setText(event.target.value); setPickedLine(undefined); }} />
                                            {PICK_ROOT[source]
                                                ? (
                                                    <Button
                                                        size="sm"
                                                        variant="secondary"
                                                        fill="outline"
                                                        aria-expanded={picking}
                                                        title="Find it through the connector instead of typing its number"
                                                        onClick={() => setPicking(open => !open)}>
                                                        {picking ? "Hide" : "Pick…"}
                                                    </Button>
                                                )
                                                : null}
                                        </label>
                                        {picking && PICK_ROOT[source]
                                            ? (
                                                <ConnectorPick
                                                    key={source}
                                                    root={PICK_ROOT[source]!}
                                                    emptyText={`Nothing here. Is ${source === "ado" ? "Azure DevOps" : "GitHub"} connected? Connect it on the Connectors page, or type the ${source === "ado" ? "work item" : "issue"} above.`}
                                                    onPick={async path => {

                                                        // The picked item gives its link, which goes into the box above; idea.md records only which item it is.
                                                        const answer = await bridge.request<{ line?: string; link?: string }>(API.sddPickLink, { path });

                                                        if (!answer.line)
                                                            return answer.problem ?? "Could not read that item.";

                                                        setText(answer.link ?? path[path.length - 1]!);
                                                        setPickedLine(answer.line);
                                                        setPicking(false);

                                                        return undefined;
                                                    }} />
                                            )
                                            : null}
                                        {pickedLine ? <p className="eesha-workspace-quiet">{pickedLine}</p> : null}
                                    </>
                                )}

                            <label className="eesha-workspace-field">
                                <span>Name</span>
                                <Input size="sm" aria-label="Spec name" placeholder="mask-secrets-in-logs" value={name} onChange={event => setName(event.target.value)} />
                            </label>
                            <p className="eesha-workspace-quiet">The spec folder's name: letters, digits, dots, dashes and underscores.{root ? ` Made under ${root}.` : ""}</p>

                            {problem ? <p className="eesha-new-spec-problem" role="alert">{problem}</p> : null}
                                </>}
                        </section>
                    )}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" fill="outline" size="sm" onClick={onClose}>Cancel</Button>
                <Button variant="primary" size="sm" disabled={(native ? Boolean(native.problem) : !picked) || making} onClick={() => void create()}>
                    {making ? "Creating…" : native?.id === "speckit" ? "Open the chat" : "Create"}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
