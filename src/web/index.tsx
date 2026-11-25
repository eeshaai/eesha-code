// First, before anything that reaches the chat view: the chat view calls
// `serverApi()` the moment its code loads, and this defines it.
import { bridge } from "./bridge";

import React, { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import "../view/theme.scss";
import "./page.scss";
import "./frame.scss";

import App from "./App";
import EvalColumn from "./EvalColumn";
import EvalPage from "./EvalPage";
import { chatInAddress, columnInAddress, evalInAddress, followHistory, followLinks, onPageMove } from "./pageRoute";
import { specLine } from "./sddLine";
import { dropUnfilledFontSize } from "./theme";

dropUnfilledFontSize();

// The Evaluator has its own two pages, apart from the session page: one
// evaluation (or the list of them), and one variant's chat in a column's
// frame. Every other address is the session page.
const evaluation = evalInAddress();

/**
 * The session page. A move to another session, a workspace page or the
 * start page has no page load: the page is drawn afresh for the new
 * address - every part of it starts again, as after a reload - and the
 * server gets a new stream for it (bridge.ts `show`).
 *
 * In this order: the old page goes first, so nothing it sends while it
 * goes reaches the new chat; then the line to the server starts over;
 * then the new page is drawn. After the move's own work is done, so a
 * move asked while the page draws (a page that sends you on) waits for it.
 */
function Pages(): React.JSX.Element {

    const [drawn, setDrawn] = useState<number | undefined>(0);

    useEffect(() => {

        let count = 0;

        const offMove = onPageMove(() => queueMicrotask(() => {

            flushSync(() => setDrawn(undefined));

            bridge.show(chatInAddress());
            specLine.restart();
            scrollTo(0, 0);

            setDrawn(++count);
        }));

        const offHistory = followHistory();
        const offLinks = followLinks();

        return () => {

            offMove();
            offHistory();
            offLinks();
        };
    }, []);

    return drawn === undefined ? <></> : <App key={drawn} />;
}

const page = columnInAddress()
    ? <EvalColumn />
    : evaluation
        ? <EvalPage name={evaluation.name} />
        : <Pages />;

createRoot(document.getElementById("root")!).render(page);
