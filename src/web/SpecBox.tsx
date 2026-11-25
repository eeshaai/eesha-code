import React, { useEffect, useRef, useState } from "react";

import { API, type SpecWidgetView } from "../server/protocol";
import { Button, StatusDot } from "../view/ui";
import { bridge } from "./bridge";

/*
 * The box over a spec's document on the spec page: one line that says
 * what waits for you now, and at most two buttons.
 *
 * 1. The agent asked a question (the server's spec run says so, or the
 *    chat beside the spec waits): "Go to the question" puts the cursor
 *    in that chat, where the question is.
 * 2. The agent is working: the document updates as it writes.
 * 3. The chat's phase wrote its document: read it, add notes, then start
 *    the next phase with the button at the top of the spec. Open notes
 *    can be put in the message box.
 * 4. Every phase is done.
 *
 * The box never starts anything itself: the one main button is in the
 * spec's header. It reads its facts from the server (`API.sddWidget`)
 * and reads them again when a spec changes.
 */

/** What the spec view says that can move the box's numbers. */
const MOVES = new Set(["spec", "notes", "document", "baseline"]);

export interface SpecBoxProps {

    workspace: string;

    spec: string;

    folder?: string;

    /** The phase of the chat beside the spec - its document is the one the box speaks of. */
    phase?: string;

    /** A question waits in the chat beside the spec - asked there, so the server's spec run does not know it. */
    chatWaits?: boolean;

    /** Puts the cursor in the chat's message box. */
    onGoToChat(): void;
}

function plural(count: number, word: string): string {

    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export default function SpecBox({ workspace, spec, folder, phase, chatWaits, onGoToChat }: SpecBoxProps) {

    const [view, setView] = useState<SpecWidgetView | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    /** Asks again, a moment later: several changes in a row are one read. */
    const again = useRef<() => void>(() => undefined);

    useEffect(() => {

        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const read = () => void bridge.request<SpecWidgetView>(API.sddWidget, { workspace, spec, ...(folder ? { folder } : {}), ...(phase ? { phase } : {}) })
            .then(answer => {

                if (!live)
                    return;

                if (answer.problem || !Array.isArray(answer.phases))
                    return setProblem(answer.problem ?? "The server sent no phases.");

                setProblem(undefined);
                setView(answer);
            })
            .catch((error: Error) => { if (live) setProblem(`Could not reach the server: ${error.message}`); });

        again.current = () => {

            clearTimeout(timer);
            timer = setTimeout(read, 300);
        };

        read();

        const off = bridge.onPage(message => {

            if (message.type === "eesha.specsChanged" || message.type === "eesha.hello")
                return again.current();

            // The spec view saved notes, or its document moved.
            if (message.type === "eesha.sdd" && message.workspace === workspace && message.spec === spec && (message.folder ?? "") === (folder ?? "")) {

                const said = message.message as { type?: unknown } | null;

                if (typeof said?.type === "string" && MOVES.has(said.type))
                    again.current();
            }
        });

        return () => { live = false; clearTimeout(timer); off(); };

    }, [workspace, spec, folder, phase]);

    if (problem)
        return <div className="eesha-spec-box eesha-spec-box--quiet">{problem}</div>;

    if (!view)
        return null;

    const next = view.next;
    const doc = view.doc;

    if (view.waiting || chatWaits)
        return (
            <div className="eesha-spec-box eesha-spec-box--waiting" role="status">
                <StatusDot tone="waiting" label="waiting for you" />
                <span className="eesha-spec-box__text">The agent asked a question and waits for your answer in the chat.</span>
                <Button type="button" size="sm" variant="primary" onClick={onGoToChat}>Go to the question</Button>
            </div>
        );

    if (view.working)
        return (
            <div className="eesha-spec-box eesha-spec-box--working" role="status">
                <StatusDot tone="working" label="working" />
                <span className="eesha-spec-box__text">The agent is working on this spec. The document updates as it writes.</span>
            </div>
        );

    const nextText = !next
        ? "Every phase is done."
        : next.blocked
            ? `${next.label} cannot start yet: ${next.blocked}`
            : next.plan
                ? `Next: ${next.label}. It runs from the plan, wave by wave - start it with the button at the top.`
                : `When it reads right, start ${next.label} with the button at the top.`;

    const docText = doc
        ? [
            `${doc.file} is written.`,
            ...(doc.changed ? [`The last turn changed ${plural(doc.changed, "block")}.`] : []),
            ...(doc.notes ? [`${plural(doc.notes, "open note")}.`] : [])
        ].join(" ")
        : "";

    return (
        <div className={`eesha-spec-box${next ? "" : " eesha-spec-box--done"}`} role="status">
            <span className="eesha-spec-box__text">{[docText, nextText].filter(Boolean).join(" ")}</span>
            {doc?.notesText
                ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        fill="outline"
                        title="Put the open notes in the chat's message box, to send to the agent"
                        onClick={() => { bridge.toView({ type: "addText", text: doc.notesText! }); onGoToChat(); }}>
                        Notes to the chat
                    </Button>
                )
                : null}
        </div>
    );
}
