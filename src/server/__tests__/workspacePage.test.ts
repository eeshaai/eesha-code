import "./homeGuard";

import { describe, expect, it } from "vitest";

import { type ChatRow, folderKey, type SpecExplorerView, type SpecTreeRow } from "../protocol";
import { chatsHere, foldersText, linkLabel, recentSpecFacts, recentSpecId, recentSpecs, runtimeText, specCount, startSpecFacts, workspaceChats } from "../../web/workspaceView";

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

    it("takes only the sessions of this workspace - by its key, else its main folder", () => {

        const chats = [
            chat("a", 1, { workspace: "ws-2" }),
            chat("b", 2),
            chat("c", 3, { folders: ["D:\\other"] })
        ];

        expect(chatsHere(chats, "ws-2").map(one => one.chatId)).toEqual(["a"]);
        expect(chatsHere(chats, HOME).map(one => one.chatId)).toEqual(["b"]);
    });

    it("lists the waiting ones, the newest not archived, and the one Resume opens", () => {

        const chats = [
            chat("old", 1),
            chat("asks", 2, { waiting: "Run it?" }),
            chat("gone", 5, { mark: "archived" }),
            chat("new", 4),
            chat("elsewhere", 9, { folders: ["D:\\other"] })
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

describe("the workspace page's recent specs", () => {

    const view: SpecExplorerView = {
        sort: "alpha",
        folders: [
            { folder: "D:\\app", main: true, notes: [], specs: [spec("alpha", 100), spec("beta", 300), spec("theirs", 900, { elsewhere: true })] },
            { folder: "D:\\lib", main: false, notes: [], specs: [spec("alpha", 200), spec("never", undefined)] }
        ]
    };

    it("puts the most recently changed first, from every folder, and leaves out other workspaces' specs", () => {

        const list = recentSpecs(view);

        expect(list.map(one => [one.spec.name, one.folder])).toEqual([
            ["beta", undefined],
            ["alpha", "D:\\lib"],
            ["alpha", undefined],
            ["never", "D:\\lib"]
        ]);
        expect(specCount(view)).toBe(4);
    });

    it("takes only as many as asked", () => {

        expect(recentSpecs(view, 2).map(one => one.spec.name)).toEqual(["beta", "alpha"]);
    });

    it("tells two specs of one name apart by their folder", () => {

        const [, inLib, inMain] = recentSpecs(view);

        expect(recentSpecId(inLib!)).not.toBe(recentSpecId(inMain!));
    });

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

describe("the workspace page's heading", () => {

    it("names the work item or issue", () => {

        expect(linkLabel({ connector: "ado", kind: "workitem", id: "12345", title: "Login", path: [] })).toBe("ADO #12345");
        expect(linkLabel({ connector: "github", kind: "issue", id: "me/app#12", title: "Login", path: [] })).toBe("GitHub me/app#12");
    });

    it("says the folders", () => {

        expect(foldersText({ folders: ["D:\\code\\app"] })).toBe("app");
        expect(foldersText({ folders: ["D:\\code\\app", "D:\\lib"] })).toBe("app and 1 more folder");
        expect(foldersText({ folders: ["D:\\code\\app", "D:\\lib", "D:\\docs"] })).toBe("app and 2 more folders");
    });

    it("says the runtime and model, or nothing for the server's default", () => {

        expect(runtimeText({ runtime: "copilot", model: "sonnet" })).toBe("copilot · sonnet");
        expect(runtimeText({ runtime: "copilot" })).toBe("copilot");
        expect(runtimeText({})).toBeUndefined();
    });
});
