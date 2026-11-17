// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it, vi } from "vitest";

/*
 * The SDD editor's page state lives through a reload (web/sddLine.ts):
 * it is kept in the tab's session storage under the workspace and spec
 * of the spec tab in front. The editor keeps its compose boxes' unsent
 * text there, so a reload - the one a returning event stream makes too -
 * does not throw typing away.
 */

const SPEC = { workspace: "c:\\work\\repo", spec: "orders" };

const KEY = `eesha.sdd.state:${JSON.stringify(["c:\\work\\repo", "orders"])}`;

// A bare page with session storage, as the last page load left it: run before the imports below.
const page = vi.hoisted(() => {

    const values = new Map<string, string>([
        [`eesha.sdd.state:${JSON.stringify(["c:\\work\\repo", "orders"])}`, JSON.stringify({ composeDrafts: { design: "half a sentence" } })]
    ]);

    Object.assign(globalThis, {
        window: new EventTarget(),
        location: { pathname: "/", search: "?chat=c1&spec=orders", hash: "" },
        sessionStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); }
        }
    });

    return { values };
});

import { sddLine, specLine, stateKey } from "../../web/sddLine";

describe("the SDD editor's page state", () => {

    it("comes back after a reload, from this tab's storage under the workspace and spec", () => {

        specLine.show(SPEC);

        expect(sddLine.getState()).toEqual({ composeDrafts: { design: "half a sentence" } });
    });

    it("is kept there when the editor changes it", () => {

        specLine.show(SPEC);
        sddLine.setState({ composeDrafts: { design: "a whole sentence." } });

        expect(JSON.parse(page.values.get(KEY)!)).toEqual({ composeDrafts: { design: "a whole sentence." } });
        expect(sddLine.getState()).toEqual({ composeDrafts: { design: "a whole sentence." } });
    });

    it("is kept apart for each spec tab, and a spec in another folder has its own", () => {

        expect(stateKey(SPEC)).toBe(KEY);
        expect(stateKey({ ...SPEC, folder: "c:\\work\\repo\\docs" })).toBe(`eesha.sdd.state:${JSON.stringify(["c:\\work\\repo", "orders", "c:\\work\\repo\\docs"])}`);

        specLine.show({ workspace: SPEC.workspace, spec: "billing" });

        expect(sddLine.getState()).toBeUndefined();

        specLine.show(SPEC);

        expect(sddLine.getState()).toEqual({ composeDrafts: { design: "a whole sentence." } });
    });

    it("is not kept while no spec tab is in front", () => {

        specLine.show(undefined);
        sddLine.setState({ composeDrafts: { design: "lost" } });

        expect(sddLine.getState()).toBeUndefined();
        expect([...page.values.keys()]).toEqual([KEY]);
    });
});
