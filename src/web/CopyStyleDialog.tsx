import React, { useEffect, useState } from "react";

import { Button, Input, Modal, Select } from "../view/ui";
import { API, type CopyStyleAsk, type CopyStyleOffers, type CopyStylePlace } from "../server/protocol";
import { bridge } from "./bridge";
import type { SddPlace } from "./workspacePick";

/*
 * The Copy a style window: you pick the built-in style, where the copy
 * goes, and its name, and see the files it takes. The copy is a new
 * style of its own; the built-in is left as it is.
 *
 * The workspace is offered first: the copy then sits beside the specs,
 * goes into git, and the team gets it. The name box sets the copy's
 * folder name and its `id:`.
 */

export interface CopyStyleDialogProps {

    place: SddPlace;

    onClose(): void;
}

export default function CopyStyleDialog({ place, onClose }: CopyStyleDialogProps) {

    const [offers, setOffers] = useState<CopyStyleOffers | undefined>();
    const [problem, setProblem] = useState<string | undefined>();
    const [done, setDone] = useState<string | undefined>();

    const [styleId, setStyleId] = useState<string | undefined>();
    const [where, setWhere] = useState<CopyStylePlace>("workspace");
    const [name, setName] = useState("");
    const [copying, setCopying] = useState(false);

    useEffect(() => {

        let live = true;

        void bridge.request<CopyStyleOffers>(API.sddCopyOffers, { workspace: place.key }).then(answer => {

            if (!live)
                return;

            if (answer.problem || !Array.isArray(answer.styles))
                return setProblem(answer.problem ?? "The server sent nothing to offer.");

            setOffers(answer);

            const first = answer.styles[0];

            if (first) {

                setStyleId(first.id);
                setName(first.suggested);
            }
        });

        return () => { live = false; };

    }, [place.key]);

    const style = offers?.styles.find(one => one.id === styleId);
    const target = offers?.places.find(one => one.id === where);

    const copy = async () => {

        if (!style)
            return;

        setCopying(true);
        setProblem(undefined);

        const ask: CopyStyleAsk = { workspace: place.key, styleId: style.id, place: where, name: name.trim() };

        const answer = await bridge.request<{ text?: string }>(API.sddCopyStyle, { ...ask })
            .catch((error: Error) => ({ problem: `Could not reach the server: ${error.message}`, text: undefined }));

        setCopying(false);

        if (answer.problem || !answer.text)
            return setProblem(answer.problem ?? "The server did not copy the style.");

        setDone(answer.text);
    };

    return (
        <Modal show onHide={onClose} className="eesha-wide-modal">
            <Modal.Header closeButton onClose={onClose}>
                <Modal.Title>Copy a style</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                {done
                    ? <p role="status">{done}</p>
                    : !offers
                        ? <p className="eesha-workspace-quiet">{problem ?? "Reading the styles…"}</p>
                        : (
                            <section className="eesha-workspace-fields eesha-new-spec" aria-label="Copy a style">
                                <p className="eesha-workspace-quiet">
                                    Copies every file of a built-in style as a new style you can change. The built-in stays as it is.
                                </p>

                                <label className="eesha-workspace-field">
                                    <span>Style</span>
                                    <Select
                                        aria-label="Built-in style"
                                        size="sm"
                                        sort={false}
                                        hideSearch
                                        disabled={!offers.styles.length}
                                        placeholder="No built-in styles"
                                        items={offers.styles.map(one => ({ id: one.id, label: one.id }))}
                                        labelKey="label"
                                        valueKey="id"
                                        value={styleId}
                                        onChange={id => {

                                            const next = offers.styles.find(one => one.id === String(id));

                                            setStyleId(next?.id);

                                            // The name follows the style until it is typed over.
                                            if (next && (!name.trim() || offers.styles.some(one => one.suggested === name.trim())))
                                                setName(next.suggested);
                                        }} />
                                </label>

                                <label className="eesha-workspace-field">
                                    <span>Put it in</span>
                                    <Select
                                        aria-label="Where the copy goes"
                                        size="sm"
                                        sort={false}
                                        hideSearch
                                        items={offers.places.map(one => ({ id: one.id, label: one.label }))}
                                        labelKey="label"
                                        valueKey="id"
                                        value={where}
                                        onChange={id => setWhere(id === "profile" ? "profile" : "workspace")} />
                                </label>
                                {target ? <p className="eesha-workspace-quiet">{target.detail} {target.folder}</p> : null}

                                <label className="eesha-workspace-field">
                                    <span>Name</span>
                                    <Input size="sm" aria-label="New style name" placeholder="team-flow" value={name} onChange={event => setName(event.target.value)} />
                                </label>
                                <p className="eesha-workspace-quiet">The new style's folder and its id: letters, digits, dots, dashes and underscores.</p>

                                {style ? (
                                    <details className="eesha-copy-style-files">
                                        <summary>{style.files.length} file{style.files.length === 1 ? "" : "s"} copied</summary>
                                        <ul>{style.files.map(file => <li key={file}>{file}</li>)}</ul>
                                    </details>
                                ) : null}

                                {problem ? <p className="eesha-new-spec-problem" role="alert">{problem}</p> : null}
                            </section>
                        )}
            </Modal.Body>
            <Modal.Footer>
                {done
                    ? <Button variant="primary" size="sm" onClick={onClose}>Close</Button>
                    : (
                        <>
                            <Button variant="secondary" fill="outline" size="sm" onClick={onClose}>Cancel</Button>
                            <Button variant="primary" size="sm" disabled={!style || !name.trim() || copying} onClick={() => void copy()}>{copying ? "Copying…" : "Copy"}</Button>
                        </>
                    )}
            </Modal.Footer>
        </Modal>
    );
}
