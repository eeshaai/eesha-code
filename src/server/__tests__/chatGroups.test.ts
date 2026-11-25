// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { chatsIn, deleteWhere, findChats, folded, folderKey, folderLine, groupChats, listOrder, namesOf, newestSpecChat, NO_FOLDER, specHref } from "../../web/chatGroups";
import type { ChatRow, Workspace } from "../protocol";

/*
 * The groups: one per workspace, A to Z by name, "No workspace" last,
 * newest first inside each. A session is in the workspace it recorded,
 * else in "No workspace" - whatever folders it works in. No folder groups.
 */

const NOW = new Date(2026, 10, 10, 15, 0, 0);
const HOUR = 60 * 60 * 1000;

const row = (chatId: string, folders: string[], hoursAgo = 1, workspace?: string): ChatRow =>
    ({ chatId, title: chatId, at: NOW.getTime() - hoursAgo * HOUR, folders, working: false, ...(workspace ? { workspace } : {}) });

const ids = (chats: ChatRow[]) => chats.map(chat => chat.chatId);

const API: Workspace = { name: "api", folders: ["C:\\work\\api", "C:\\work\\shared"], runtime: "claude", model: "opus" };
const BILLING: Workspace = { name: "billing", folders: ["C:\\work\\billing"] };
const ZETA: Workspace = { name: "Zeta", folders: ["C:\\work\\zeta"] };

const keyOf = (workspace: Workspace) => folderKey(workspace.folders[0]!);

describe("groupChats", () => {

    it("groups by workspace, A to Z by name, with every other session last", () => {

        const groups = groupChats([
            row("a", ["C:\\work\\zeta"], 1, keyOf(ZETA)),
            row("b", []),
            row("c", ["C:\\work\\api"], 1, keyOf(API)),
            row("loose", ["C:\\work\\web"])
        ], [ZETA, API, BILLING]);

        expect(groups.map(group => group.label)).toEqual(["api", "billing", "Zeta", NO_FOLDER]);
        expect(ids(groups[0]!.chats)).toEqual(["c"]);
        expect(groups[0]!.path).toBe("C:\\work\\api");
        expect(groups[0]!.workspace).toEqual(API);
        expect(groups[1]!.chats).toEqual([]);
        expect(groups[3]!.path).toBeUndefined();
        expect(groups[3]!.workspace).toBeUndefined();
        expect(ids(groups[3]!.chats).sort()).toEqual(["b", "loose"]);
    });

    it("puts a session that recorded no workspace in No workspace, even in a workspace's main folder", () => {

        const groups = groupChats([row("old", ["C:\\work\\api"])], [API]);

        expect(groups.map(group => [group.label, ids(group.chats)])).toEqual([["api", []], [NO_FOLDER, ["old"]]]);
    });

    it("puts a session whose workspace is gone in No workspace", () => {

        const groups = groupChats([row("orphan", ["C:\\work\\api"], 1, "c:/work/removed")], [API]);

        expect(groups.map(group => [group.label, ids(group.chats)])).toEqual([["api", []], [NO_FOLDER, ["orphan"]]]);
    });

    it("has no No workspace group when every session is in a workspace", () => {

        expect(groupChats([row("c", [], 1, keyOf(API))], [API]).map(group => group.label)).toEqual(["api"]);
    });

    it("lists a workspace's sessions newest first", () => {

        const key = keyOf(API);
        const groups = groupChats([
            row("old", [], 24 * 30, key),
            row("yesterday", [], 20, key),
            row("now", [], 1, key),
            row("earlier", [], 3, key)
        ], [API]);

        expect(ids(groups[0]!.chats)).toEqual(["now", "earlier", "yesterday", "old"]);
    });

    it("names a workspace by its own name, not by a folder alias", () => {

        const aliases = new Map([[folderKey("C:\\work\\billing"), "Old alias"]]);

        expect(groupChats([], [{ ...BILLING, name: "Billing team" }]).map(group => group.label)).toEqual(["Billing team"]);
        expect(namesOf(aliases, [{ ...BILLING, name: "Billing team" }]).get(folderKey("C:\\work\\billing"))).toBe("Billing team");
        expect(namesOf(aliases, [])).toBe(aliases);
    });
});

