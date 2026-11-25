import "./homeGuard";

import { describe, expect, it } from "vitest";

import { type ChatRow, folderKey, type SpecTreeRow } from "../protocol";
import { chatsHere, lastSpecChat, recentSpecFacts, runtimeText, startSpecFacts, workspaceChats } from "../../web/workspaceView";

/*
 * What a workspace's own page picks to show: its sessions, its recent
 * specs, and the words of its heading (web/workspaceView.ts).
 */

/** The key of the main folder `D:\app`, as the server writes it. */
const HOME = folderKey("D:\\app");

const chat = (chatId: string, at: number, more: Partial<ChatRow> = {}): ChatRow => ({
    chatId,
    title: `Session ${chatId}`,
    at,
    folders: ["D:\\app"],
    working: false,
    ...more
} as ChatRow);

const spec = (name: string, modified: number | undefined, more: Partial<SpecTreeRow> = {}): SpecTreeRow => ({
    name,
    style: "custom",
    phase: "design",
    done: 1,
    total: 4,
    working: false,
    waiting: false,
    ...(modified !== undefined ? { modified } : {}),
    root: ".eesha/specs",
    phases: [],
    ...more
});

describe("the workspace page's sessions", () => {

    it("takes only the sessions that recorded this workspace - not the ones that only sit in its main folder", () => {

        const chats = [
            chat("a", 1, { workspace: "ws-2" }),
            chat("b", 2, { workspace: HOME }),
            chat("loose", 3)
        ];

        expect(chatsHere(chats, "ws-2").map(one => one.chatId)).toEqual(["a"]);
        expect(chatsHere(chats, HOME).map(one => one.chatId)).toEqual(["b"]);
    });

    it("lists the waiting ones, the newest not archived, and the one Resume opens", () => {

        const chats = [
            chat("old", 1, { workspace: HOME }),
            chat("asks", 2, { workspace: HOME, waiting: "Run it?" }),
            chat("gone", 5, { workspace: HOME, mark: "archived" }),
            chat("new", 4, { workspace: HOME }),
            chat("elsewhere", 9)
        ];

        const here = workspaceChats(chats, HOME);

        expect(here.waiting.map(one => one.chatId)).toEqual(["asks"]);
        expect(here.recent.map(one => one.chatId)).toEqual(["new", "asks", "old"]);
        expect(here.last?.chatId).toBe("new");
    });

    it("has no Resume with no session", () => {

        expect(workspaceChats([], HOME)).toEqual({ waiting: [], recent: [] });
    });
});

describe("what a spec's row says", () => {

    it("says where a spec is at", () => {

        expect(recentSpecFacts(spec("a", 1))).toBe("design · 1/4");
        expect(recentSpecFacts(spec("a", 1, { phase: "done", total: undefined, done: undefined }))).toBe("done");
        expect(recentSpecFacts(spec("a", 1, { style: undefined }))).toBe("no style could place it");
    });

    it("names the workspace that made a spec first on the start page, and leaves out a workspace that is gone", () => {

        const workspaces = [{ name: "Billing", folders: ["D:\\app"] }, { id: "12", name: "12 Login", folders: ["D:\\app"] }];
        const row = { name: "login", style: "custom", phase: "design", done: 1, total: 4, working: false, waiting: false };

        expect(startSpecFacts({ ...row, workspace: "12" }, workspaces)).toBe("12 Login · design · 1/4");
        expect(startSpecFacts({ ...row, workspace: HOME }, workspaces)).toBe("Billing · design · 1/4");
        expect(startSpecFacts({ ...row, workspace: "gone" }, workspaces)).toBe("design · 1/4");
    });
});

describe("the workspace page's box", () => {

    it("says the runtime and model, or nothing for the server's default", () => {

        expect(runtimeText({ runtime: "copilot", model: "sonnet" })).toBe("copilot · sonnet");
        expect(runtimeText({ runtime: "copilot" })).toBe("copilot");
        expect(runtimeText({})).toBeUndefined();
    });
});

describe("Resume beside a spec", () => {

    const phase = (chatId: string, at: number, name: string, phaseId = "design") =>
        chat(chatId, at, { workspace: "ws", spec: { spec: name, phase: phaseId } } as Partial<ChatRow>);

    it("goes to the newest session on the spec: a phase chat or a normal chat tied to it", () => {

        const chats = [
            phase("req", 1, "login", "requirements"),
            phase("des", 3, "login"),
            phase("other", 9, "billing"),
            chat("tied", 5, { workspace: "ws" }),
            chat("plain", 8, { workspace: "ws" })
        ];

        const tied = (to: string | undefined) => (chatId: string) => chatId === "tied" && to ? { spec: to } : undefined;

        expect(lastSpecChat(chats, "ws", { spec: "login" }, tied("login"))?.chatId).toBe("tied");
        expect(lastSpecChat(chats, "ws", { spec: "login" }, tied(undefined))?.chatId).toBe("des");
        expect(lastSpecChat(chats, "ws", { spec: "login" }, tied("billing"))?.chatId).toBe("des");
    });

    it("finds nothing for a spec no session worked on, and keeps a spec in another folder apart", () => {

        const chats = [phase("des", 3, "login"), chat("tied", 5, { workspace: "ws" })];

        expect(lastSpecChat(chats, "ws", { spec: "fresh" }, () => undefined)).toBeUndefined();
        expect(lastSpecChat(chats, "ws", { spec: "login", folder: "D:\\lib" }, () => ({ spec: "login" }))).toBeUndefined();
    });
});
