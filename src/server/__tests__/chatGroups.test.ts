// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { chatsIn, deleteWhere, emptyFolderText, findChats, folded, folderKey, folderLine, foldSpecs, foldWaves, groupChats, listOrder, namesOf, newestSpecChat, NO_FOLDER, NOTHING_COLLAPSED, phaseTitle, placeOf, recentChats, reveal, specHref, startCollapsed, toggleFolder } from "../../web/chatGroups";
import type { ChatRow, Workspace } from "../protocol";

/*
 * The session list's groups: one per first folder, A to Z, "No folder"
 * last, newest first inside each - no day headings - and the folders
 * added by hand, with or without sessions.
 */

const NOW = new Date(2026, 10, 10, 15, 0, 0);
const HOUR = 60 * 60 * 1000;

const row = (chatId: string, folders: string[], hoursAgo = 1): ChatRow =>
    ({ chatId, title: chatId, at: NOW.getTime() - hoursAgo * HOUR, folders, working: false });

const ids = (chats: ChatRow[]) => chats.map(chat => chat.chatId);

const NONE = new Map<string, string>();

describe("groupChats", () => {

    it("groups by the first folder, A to Z, with no-folder sessions last", () => {

        const groups = groupChats([
            row("a", ["C:\\work\\web"]),
            row("b", []),
            row("c", ["C:\\work\\api", "C:\\work\\web"]),
            row("d", ["C:\\work\\Zeta"])
        ]);

        expect(groups.map(group => group.label)).toEqual(["api", "web", "Zeta", NO_FOLDER]);
        expect(ids(groups[0]!.chats)).toEqual(["c"]);
        expect(groups[0]!.path).toBe("C:\\work\\api");
        expect(groups[3]!.path).toBeUndefined();
        expect(ids(groups[3]!.chats)).toEqual(["b"]);
    });

    it("puts two spellings of one Windows folder in one group", () => {

        const groups = groupChats([row("a", ["C:\\work\\api"]), row("b", ["c:/work/API/"])]);

        expect(groups).toHaveLength(1);
        expect(ids(groups[0]!.chats).sort()).toEqual(["a", "b"]);
    });

    it("tells two folders with one name apart by the folder above them", () => {

        const groups = groupChats([row("c", ["C:\\work\\web"]), row("b", ["C:\\work\\api"]), row("a", ["D:\\Old\\api"])]);

        // Sorted by the folder's own name: both `api` before `web`, even
        // though the label `work/api` would come after `web`.
        expect(groups.map(group => group.label)).toEqual(["Old/api", "work/api", "web"]);
    });

    it("falls back to the full path when the folder above has one name too", () => {

        const groups = groupChats([row("a", ["C:\\x\\work\\api"]), row("b", ["D:\\y\\work\\api"])]);

        expect(groups.map(group => group.label)).toEqual(["C:\\x\\work\\api", "D:\\y\\work\\api"]);
    });

    it("lists a folder's sessions newest first, with no day headings", () => {

        const groups = groupChats([
            row("old", ["D:\\api"], 24 * 30),
            row("yesterday", ["D:\\api"], 20),
            row("now", ["D:\\api"], 1),
            row("earlier", ["D:\\api"], 3)
        ]);

        expect(ids(groups[0]!.chats)).toEqual(["now", "earlier", "yesterday", "old"]);
    });
});

