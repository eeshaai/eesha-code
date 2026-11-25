// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What the SDD editor sends and the server never gets is said on the
 * page, and a typed message is told `unsent`, so its text goes back into
 * the compose box (web/sddLine.ts). `unsent` goes on the spec view's own
 * line, not as a window message: the chat beside the spec listens there.
 */

// A bare page for the page code to load in: run before the imports below.
vi.hoisted(() => {

    Object.assign(globalThis, { window: new EventTarget(), location: { pathname: "/", search: "", hash: "" } });
});

import { onSddMessage } from "../../sdd/view/host";
import { bridge } from "../../web/bridge";
import { notSent } from "../../web/sddLine";

let notes: string[];
let toEditor: unknown[];
let stop: (() => void)[];

beforeEach(() => {

    notes = [];
    toEditor = [];

    stop = [
        bridge.onPage(message => { if (message.type === "eesha.note") notes.push(message.text); }),
        onSddMessage(event => toEditor.push(event.data))
    ];
});

afterEach(() => stop.forEach(one => one()));

describe("a message the server never got", () => {

    it("says so on the page, and hands a typed message back to its compose box", () => {

        notSent({ type: "sendMessage", stageId: "design", text: "hello" }, "Could not reach the server: offline");

        expect(notes).toEqual(["Not sent - Could not reach the server: offline"]);
        expect(toEditor).toEqual([{ type: "unsent", stageId: "design" }]);
    });

    it("only says so for anything else", () => {

        notSent({ type: "run", stageId: "design" }, "This tab shows no spec - reload the page.");

        expect(notes).toEqual(["Not sent - This tab shows no spec - reload the page."]);
        expect(toEditor).toEqual([]);
    });
});
