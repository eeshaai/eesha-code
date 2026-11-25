import { describe, expect, it } from "vitest";

import { folderKey, type ChatRow, type Workspace } from "../../server/protocol";
import { addressName, chatPath, chatToken, resolveAddress, sessionPart, workspaceParts, workspacePath } from "../pageAddress";

/*
 * The workspace and session addresses: /<workspace>, /<workspace>/<session>,
 * /<workspace>/<spec>/<session> and /no-workspace/<session>.
 */

const LOGIN: Workspace = { name: "12 Login page", folders: ["D:\\app"], created: 1 };
const LOGIN_AGAIN: Workspace = { id: "d:/app::b", name: "12 Login Page!", folders: ["D:\\app"], created: 2 };
const SETTINGS: Workspace = { name: "Settings", folders: ["D:\\set"], created: 3 };

const ALL = [LOGIN_AGAIN, SETTINGS, LOGIN];

const chat = (chatId: string, title: string, more: Partial<ChatRow> = {}): ChatRow =>
    ({ chatId, title, at: 1, folders: [], working: false, ...more });

const FIX = chat("2026-11-26T10-00-00-k3x9q2", "Fix the login bug", { workspace: folderKey("D:\\app") });
const PHASE = chat("2026-11-26T11-00-00-a1b2c3", "login · Design", { workspace: "d:/app::b", spec: { spec: "login", phase: "design" } });
const LOOSE = chat("2026-11-26T12-00-00-zz99yy", "Try a thing");

describe("names in an address", () => {

    it("writes a name in lower case with - for spaces and signs", () => {

        expect(addressName("12 Login page!")).toBe("12-login-page");
        expect(addressName("  Café  déjà vu ")).toBe("cafe-deja-vu");
        expect(addressName("!!!")).toBe("");
        expect(addressName("a".repeat(80))).toHaveLength(48);
    });

    it("gives the older of two workspaces with one name the plain name, the next one -2, and never a name the page uses", () => {

        const parts = workspaceParts(ALL);

        expect(parts.get(folderKey("D:\\app"))).toBe("12-login-page");
        expect(parts.get("d:/app::b")).toBe("12-login-page-2");
        expect(parts.get(folderKey("D:\\set"))).toBe("settings-2");
    });

    it("names a session by its name, a phase chat by its phase, and ends both with the last part of the id", () => {

        expect(chatToken(FIX.chatId)).toBe("k3x9q2");
        expect(sessionPart(FIX)).toBe("fix-the-login-bug-k3x9q2");
        expect(sessionPart(PHASE)).toBe("design-a1b2c3");
        expect(sessionPart(chat("2026-11-26T12-00-00-abcdef", "???"))).toBe("abcdef");
    });
});

describe("the addresses made", () => {

    const parts = workspaceParts(ALL);

    it("puts a session under its workspace, and a spec beside it between the two", () => {

        expect(chatPath(FIX, parts)).toBe("/12-login-page/fix-the-login-bug-k3x9q2");
        expect(chatPath(PHASE, parts, { spec: "login" })).toBe("/12-login-page-2/login/design-a1b2c3");
        expect(chatPath(PHASE, parts, { spec: "login", folder: "D:\\lib" })).toBe("/12-login-page-2/login/design-a1b2c3?specFolder=D%3A%5Clib");
    });

    it("puts a session in no workspace under no-workspace, and never a spec beside it", () => {

        expect(chatPath(LOOSE, parts)).toBe("/no-workspace/try-a-thing-zz99yy");
        expect(chatPath(LOOSE, parts, { spec: "login" })).toBe("/no-workspace/try-a-thing-zz99yy");
        expect(chatPath({ ...FIX, workspace: "gone" }, parts)).toBe("/no-workspace/fix-the-login-bug-k3x9q2");
    });

    it("gives a workspace page its name, with a spec beside it in the query", () => {

        expect(workspacePath(folderKey("D:\\app"), parts)).toBe("/12-login-page");
        expect(workspacePath(folderKey("D:\\app"), parts, { spec: "login" })).toBe("/12-login-page?spec=login");
        expect(workspacePath("gone", parts)).toBeUndefined();
    });
});

describe("reading an address", () => {

    const chats = [FIX, PHASE, LOOSE];
    const read = (address: string) => {

        const url = new URL(address, "http://x");

        return resolveAddress(url.pathname, url.search, chats, ALL);
    };

    it("reads back every address it makes, as it made it", () => {

        const parts = workspaceParts(ALL);

        for (const address of [chatPath(FIX, parts), chatPath(PHASE, parts, { spec: "login" }), chatPath(LOOSE, parts), workspacePath("d:/app::b", parts, { spec: "login" })!])
            expect(read(address)?.address).toBe(address);
    });

    it("finds a workspace page, and a session with or without a spec beside it", () => {

        expect(read("/12-login-page-2?spec=login")?.route).toEqual({ workspace: "d:/app::b", spec: { spec: "login" } });
        expect(read("/12-login-page/fix-the-login-bug-k3x9q2")?.route).toEqual({ chat: FIX.chatId });
        expect(read("/12-login-page-2/login/design-a1b2c3?specFolder=D%3A%5Clib")?.route).toEqual({ chat: PHASE.chatId, spec: { spec: "login", folder: "D:\\lib" } });
    });

    it("finds a session by the last part of its id alone, and says its address now - after a rename or a move", () => {

        expect(read("/old-name/old-title-k3x9q2")).toEqual({ route: { chat: FIX.chatId }, address: "/12-login-page/fix-the-login-bug-k3x9q2" });
        expect(read("/12-login-page/K3X9Q2")?.address).toBe("/12-login-page/fix-the-login-bug-k3x9q2");
    });

    it("finds nothing where nothing is, and leaves the page's own paths alone", () => {

        expect(read("/nowhere")).toBeUndefined();
        expect(read("/12-login-page/fix-the-login-bug-000000")).toBeUndefined();
        expect(read("/settings/general")).toBeUndefined();
        expect(read("/a/b/c/d")).toBeUndefined();
        expect(read("/")).toBeUndefined();
        expect(read("/%E0%A4%A")).toBeUndefined();
    });
});