describe("workspaces", () => {

    const api: Workspace = { name: "api", folders: ["C:\\work\\api", "C:\\work\\shared"], runtime: "claude", model: "opus" };
    const empty: Workspace = { name: "billing", folders: ["C:\\work\\billing"] };

    it("shows a folder with no session yet as its own group, A to Z with the rest", () => {

        const groups = groupChats([row("w", ["C:\\work\\web"]), row("loose", [])], NONE, [empty]);

        expect(groups.map(group => group.label)).toEqual(["billing", "web", NO_FOLDER]);
        expect(groups[0]!.chats).toEqual([]);
        expect(groups[0]!.workspace).toEqual(empty);
        expect(groups[1]!.workspace).toBeUndefined();
    });

    it("puts the defaults on the group its sessions are in, whatever the spelling", () => {

        const groups = groupChats([row("a", ["c:/work/API/"])], NONE, [api]);

        expect(groups).toHaveLength(1);
        expect(ids(groups[0]!.chats)).toEqual(["a"]);
        expect(groups[0]!.workspace).toEqual(api);
    });

    it("starts a folder with no session closed", () => {

        expect([...startCollapsed([], [empty])]).toEqual([folderKey(empty.folders[0]!)]);
    });

    it("names a workspace by its own name, over a folder alias, and other folders by their alias", () => {

        const aliases = new Map([[folderKey("C:\\work\\billing"), "Old alias"], [folderKey("C:\\work\\web"), "Front end"]]);
        const names = namesOf(aliases, [{ ...empty, name: "Billing team" }]);

        const groups = groupChats([row("w", ["C:\\work\\web"]), row("b", ["c:/work/billing"])], names, [{ ...empty, name: "Billing team" }]);

        expect(groups.map(group => group.label)).toEqual(["Billing team", "Front end"]);
        expect(namesOf(aliases, [])).toBe(aliases);
    });
});

describe("folder aliases", () => {

    // Kept under the folder's key, as the server keeps them.
    const aliases = new Map([[folderKey("C:\\work\\zeta"), "Billing"]]);

    it("shows a folder by its alias, any spelling of it, and sorts by the alias", () => {

        const groups = groupChats([row("a", ["C:\\work\\api"]), row("z", ["c:/work/Zeta/"]), row("w", ["C:\\work\\web"])], aliases);

        expect(groups.map(group => group.label)).toEqual(["api", "Billing", "web"]);
        expect(groups[1]!.path).toBe("c:/work/Zeta/");
    });

    it("lets a folder with an alias stop clashing with another of its name", () => {

        const named = new Map([[folderKey("D:\\Old\\api"), "Old API"]]);

        const groups = groupChats([row("a", ["C:\\work\\api"]), row("b", ["D:\\Old\\api"])], named);

        expect(groups.map(group => group.label)).toEqual(["api", "Old API"]);
    });

    it("shows the alias in a session's folder line too", () => {

        expect(folderLine(["C:\\work\\zeta", "D:\\api"], aliases)).toBe("Billing, api");
        expect(folderLine([], aliases)).toBe(NO_FOLDER);
    });
});

describe("a folder whose sessions are pinned or archived", () => {

    const api = "C:\\work\\api";

    it("stays in the list, empty, and counts where its sessions went", () => {

        const groups = groupChats([
            { ...row("pinned", [api], 1), mark: "pinned" },
            { ...row("archived", [api], 2), mark: "archived" },
            { ...row("archived too", [api], 3), mark: "archived" },
            { ...row("loose pinned", [], 1), mark: "pinned" }
        ]);

        expect(groups.map(group => [group.label, ids(group.chats), group.pinned, group.archived])).toEqual([
            ["api", [], 1, 2],
            [NO_FOLDER, [], 1, 0]
        ]);
    });

    it("lists only its other sessions", () => {

        const [group] = groupChats([{ ...row("pinned", [api], 1), mark: "pinned" }, row("plain", [api], 2)]);

        expect(ids(group!.chats)).toEqual(["plain"]);
        expect(group!.pinned).toBe(1);
    });

    it("says where they went under an empty folder", () => {

        expect(emptyFolderText({ pinned: 1, archived: 2 })).toBe("No other sessions - 1 pinned, 2 archived.");
        expect(emptyFolderText({ pinned: 0, archived: 1 })).toBe("No other sessions - 1 archived.");
        expect(emptyFolderText({ pinned: 0, archived: 0 })).toBe("No sessions yet.");
    });

    it("starts closed, even with a pinned session working", () => {

        const start = startCollapsed([{ ...row("pinned", [api], 1), mark: "pinned", working: true }]);

        expect([...start]).toEqual([folderKey(api)]);
    });
});