describe("folder aliases", () => {

    const aliases = new Map([[folderKey("C:\\work\\zeta"), "Billing"]]);

    it("shows the alias in a session's folder line", () => {

        expect(folderLine(["C:\\work\\zeta", "D:\\api"], aliases)).toBe("Billing, api");
        expect(folderLine([], aliases)).toBe(NO_FOLDER);
    });
});

describe("a workspace whose sessions are pinned or archived", () => {

    const key = keyOf(API);

    it("stays in the list, empty, and counts where its sessions went", () => {

        const groups = groupChats([
            { ...row("pinned", [], 1, key), mark: "pinned" },
            { ...row("archived", [], 2, key), mark: "archived" },
            { ...row("archived too", [], 3, key), mark: "archived" },
            { ...row("loose pinned", [], 1), mark: "pinned" }
        ], [API]);

        expect(groups.map(group => [group.label, ids(group.chats), group.pinned, group.archived])).toEqual([
            ["api", [], 1, 2],
            [NO_FOLDER, [], 1, 0]
        ]);
    });

    it("lists only its other sessions", () => {

        const [group] = groupChats([{ ...row("pinned", [], 1, key), mark: "pinned" }, row("plain", [], 2, key)], [API]);

        expect(ids(group!.chats)).toEqual(["plain"]);
        expect(group!.pinned).toBe(1);
    });
});

describe("deleting a workspace's sessions", () => {

    const key = keyOf(API);

    const chats: ChatRow[] = [
        row("today", ["D:\\api"], 1, key),
        { ...row("pinned", [], 2, key), mark: "pinned" },
        { ...row("archived", [], 30, key), mark: "archived" },
        row("same folder, no workspace", ["C:\\work\\api"], 1),
        row("loose", [], 1)
    ];

    it("takes every session of the workspace - pinned and archived ones too", () => {

        expect(ids(chatsIn(chats, key))).toEqual(["today", "pinned", "archived"]);
        expect(ids(chatsIn(chats, ""))).toEqual(["same folder, no workspace", "loose"]);
    });

    it("says where the sessions are, for the question", () => {

        expect(deleteWhere("api")).toBe("in 'api'");
    });
});

describe("the parts", () => {

    it("keeps a POSIX path's case", () => {

        expect(folderKey("/home/me/Api/")).toBe("/home/me/Api");
    });
});

describe("the list's order, for Alt+Up and Alt+Down", () => {

    it("is the pinned sessions, then each workspace's sessions newest first, with archived sessions left out", () => {

        const chats: ChatRow[] = [
            { ...row("pinned", [], 1, keyOf(ZETA)), mark: "pinned" },
            row("loose-old", [], 100),
            row("api", [], 3, keyOf(API)),
            { ...row("archived", [], 4, keyOf(API)), mark: "archived" },
            row("loose-new", [], 2)
        ];

        expect(ids(listOrder(chats, [API, ZETA]))).toEqual(["pinned", "api", "loose-new", "loose-old"]);
    });
});

/*
 * A link to a spec - on the start page, the workspace page and the panel's
 * spec rows - goes straight to its newest phase chat with the spec as a
 * tab, never through the older spec address.
 */
