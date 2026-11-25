import { describe, expect, it } from "vitest";

import { createBranchName, filterBranches } from "./branchFilter";

const branches = [
    { name: "main", remote: false },
    { name: "Feature/Login", remote: false },
    { name: "origin/main", remote: true }
];

describe("filterBranches", () => {

    it("keeps the branches with the typed text in their name, ignoring capitals, and all of them for no text", () => {

        expect(filterBranches(branches, "feat").map(one => one.name)).toEqual(["Feature/Login"]);
        expect(filterBranches(branches, "  MAIN ").map(one => one.name)).toEqual(["main", "origin/main"]);
        expect(filterBranches(branches, "   ")).toHaveLength(3);
    });
});

describe("createBranchName", () => {

    it("offers the typed name only when new branches are allowed and no local branch has it", () => {

        expect(createBranchName(branches, " new-one ", true)).toBe("new-one");
        expect(createBranchName(branches, "new-one", false)).toBeUndefined();
        expect(createBranchName(branches, "", true)).toBeUndefined();
        expect(createBranchName(branches, "main", true)).toBeUndefined();
        expect(createBranchName(branches, "origin/main", true)).toBe("origin/main");
    });
});
