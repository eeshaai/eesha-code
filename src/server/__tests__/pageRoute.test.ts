// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { folderKey } from "../protocol";
import { chatAddress, columnAddress, columnOfAddress, EVAL_PATH, evalAddress, evalOfAddress, evalShownOfAddress, PAGE_PATHS, pageOfPath, routeOf, SDD_PATH, sddAddress, sddOfAddress, setAddressBook, SETTINGS_PATHS, SETTINGS_SECTIONS, settingsAddress, WORKSPACE_PATH, workspaceAddress, workspaceOfAddress } from "../../web/pageRoute";

describe("the Settings addresses", () => {

    it("names the section from the path", () => {

        expect(pageOfPath("/settings/runtimes")).toBe("runtimes");
        expect(pageOfPath("/settings/connectors")).toBe("connectors");
        expect(pageOfPath("/settings/storage/")).toBe("storage");

        for (const section of SETTINGS_SECTIONS)
            expect(pageOfPath(`/settings/${section}`)).toBe(section);
    });

    it("opens General for plain /settings", () => {

        expect(pageOfPath("/settings")).toBe("general");
        expect(pageOfPath("/settings/")).toBe("general");
    });

    it("names no section for the chat or any other path", () => {

        expect(pageOfPath("/")).toBeUndefined();
        expect(pageOfPath("")).toBeUndefined();
        expect(pageOfPath("/connectors")).toBeUndefined();
        expect(pageOfPath("/connectors/ado")).toBeUndefined();
        expect(pageOfPath("/settings/nope")).toBeUndefined();
        expect(pageOfPath("/settings/runtimes/x")).toBeUndefined();
        expect(pageOfPath("/Settings")).toBeUndefined();
    });

    it("gives each section its own address, with no chat in it", () => {

        expect(settingsAddress("connectors")).toBe("/settings/connectors");
        expect(settingsAddress()).toBe("/settings/general");
    });


    it("lists every path that shows Settings, and each one names a section", () => {

        for (const path of SETTINGS_PATHS)
            expect(pageOfPath(path)).toBeDefined();

        expect(SETTINGS_PATHS).toContain("/settings/features");
    });
});

describe("the session addresses", () => {

    it("puts only the session in its address", () => {

        expect(chatAddress("abc")).toBe("/?chat=abc");
        expect(chatAddress("a b&c")).toBe("/?chat=a+b%26c");
    });

    it("gives the start page the plain address", () => {

        expect(chatAddress(undefined)).toBe("/");
        expect(chatAddress("")).toBe("/");
    });

    it("gets the page for each path once", () => {

        expect(PAGE_PATHS).toEqual(expect.arrayContaining(["/", "/settings/runtimes", SDD_PATH]));
        expect(new Set(PAGE_PATHS).size).toBe(PAGE_PATHS.length);
    });
});

describe("the SDD addresses", () => {

    it("names a workspace's spec, or with no spec the workspace's list only", () => {

        expect(sddAddress("c:/work/billing", "mask-secrets")).toBe("/sdd?workspace=c%3A%2Fwork%2Fbilling&spec=mask-secrets");
        expect(sddAddress("c:/work/billing")).toBe("/sdd?workspace=c%3A%2Fwork%2Fbilling");
    });

    it("has no spec without a workspace", () => {

        expect(sddAddress(undefined, "mask-secrets")).toBe("/sdd");
        expect(sddAddress(undefined)).toBe("/sdd");
    });

    it("reads back what it wrote", () => {

        const written = new URL(sddAddress("c:/work/a b&c", "spec.one"), "http://127.0.0.1");

        expect(sddOfAddress(written.pathname, written.search)).toEqual({ workspace: "c:/work/a b&c", spec: "spec.one" });
    });

    it("reads the plain path, a trailing slash, and drops a spec named with no workspace", () => {

        expect(sddOfAddress("/sdd", "")).toEqual({});
        expect(sddOfAddress("/sdd/", "?workspace=k")).toEqual({ workspace: "k" });
        expect(sddOfAddress("/sdd", "?spec=lost")).toEqual({});
        expect(sddOfAddress("/sdd", "?workspace=&spec=lost")).toEqual({});
    });

    it("is not the SDD module on any other path", () => {

        expect(sddOfAddress("/", "?workspace=k&spec=s")).toBeUndefined();
        expect(sddOfAddress("/settings", "")).toBeUndefined();
        expect(sddOfAddress("/sdd/x", "")).toBeUndefined();
    });

    it("is one of the paths the server sends the page for", () => {

        expect(PAGE_PATHS).toContain(SDD_PATH);
    });

    it("names a spec in another folder, and a phase or a session to show first - the Spec explorer's clicks", () => {

        const more = { folder: "d:/code/ui lib", phase: "design", session: { ownerId: "implement@wave:2", iteration: 3 } };
        const written = new URL(sddAddress("k", "login", more), "http://127.0.0.1");

        expect(sddOfAddress(written.pathname, written.search)).toEqual({ workspace: "k", spec: "login", ...more });

        // The session still open has no number.
        const open = new URL(sddAddress("k", "login", { session: { ownerId: "design" } }), "http://127.0.0.1");

        expect(sddOfAddress(open.pathname, open.search)).toEqual({ workspace: "k", spec: "login", session: { ownerId: "design" } });
    });

    it("drops the folder, phase and session with no spec, and a session number that is not one", () => {

        expect(sddAddress("k", undefined, { folder: "d:/x", phase: "design" })).toBe("/sdd?workspace=k");
        expect(sddOfAddress("/sdd", "?workspace=k&folder=d%3A%2Fx&phase=design")).toEqual({ workspace: "k" });
        expect(sddOfAddress("/sdd", "?workspace=k&spec=s&session=design&n=abc")).toEqual({ workspace: "k", spec: "s", session: { ownerId: "design" } });
    });
});