describe("links to a spec", () => {

    const KEY = "c:/work/api";

    const chat = (chatId: string, hoursAgo: number, phaseId: string, more: Partial<ChatRow> = {}): ChatRow =>
        ({ ...row(chatId, ["C:\\work\\api"], hoursAgo), workspace: KEY, spec: { spec: "login", phase: phaseId }, ...more });

    const chats = [
        chat("design", 2, "design"),
        chat("w0", 1, "implement@wave:0"),
        chat("req", 3, "requirements"),
        chat("other", 0.5, "design", { workspace: "c:/work/web" }),
        chat("elsewhere", 0.5, "design", { spec: { spec: "login", folder: "D:\\extra", phase: "design" } }),
        row("plain", ["C:\\work\\api"], 0.1)
    ];

    it("find the spec's newest chat in its workspace and folder - a wave chat counts", () => {

        expect(newestSpecChat(chats, KEY, "login")?.chatId).toBe("w0");
        expect(newestSpecChat(chats, KEY, "login", "d:/extra/")?.chatId).toBe("elsewhere");
        expect(newestSpecChat(chats, KEY, "billing")).toBeUndefined();
    });

    it("find a phase's newest chat, its wave chats included", () => {

        expect(newestSpecChat(chats, KEY, "login", undefined, "design")?.chatId).toBe("design");
        expect(newestSpecChat(chats, KEY, "login", undefined, "implement")?.chatId).toBe("w0");
    });

    it("go to that chat with the spec as a tab", () => {

        expect(specHref(chats, KEY, "login")).toBe("/?chat=w0&spec=login");
        expect(specHref(chats, KEY, "login", undefined, "requirements")).toBe("/?chat=req&spec=login");
    });

    it("go to the spec's newest chat for a phase with none, and to the workspace page for a spec with none", () => {

        expect(specHref(chats, KEY, "login", undefined, "tasks")).toBe("/?chat=w0&spec=login");
        expect(specHref(chats, KEY, "billing")).toBe("/workspace?workspace=c%3A%2Fwork%2Fapi&spec=billing");
    });
});

describe("the search window", () => {

    const chats: ChatRow[] = [
        { ...row("Fix login", ["C:\\work\\api"], 1), mark: "pinned" },
        row("Write docs", ["C:\\work\\web", "C:\\work\\api"], 2),
        { ...row("Old idea", [], 3), mark: "archived" },
        row("Plan", ["C:\\work\\tools"], 4)
    ];

    const found = (text: string, aliases = new Map<string, string>(), said?: Map<string, string>) =>
        ids(findChats(chats, text, aliases, said));

    it("finds nothing for empty text or only spaces", () => {

        expect(found("")).toEqual([]);
        expect(found("   \n ")).toEqual([]);
    });

    it("finds by name, any case, pinned and archived sessions too, in the order given", () => {

        expect(found("LOGIN")).toEqual(["Fix login"]);
        expect(found("i")).toEqual(["Fix login", "Write docs", "Old idea"]);
    });

    it("finds by any folder, by its own name and by its alias", () => {

        const aliases = new Map([[folderKey("C:\\work\\tools"), "Toolbox"]]);

        expect(found("api")).toEqual(["Fix login", "Write docs"]);
        expect(found("toolbox", aliases)).toEqual(["Plan"]);
        expect(found("tools", aliases)).toEqual(["Plan"]);
        expect(found("no workspace")).toEqual(["Old idea"]);
    });

    it("finds the sessions the server found by what was said in them", () => {

        expect(found("deploy", undefined, new Map([["Plan", "we deploy on Friday"]]))).toEqual(["Plan"]);
    });

    it("reads spaces and line breaks as one space", () => {

        expect(folded("  write \n  docs ")).toBe("write docs");
        expect(found("write \n docs")).toEqual(["Write docs"]);
    });
});

describe("more than one workspace on a folder", () => {

    const API = "C:\\work\\api";
    const first: Workspace = { name: "12 Login page", folders: [API], created: 1 };
    const second: Workspace = { id: "c:\\work\\api::b", name: "13 Logout", folders: [API], created: 2 };

    it("lists each workspace's sessions under it, and a session with no workspace under No workspace", () => {

        const groups = groupChats([
            row("old", [API]),
            row("first's", [API], 1, folderKey(API)),
            row("new", [API], 1, "c:\\work\\api::b")
        ], [first, second]);

        expect(groups.map(group => [group.label, ids(group.chats)])).toEqual([
            ["12 Login page", ["first's"]],
            ["13 Logout", ["new"]],
            [NO_FOLDER, ["old"]]
        ]);
    });

    it("marks an archived workspace hidden", () => {

        const chats = [row("old", [API], 2), row("new", [API], 1, "c:\\work\\api::b")];
        const groups = groupChats(chats, [first, { ...second, archived: true }]);

        expect(groups.find(group => group.key === "c:\\work\\api::b")?.hidden).toBe(true);
        expect(groups.find(group => group.key === folderKey(API))?.hidden).toBeUndefined();
    });
});
