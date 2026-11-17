// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import type { ChatRow } from "../protocol";
import { namesOf } from "../../web/chatGroups";
import { chatFolder, defaultsText, lastChat, lastFolder, recentList, startFolders, stateWord, waitingChats } from "../../web/startView";

const chat = (chatId: string, at: number, more: Partial<ChatRow> = {}): ChatRow => ({ chatId, title: chatId, at, folders: [], working: false, ...more });

describe("start page", () => {

    it("lists the waiting sessions newest first", () => {

        const chats = [chat("a", 1, { waiting: "Run it?" }), chat("b", 3), chat("c", 2, { waiting: "Delete?" })];

        expect(waitingChats(chats).map(one => one.chatId)).toEqual(["c", "a"]);
    });

    it("shows the newest sessions, leaves out archived ones, keeps pinned ones", () => {

        const chats = [chat("a", 1), chat("b", 4, { mark: "archived" }), chat("c", 3, { mark: "pinned" }), chat("d", 2)];

        expect(recentList(chats).map(one => one.chatId)).toEqual(["c", "d", "a"]);
        expect(recentList(chats, 1).map(one => one.chatId)).toEqual(["c"]);
        expect(lastChat(chats)?.chatId).toBe("c");
        expect(lastChat([])).toBeUndefined();
    });

    it("leaves the phase chats nobody typed in out of the recent sessions", () => {

        const chats = [chat("wave", 3, { spec: { spec: "login", phase: "implement@wave:1" } }), chat("design", 2, { spec: { spec: "login", phase: "design" }, typed: true }), chat("a", 1)];

        expect(recentList(chats).map(one => one.chatId)).toEqual(["design", "a"]);
        expect(lastChat(chats)?.chatId).toBe("design");
    });

    it("finds the last folder used", () => {

        const chats = [chat("a", 1, { folders: ["D:\\old"] }), chat("b", 5), chat("c", 3, { folders: ["D:\\api", "D:\\web"] })];

        expect(lastFolder(chats)).toBe("D:\\api");
        expect(lastFolder([chat("x", 1)])).toBeUndefined();
    });

    it("names a session's folder by its alias, its name, or No folder", () => {

        const aliases = new Map([["d:\\api", "Backend"]]);

        expect(chatFolder(chat("a", 1, { folders: ["D:\\api"] }), aliases)).toBe("Backend");
        expect(chatFolder(chat("a", 1, { folders: ["C:\\work\\web"] }), aliases)).toBe("web");
        expect(chatFolder(chat("a", 1))).toBe("No workspace");
    });

    it("says waiting before working", () => {

        expect(stateWord({ working: true, waiting: "?" })).toBe("waiting");
        expect(stateWord({ working: true })).toBe("working");
        expect(stateWord({ working: false })).toBeUndefined();
    });

    it("lists folders with sessions and folders added by hand, with counts", () => {

        const chats = [
            chat("a", 1, { folders: ["D:\\api"] }),
            chat("b", 2, { folders: ["D:\\api"], mark: "archived" }),
            chat("c", 3)
        ];

        const folders = startFolders(chats, new Map(), [{ name: "web", folders: ["D:\\web"] }]);

        expect(folders.map(one => [one.label, one.count])).toEqual([["api", 2], ["web", 0]]);
    });

    it("shows a workspace's runtime and model only when it has them", () => {

        const saved = [{ name: "api", folders: ["D:\\api"], runtime: "Claude", model: "Sonnet 5.5" }, { name: "web", folders: ["D:\\web"] }];

        expect(defaultsText("d:/api", saved)).toBe("Claude · Sonnet 5.5");
        expect(defaultsText("D:\\web", saved)).toBeUndefined();
        expect(defaultsText(undefined, saved)).toBeUndefined();
    });
});

describe("a folder with more than one workspace", () => {

    it("lists the folder once by its newest workspace, counts all their sessions, and leaves archived ones out", () => {

        const api = "D:\\api";
        const chats = [chat("a", 1, { folders: [api] }), chat("b", 2, { folders: [api], workspace: "d:\\api::b" })];
        const first = { name: "12 Login page", folders: [api], created: 1 };
        const second = { id: "d:\\api::b", name: "13 Logout", folders: [api], created: 2 };

        expect(startFolders(chats, namesOf(new Map(), [first, second]), [first, second])).toEqual([{ path: api, label: "13 Logout", count: 2 }]);
        expect(startFolders(chats, namesOf(new Map(), [first, second]), [first, { ...second, archived: true as const }])).toEqual([{ path: api, label: "12 Login page", count: 1 }]);
        expect(defaultsText(api, [{ ...first, runtime: "claude" }, { ...second, runtime: "kiro" }])).toBe("kiro");
    });
});
