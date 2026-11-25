import { describe, expect, it } from "vitest";

import { chatPick, defaultRuntimeOf, newChatId, startRuntime } from "../chatRules";

describe("chatPick", () => {

    it("starts a chat with no pick on the first runtime ai.providers lists", () => {

        expect(chatPick(undefined, ["kiro", "ghcp"])).toEqual({ provider: "kiro" });
    });

    it("keeps the chat's own pick while the org still lists it", () => {

        const own = { provider: "ghcp", model: "gpt-5" };

        expect(chatPick(own, ["kiro", "ghcp"])).toBe(own);
    });

    it("drops a pick of a runtime taken off the list, back to the first one", () => {

        expect(chatPick({ provider: "claude" }, ["kiro", "ghcp"])).toEqual({ provider: "kiro" });
    });

    it("leaves it to the settings when ai.providers lists nothing", () => {

        expect(chatPick(undefined, undefined)).toBeUndefined();
        expect(chatPick(undefined, [])).toBeUndefined();
    });

    it("keeps any pick when there is no list to hold it to", () => {

        expect(chatPick({ provider: "claude" }, undefined)).toEqual({ provider: "claude" });
    });

    it("starts a chat with no pick on the start runtime it is given", () => {

        expect(chatPick(undefined, ["kiro", "ghcp"], "ghcp")).toEqual({ provider: "ghcp" });
        expect(chatPick(undefined, undefined, "claude")).toEqual({ provider: "claude" });
        expect(chatPick({ provider: "claude" }, ["kiro", "ghcp"], "ghcp")).toEqual({ provider: "ghcp" });
    });
});

describe("startRuntime", () => {

    it("is the default runtime when it is on offer, else the first one on offer", () => {

        expect(startRuntime(["kiro", "ghcp"], "ghcp")).toBe("ghcp");
        expect(startRuntime(["kiro", "ghcp"], "claude")).toBe("kiro");
        expect(startRuntime(["kiro", "ghcp"], undefined)).toBe("kiro");
    });

    it("is nothing when nothing is on offer - the settings decide", () => {

        expect(startRuntime(undefined, "ghcp")).toBeUndefined();
        expect(startRuntime([], "ghcp")).toBeUndefined();
    });
});

describe("defaultRuntimeOf", () => {

    const settings = (defaults: Record<string, Record<string, unknown>>) => ({ ai: { defaults } }) as never;

    it("reads ai.\"ai@1\".provider", () => {

        expect(defaultRuntimeOf(settings({ "ai@1": { provider: " claude " } }))).toBe("claude");
        expect(defaultRuntimeOf(settings({ "ai@1": { model: "auto" } }))).toBeUndefined();
        expect(defaultRuntimeOf(settings({}))).toBeUndefined();
    });
});

describe("newChatId", () => {

    it("starts with the local time and ends with six random characters", () => {

        const id = newChatId(new Date(2026, 8, 28, 9, 5, 7).getTime(), () => 0);

        expect(id).toBe("2026-09-28T09-05-07-000000");
    });
});