describe("deleting a folder's sessions", () => {

    const chats: ChatRow[] = [
        row("today", ["D:\\api"], 1),
        { ...row("pinned", ["d:/API"], 2), mark: "pinned" },
        { ...row("archived", ["D:\\api", "D:\\web"], 30), mark: "archived" },
        row("other", ["D:\\web", "D:\\api"], 1),
        row("loose", [], 1)
    ];

    it("takes every session whose first folder it is - pinned and archived ones too", () => {

        expect(ids(chatsIn(chats, folderKey("D:\\api")))).toEqual(["today", "pinned", "archived"]);
        expect(ids(chatsIn(chats, ""))).toEqual(["loose"]);
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

    it("is the pinned sessions, then each folder's sessions newest first, with archived sessions left out", () => {

        const chats: ChatRow[] = [
            { ...row("pinned", ["C:\\work\\web"], 1), mark: "pinned" },
            row("web-old", ["C:\\work\\web"], 100),
            row("api", ["C:\\work\\api"], 3),
            { ...row("archived", ["C:\\work\\api"], 4), mark: "archived" },
            row("web-new", ["C:\\work\\web"], 2)
        ];

        expect(ids(listOrder(chats))).toEqual(["pinned", "api", "web-new", "web-old"]);
    });
});

describe("the Recent group", () => {

    it("is the five newest sessions, newest first, whatever their order in", () => {

        const chats = [8, 2, 6, 1, 7, 3, 5, 4].map(hoursAgo => row(`h${hoursAgo}`, [], hoursAgo));

        expect(ids(recentChats(chats))).toEqual(["h1", "h2", "h3", "h4", "h5"]);
    });

    it("leaves out pinned and archived sessions, and shows fewer when there are fewer", () => {

        const chats: ChatRow[] = [
            { ...row("pinned", [], 1), mark: "pinned" },
            { ...row("archived", [], 2), mark: "archived" },
            row("plain", ["C:\\work\\api"], 3)
        ];

        expect(ids(recentChats(chats))).toEqual(["plain"]);
    });

    it("does not change the list it is given", () => {

        const chats = [row("old", [], 9), row("new", [], 1)];

        recentChats(chats);

        expect(ids(chats)).toEqual(["old", "new"]);
    });

    it("leaves out the phase chats nobody typed in", () => {

        const chats: ChatRow[] = [
            { ...row("wave", ["C:\\work\\api"], 1), spec: { spec: "login", phase: "implement@wave:1" } },
            { ...row("design", ["C:\\work\\api"], 2), spec: { spec: "login", phase: "design" }, typed: true },
            row("plain", ["C:\\work\\api"], 3)
        ];

        expect(ids(recentChats(chats))).toEqual(["design", "plain"]);
    });
});

describe("phase chats under their spec", () => {

    const phase = (chatId: string, spec: string, hoursAgo: number, folder?: string): ChatRow =>
        ({ ...row(chatId, ["C:\\work\\api"], hoursAgo), title: `${spec} · ${chatId}`, spec: { spec, phase: chatId, ...(folder ? { folder } : {}) } });

    it("fold under one row per spec, where the spec's newest chat would be", () => {

        const lines = foldSpecs([row("a", [], 1), phase("design", "login", 2), row("b", [], 3), phase("requirements", "login", 4), phase("tasks", "billing", 5)]);

        expect(lines.map(line => "fold" in line ? `spec:${line.fold.spec}` : line.chat.chatId)).toEqual(["a", "spec:login", "b", "spec:billing"]);

        const login = lines[1]!;

        expect("fold" in login && ids(login.fold.chats)).toEqual(["design", "requirements"]);
    });

    it("keep two specs of one name in different folders apart", () => {

        const lines = foldSpecs([phase("design", "login", 1), phase("design2", "login", 2, "C:\\work\\web")]);

        expect(lines).toHaveLength(2);
        expect("fold" in lines[1]! && lines[1].fold.folder).toBe("C:\\work\\web");
    });

    it("show without the spec's name in front", () => {

        expect(phaseTitle("login · Design", "login")).toBe("Design");
        expect(phaseTitle("My own name", "login")).toBe("My own name");
        expect(phaseTitle("login · ", "login")).toBe("login · ");
    });

    it("fold the wave chats once more, under one row per phase, where the newest wave chat would be", () => {

        const wave = (chatId: string, phaseId: string, hoursAgo: number): ChatRow =>
            ({ ...row(chatId, ["C:\\work\\api"], hoursAgo), spec: { spec: "login", phase: phaseId } });

        const lines = foldWaves([
            wave("w1", "implement@wave:1", 1),
            wave("tasks", "tasks", 2),
            wave("w0", "implement@wave:0", 3),
            wave("lane", "implement@1.1", 4),
            wave("design", "design", 5)
        ]);

        expect(lines.map(line => "waves" in line ? `waves:${line.waves.stage}:${ids(line.waves.chats).join(",")}` : line.chat.chatId))
            .toEqual(["waves:implement:w1,w0,lane", "tasks", "design"]);
    });
});

/*
 * A link to a spec - on the start page, the workspace page and in the Spec
 * explorer - goes straight to its newest phase chat with the spec as a
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

describe("closing folders", () => {

    const web = folderKey("C:\\work\\web");

    it("closes a folder, and opens it again", () => {

        const closed = toggleFolder(NOTHING_COLLAPSED, web);

        expect([...closed]).toEqual([web]);
        expect(toggleFolder(closed, web).size).toBe(0);
    });

    it("opens the folder a session sits in, and changes nothing when it is open", () => {

        const place = placeOf(row("new", ["C:\\work\\web\\"], 1));

        expect(place).toBe(web);

        const shown = reveal(toggleFolder(NOTHING_COLLAPSED, web), place);

        expect(shown.size).toBe(0);
        expect(reveal(shown, place)).toBe(shown);
    });

    it("starts with every folder closed but those of a working or waiting session", () => {

        const api = "C:\\work\\api";

        const start = startCollapsed([
            { ...row("api-working", [api], 1), working: true },
            row("api-old", [api], 100),
            { ...row("web-waiting", ["C:\\work\\web"], 30), waiting: "Allow the edit?" },
            row("loose", [], 1),
            row("tools", ["C:\\work\\tools"], 1),
            { ...row("pinned", ["C:\\work\\tools"], 1), mark: "pinned", working: true }
        ]);

        expect([...start].sort()).toEqual(["", folderKey("C:\\work\\tools")].sort());
    });

    it("places a session with no folder in the No folder group", () => {

        expect(placeOf(row("loose", [], 30))).toBe(groupChats([row("loose", [], 30)])[0]!.key);
    });
});

describe("more than one workspace on a folder", () => {

    const API = "C:\\work\\api";
    const first: Workspace = { name: "12 Login page", folders: [API], created: 1 };
    const second: Workspace = { id: "c:\\work\\api::b", name: "13 Logout", folders: [API], created: 2 };

    it("lists each workspace's sessions under it, and a session with no workspace under the folder's own", () => {

        const groups = groupChats([
            row("old", [API]),
            { ...row("new", [API]), workspace: "c:\\work\\api::b" }
        ], NONE, [first, second]);

        expect(groups.map(group => [group.key, ids(group.chats)])).toEqual(expect.arrayContaining([
            [folderKey(API), ["old"]],
            ["c:\\work\\api::b", ["new"]]
        ]));
    });

    it("marks an archived workspace hidden and keeps its sessions out of Recent", () => {

        const chats = [row("old", [API], 2), { ...row("new", [API], 1), workspace: "c:\\work\\api::b" }];
        const groups = groupChats(chats, NONE, [first, { ...second, archived: true }]);

        expect(groups.find(group => group.key === "c:\\work\\api::b")?.hidden).toBe(true);
        expect(groups.find(group => group.key === folderKey(API))?.hidden).toBeUndefined();
        expect(ids(recentChats(chats, 5, new Set(["c:\\work\\api::b"])))).toEqual(["old"]);
    });
});
