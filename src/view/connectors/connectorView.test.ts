import { describe, expect, it } from "vitest";

import { accessGroups, accessOptions, connectorGroups, looseLines } from "./connectorView";

describe("accessGroups", () => {

    it("groups the sources by access, most first, leaves out empty levels and counts no access as off", () => {

        expect(accessGroups([
            { label: "Pull requests", access: "read" },
            { label: "Issues", access: "write" },
            { label: "Actions", access: undefined },
            { label: "Wiki", access: "off" }
        ])).toEqual([
            { access: "write", labels: ["Issues"] },
            { access: "read", labels: ["Pull requests"] },
            { access: "off", labels: ["Actions", "Wiki"] }
        ]);

        expect(accessGroups([{ label: "Issues", access: "read" }])).toEqual([{ access: "read", labels: ["Issues"] }]);
    });

    it("offers no write on a read-only source", () => {

        expect(accessOptions(true)).toEqual(["off", "read"]);
        expect(accessOptions(undefined)).toEqual(["off", "read", "write"]);
    });
});

describe("the Connect window's boxes", () => {

    const groups = [{ name: "octocat", items: ["octocat/a", "octocat/b"] }];

    it("counts the ticked items of a group, and shows a dash for some", () => {

        const [group] = connectorGroups(groups, new Set(["octocat/a"]), true, "repos");

        expect(group).toMatchObject({ checked: false, partly: true, note: "1 of 2 repos" });
        expect(group.items.map(one => one.checked)).toEqual([true, false]);
    });

    it("lets a ticked owner cover all its items, which are then off limits", () => {

        const [group] = connectorGroups(groups, new Set(["octocat"]), true, "repos");

        expect(group).toMatchObject({ checked: true, partly: false, note: "all repos, also new ones" });
        expect(group.items.every(one => one.checked && one.disabled)).toBe(true);
    });

    it("ticks an organization's box when all its projects are ticked", () => {

        const [group] = connectorGroups(groups, new Set(["octocat/a", "octocat/b"]), false, "projects");

        expect(group).toMatchObject({ checked: true, partly: false, note: "2 of 2 projects" });
    });

    it("marks the lines in no group", () => {

        expect(looseLines(["me/notes", "me/other"], new Set(["me/notes"]))).toEqual([
            { name: "me/notes", checked: true },
            { name: "me/other", checked: false }
        ]);
    });
});
