import { describe, expect, it } from "vitest";

import { answerText, levelFor, levelFits, readAnswer } from "../../core/models/permissionCard";
import type { ChatStore } from "../chatStore";
import { isAcpRuntime, readLevel, readLevels, writeLevel } from "../permissionLevels";

/*
 * The Permissions level per provider, and the one-line
 * answers a card sends back.
 */

function store(start: Record<string, unknown> = {}): ChatStore {

    const values = new Map(Object.entries(start));

    return {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => { values.set(key, value); }
    } as ChatStore;
}

describe("permission levels", () => {

    it("the two SDK runtimes are not ACP; anything else is", () => {

        expect(isAcpRuntime("claude")).toBe(false);
        expect(isAcpRuntime("ghcp")).toBe(false);
        expect(isAcpRuntime("kiro-cli")).toBe(true);
    });

    it("starts every provider on Auto", () => {

        expect(readLevel(store(), "claude")).toBe("auto");
        expect(readLevel(store(), "kiro")).toBe("auto");
    });

    it("keeps one level per provider", async () => {

        const saved = store();

        await writeLevel(saved, "claude", "manual");
        await writeLevel(saved, "kiro", "agent");

        expect(readLevel(saved, "claude")).toBe("manual");
        expect(readLevel(saved, "kiro")).toBe("agent");
        expect(readLevel(saved, "ghcp")).toBe("auto");
    });

    it("moves a level saved for the other kind to its twin, and drops junk", () => {

        const saved = store({ "eesha.permissionLevels": { claude: "agent", kiro: "manual", ghcp: "loud" } });

        expect(readLevel(saved, "claude")).toBe("manual");
        expect(readLevel(saved, "kiro")).toBe("agent");
        expect(readLevels(saved)).toEqual({ claude: "agent", kiro: "manual" });
        expect(readLevels(store({ "eesha.permissionLevels": ["x"] }))).toEqual({});
    });

    it("an SDK runtime has no Agent's Choice and an ACP one has no Manual", () => {

        expect(levelFits("agent", false)).toBe(false);
        expect(levelFits("manual", true)).toBe(false);
        expect(levelFits("semi", true)).toBe(true);
        expect(levelFor(undefined, true)).toBe("auto");
    });
});

describe("card answers", () => {

    it("round-trips every answer through one line", () => {

        for (const answer of [
            { choice: "once" },
            { choice: "session", pattern: "npm run build *" },
            { choice: "folder", pattern: "src/**" },
            { choice: "always", pattern: "git status" },
            { choice: "deny" },
            { choice: "deny", reason: "use pnpm" },
            { choice: "addFolder", folder: "C:\\work\\other" }
        ] as const)
            expect(readAnswer(answerText(answer))).toEqual(answer);
    });

    it("reads any other words as Deny with those words as the reason", () => {

        expect(readAnswer("sure, go")).toEqual({ choice: "deny", reason: "sure, go" });
        expect(readAnswer("")).toEqual({ choice: "deny" });
        expect(readAnswer("This session: ")).toEqual({ choice: "deny", reason: "This session:" });
    });
});
