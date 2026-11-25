import React, { useEffect, useState } from "react";

import ChatPane from "../view/chat/ChatPane";
import { PopoverDefaults } from "../view/ui";
import { bridge } from "./bridge";
import { applyFontSize, applyTheme } from "./theme";

/*
 * One variant's chat with nothing around it - what an evaluation's page
 * shows in each column's frame (see EvalPage.tsx). The address is
 * `/?chat=<id>&column=1`.
 *
 * It is the same chat pane a session's page shows, on its own line to
 * the server, so the thread, the tool rows and the message box are the
 * ones every session has. What a session's page has around the chat is
 * left out: no header, no session list, no side panels, no editor. So a
 * file link or a diff clicked in the thread opens nothing here.
 */

/**
 * What the column's message box says. A variant gets one message, sent
 * with Send to all at the top: the common message, and under it what
 * was saved here. Its runtime and model are picked here too.
 */
const VARIANT_BOX = {
    placeholder: "This variant's own text, added under the common message - Enter saves it. Send to all at the top sends.",
    locked: "This variant got its one message."
};

/** How long a notice from the server stays on the column. */
const NOTE_MS = 8000;

export default function EvalColumn(): React.JSX.Element {

    /** Why the chat cannot be shown: the session is not there, or another frame took it. */
    const [gone, setGone] = useState<string | undefined>();

    const [note, setNote] = useState<string | undefined>();

    useEffect(() => {

        let timer: ReturnType<typeof setTimeout> | undefined;

        const off = bridge.onPage(message => {

            switch (message.type) {

                case "eesha.hello":

                    applyTheme(message.theme);
                    applyFontSize(message.fontSize);

                    return;

                case "eesha.theme":
                    return applyTheme(message.theme);

                case "eesha.fontSize":
                    return applyFontSize(message.fontSize);

                case "eesha.unknownChat":
                    return setGone("This variant's session is not here. The Evaluator may be turned off, or the evaluation was removed.");

                case "eesha.moved":
                    return setGone("This variant is shown in another browser tab now. Reload this page to show it here.");

                case "eesha.note":

                    setNote(message.text);

                    clearTimeout(timer);
                    timer = setTimeout(() => setNote(undefined), NOTE_MS);

                    return;
            }
        });

        bridge.connect();

        return () => { off(); clearTimeout(timer); };

    }, []);

    if (gone)
        return <div className="evals-column"><p className="evals-column__gone">{gone}</p></div>;

    return (
        <div className="evals-column">
            {note ? <div className="evals-column__note" role="status">{note}</div> : null}
            <PopoverDefaults compactBelow={false}>
                <ChatPane emptyText="Nothing sent yet." side={{}} variantBox={VARIANT_BOX} />
            </PopoverDefaults>
        </div>
    );
}