describe("the workspace page addresses", () => {

    it("names the workspace by its key, and reads it back", () => {

        const written = new URL(workspaceAddress("c:/work/a b&c"), "http://x");

        expect(written.pathname).toBe(WORKSPACE_PATH);
        expect(workspaceOfAddress(written.pathname, written.search)).toBe("c:/work/a b&c");
    });

    it("is a workspace page with no workspace when the key is missing or empty", () => {

        expect(workspaceOfAddress("/workspace", "")).toBe("");
        expect(workspaceOfAddress("/workspace/", "?workspace=")).toBe("");
    });

    it("is not a workspace page on any other path", () => {

        expect(workspaceOfAddress("/", "?workspace=k")).toBeUndefined();
        expect(workspaceOfAddress("/sdd", "?workspace=k")).toBeUndefined();
        expect(workspaceOfAddress("/workspace/x", "?workspace=k")).toBeUndefined();
    });

    it("gets the page from the server, so a reload shows it again", () => {

        expect(PAGE_PATHS).toContain(WORKSPACE_PATH);
    });
});

describe("the Evaluator addresses", () => {

    it("names one evaluation in the path, and the list with none", () => {

        expect(evalAddress()).toBe(EVAL_PATH);
        expect(evalAddress("login-refactor")).toBe("/eval/login-refactor");

        expect(evalOfAddress("/eval")).toEqual({});
        expect(evalOfAddress("/eval/")).toEqual({});
        expect(evalOfAddress("/eval/login-refactor")).toEqual({ name: "login-refactor" });
    });

    it("says in the query what an evaluation's page shows: the report, or one variant alone", () => {

        expect(evalAddress("one", { report: true })).toBe("/eval/one?view=report");
        expect(evalAddress("one", { variant: "one-2" })).toBe("/eval/one?variant=one-2");
        expect(evalAddress("one", {})).toBe("/eval/one");

        // The list has nothing to show apart from itself.
        expect(evalAddress(undefined, { report: true })).toBe(EVAL_PATH);

        expect(evalShownOfAddress("")).toEqual({});
        expect(evalShownOfAddress("?view=report")).toEqual({ report: true });
        expect(evalShownOfAddress("?variant=one-2")).toEqual({ variant: "one-2" });
        expect(evalShownOfAddress("?view=report&variant=one-2")).toEqual({ report: true });
        expect(evalShownOfAddress("?view=other")).toEqual({});
    });

    it("is not the Evaluator on any other path", () => {

        expect(evalOfAddress("/")).toBeUndefined();
        expect(evalOfAddress("/evaluate")).toBeUndefined();
        expect(evalOfAddress("/eval/a/b")).toBeUndefined();
    });

    it("gives a variant's chat its own address, with nothing around it", () => {

        const written = new URL(columnAddress("2026-11-24T10-00-00-abc"), "http://x");

        expect(written.pathname).toBe("/");
        expect(columnOfAddress(written.search)).toBe(true);
        expect(written.searchParams.get("chat")).toBe("2026-11-24T10-00-00-abc");

        // A session's own address is never a column, and a column needs a chat.
        expect(columnOfAddress("?chat=abc")).toBe(false);
        expect(columnOfAddress("?column=1")).toBe(false);
    });

    it("gets the page from the server", () => {

        expect(PAGE_PATHS).toContain(EVAL_PATH);
    });
});

/*
 * Which addresses the page shows with no page load (`goTo`, Back and
 * Forward, a click on a link) - read with the lists it has.
 */
describe("moving with no page load", () => {

    const BASE = "http://127.0.0.1:4000/login-bug";
    const WORKSPACE = { name: "Login bug", folders: ["D:\app"] };
    const KEY = folderKey("D:\app");
    const CHAT = { chatId: "2026-11-26T10-00-00-k3x9q2", title: "Fix the token", at: 1, folders: [], working: false, workspace: KEY };

    it("reads a session and a workspace page by name, the start page, and the older addresses by their query", () => {

        setAddressBook([CHAT], [WORKSPACE]);

        expect(chatAddress(CHAT.chatId)).toBe("/login-bug/fix-the-token-k3x9q2");
        expect(workspaceAddress(KEY, { spec: "login" })).toBe("/login-bug?spec=login");

        expect(routeOf("/login-bug/fix-the-token-k3x9q2", BASE)).toEqual({ route: { chat: CHAT.chatId }, address: "/login-bug/fix-the-token-k3x9q2" });
        expect(routeOf("/login-bug/login/old-name-k3x9q2", BASE)).toEqual({ route: { chat: CHAT.chatId, spec: { spec: "login" } }, address: "/login-bug/login/fix-the-token-k3x9q2" });
        expect(routeOf("/login-bug", BASE)).toEqual({ route: { workspace: KEY }, address: "/login-bug" });
        expect(routeOf("/", BASE)).toEqual({ address: "/" });
        expect(routeOf("/?chat=new-one", BASE)).toEqual({ address: "/?chat=new-one" });
        expect(routeOf(`/workspace?workspace=${encodeURIComponent(KEY)}`, BASE)).toEqual({ address: `/workspace?workspace=${encodeURIComponent(KEY)}` });

        setAddressBook([], []);
    });

    it("leaves to a real page load: Settings, the Evaluator, /sdd, a column, another site, and a name it has not heard of", () => {

        for (const address of ["/settings/general", "/eval", "/eval/one", "/sdd?workspace=x&spec=y", "/?chat=a&column=1", "https://example.com/login-bug", "/someone-else", "/?key=abc"])
            expect(routeOf(address, BASE)).toBeUndefined();
    });
});
