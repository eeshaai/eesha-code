// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import type { SpecSessionView, SpecTreeRow } from "../protocol";
import { kindLabel, phaseSessions, specGroups } from "../../web/specTree";

/*
 * What the Spec explorer draws: a folder's specs grouped by kind, and a
 * phase's sessions.
 */

const row = (name: string, root: string, native?: SpecTreeRow["native"]): SpecTreeRow => ({
    name, root, working: false, waiting: false, phases: [], ...(native ? { native } : {})
});

describe("the Spec explorer's groups", () => {

    it("puts Eesha specs first, then Kiro, then Spec Kit, each under the folder they are kept in", () => {

        const groups = specGroups({
            specs: [
                row("001-refund", "specs", "speckit"),
                row("rate-limits", ".kiro/specs", "kiro"),
                row("login", ".eesha/specs"),
                row("audit", ".eesha/specs"),
                row("old", "docs/specs")
            ]
        });

        expect(groups.map(group => [group.label, group.root, group.specs.map(one => one.name)])).toEqual([
            ["Eesha", ".eesha/specs", ["login", "audit"]],
            ["Eesha", "docs/specs", ["old"]],
            ["Kiro", ".kiro/specs", ["rate-limits"]],
            ["Spec Kit", "specs", ["001-refund"]]
        ]);
    });

    it("has no group for a kind with no specs", () => {

        expect(specGroups({ specs: [] })).toEqual([]);
        expect(kindLabel(undefined)).toBe("Eesha");
    });
});

describe("a phase's sessions", () => {

    const session = (ownerId: string, iteration: number, at: number): SpecSessionView => ({ ownerId, iteration, current: false, at });

    it("lists the phase's own sessions newest first, and the implementation chats under Implementation", () => {

        const all = [
            session("design", 1, 10),
            session("requirements", 1, 5),
            session("design", 2, 20),
            session("implement@wave:1", 1, 30),
            session("implement@wave:2", 1, 40)
        ];

        expect(phaseSessions(all, "design").map(one => one.iteration)).toEqual([2, 1]);
        expect(phaseSessions(all, "implement").map(one => one.ownerId)).toEqual(["implement@wave:2", "implement@wave:1"]);
        expect(phaseSessions(all, "tasks")).toEqual([]);
    });
});
