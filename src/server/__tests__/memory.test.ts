// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLAUDE_MEMORY_HELD, claudeWaits, memoryEnv } from "../memory/claudeMemory";
import { checkMemoryChange, DEFAULT_MEMORY, memoryFrom, readMemoryChoices, saveMemoryChoices } from "../memory/config";
import { Memory, scopesOf, type MemoryQuestion, type SessionPlace } from "../memory/Memory";
import { MemoryStore, TEXT_LIMIT, textProblem, TITLE_LIMIT, titleProblem } from "../memory/memoryStore";
import { eeshaPath } from "../paths";
import { folderKey, type MemoryChoices, type Workspace } from "../protocol";

/*
 * Memory: the database, the choices in settings.json, the AI's tools,
 * what a new session is told, the `>memory` rows and the Memory page.
 * The database is kept in memory only, except where a test says a file.
 */

function temporaryFolder(): string {

    return fs.mkdtempSync(path.join(os.tmpdir(), "eesha-memory-"));
}

const WRITE: MemoryChoices = { access: "write", askOnSave: false, claudeMemoryOff: false };

/** A Memory over a database in memory, with choices a test can change. */
function setUp(choices: MemoryChoices = WRITE) {

    const state = { choices };
    const store = new MemoryStore(":memory:");
    const memory = new Memory({ store, readChoices: () => state.choices });
    const asked: MemoryQuestion[] = [];
    const notes: string[] = [];

    /** What `ask` answers. */
    const answers = { allow: true };

    const hooks = {
        ask: async (question: MemoryQuestion) => { asked.push(question); return answers.allow; },
        note: (text: string) => { notes.push(text); }
    };

    const call = async (name: string, args: unknown, place: SessionPlace) => {

        const result = await memory.call(name, args, place, hooks);

        return { ...result, value: result.isError ? undefined : JSON.parse(result.text) };
    };

    return { state, store, memory, asked, notes, answers, call };
}

const API_FOLDER = path.resolve(os.tmpdir(), "eesha-memory-api");
const WEB_FOLDER = path.resolve(os.tmpdir(), "eesha-memory-web");

/** A session in a workspace with one folder. */
const IN_WORKSPACE: SessionPlace = { workspace: { key: "ws-1", name: "Login bug" }, folders: [API_FOLDER] };

/** A session in another workspace, with another folder. */
const ELSEWHERE: SessionPlace = { workspace: { key: "ws-2", name: "Search" }, folders: [WEB_FOLDER] };

/** A session with no folder: it works in its scratch folder. */
const NOWHERE: SessionPlace = { folders: [] };

describe("the memory database", () => {

    it("keeps a memory in a file, and reads it back after it is closed and opened again", () => {

        const file = path.join(temporaryFolder(), "deep", "memory.db");
        const first = new MemoryStore(file);

        const added = first.add({ level: "global", owner: "", place: "", title: " Tabs ", text: " Use tabs. ", author: "person" }, 1000);

        expect(added).toEqual({ id: 1, level: "global", owner: "", place: "", title: "Tabs", text: "Use tabs.", author: "person", created: 1000, updated: 1000 });

        first.close();

        const second = new MemoryStore(file);

        expect(second.all()).toEqual([added]);

        second.close();
    });

    it("makes no file until a memory is touched", () => {

        const file = path.join(temporaryFolder(), "memory.db");
        const store = new MemoryStore(file);

        store.close();

        expect(fs.existsSync(file)).toBe(false);
    });

    it("lists only the scopes asked for, the most recently changed first", () => {

        const store = new MemoryStore(":memory:");

        store.add({ level: "global", owner: "", place: "", title: "g", text: "g", author: "ai" }, 1);
        store.add({ level: "workspace", owner: "ws-1", place: "", title: "w1", text: "w1", author: "ai" }, 2);
        store.add({ level: "workspace", owner: "ws-2", place: "", title: "w2", text: "w2", author: "ai" }, 3);
        store.add({ level: "folder", owner: "f1", place: "F1", title: "f", text: "f", author: "ai" }, 4);

        expect(store.list([{ level: "global", owner: "" }, { level: "workspace", owner: "ws-1" }]).map(row => row.title)).toEqual(["w1", "g"]);
        expect(store.list([{ level: "folder", owner: "f1" }]).map(row => row.title)).toEqual(["f"]);
        expect(store.list([])).toEqual([]);
        expect(store.all().map(row => row.title)).toEqual(["f", "w2", "w1", "g"]);
    });

    it("finds by every word, in the title or the text, whatever the case", () => {

        const store = new MemoryStore(":memory:");
        const scopes = [{ level: "global" as const, owner: "" }];

        store.add({ level: "global", owner: "", place: "", title: "Commit style", text: "Short messages, no emoji.", author: "ai" });
        store.add({ level: "global", owner: "", place: "", title: "Tests", text: "Run vitest before a commit.", author: "ai" });

        expect(store.search(scopes, "COMMIT").map(row => row.title).sort()).toEqual(["Commit style", "Tests"]);
        expect(store.search(scopes, "commit emoji").map(row => row.title)).toEqual(["Commit style"]);
        expect(store.search(scopes, "nothing")).toEqual([]);
        expect(store.search(scopes, "  ")).toHaveLength(2);
    });

    it("changes only what is given, removes, and says when there was nothing", () => {

        const store = new MemoryStore(":memory:");
        const row = store.add({ level: "global", owner: "", place: "", title: "a", text: "b", author: "ai" }, 1);

        expect(store.update(row.id, { text: "c" }, 5)).toMatchObject({ title: "a", text: "c", level: "global", author: "ai", created: 1, updated: 5 });
        expect(store.update(row.id, { level: "workspace", owner: "ws-1" }, 6)).toMatchObject({ level: "workspace", owner: "ws-1", text: "c" });
        expect(store.update(99, { text: "x" })).toBeUndefined();

        expect(store.remove(row.id)).toBe(true);
        expect(store.remove(row.id)).toBe(false);
        expect(store.get(row.id)).toBeUndefined();
    });

    it("gives a folder's memories to another folder, and leaves the rest", () => {

        const store = new MemoryStore(":memory:");

        store.add({ level: "folder", owner: "old", place: "Old", title: "a", text: "a", author: "ai" });
        store.add({ level: "folder", owner: "old", place: "Old", title: "b", text: "b", author: "ai" });
        store.add({ level: "folder", owner: "other", place: "Other", title: "c", text: "c", author: "ai" });
        store.add({ level: "workspace", owner: "old", place: "", title: "d", text: "d", author: "ai" });

        expect(store.repoint("old", "new", "New")).toBe(2);
        expect(store.list([{ level: "folder", owner: "new" }]).map(row => [row.title, row.place]).sort()).toEqual([["a", "New"], ["b", "New"]]);
        expect(store.list([{ level: "folder", owner: "other" }])).toHaveLength(1);
        expect(store.list([{ level: "workspace", owner: "old" }])).toHaveLength(1);
        expect(store.repoint("old", "new", "New")).toBe(0);
    });

    it("says what is wrong with a title or a text", () => {

        expect(titleProblem("ok")).toBeUndefined();
        expect(titleProblem("")).toBeDefined();
        expect(titleProblem("   ")).toBeDefined();
        expect(titleProblem(12)).toBeDefined();
        expect(titleProblem("two\nlines")).toBeDefined();
        expect(titleProblem("x".repeat(TITLE_LIMIT))).toBeUndefined();
        expect(titleProblem("x".repeat(TITLE_LIMIT + 1))).toBeDefined();

        expect(textProblem("two\nlines")).toBeUndefined();
        expect(textProblem(" ")).toBeDefined();
        expect(textProblem(undefined)).toBeDefined();
        expect(textProblem("x".repeat(TEXT_LIMIT + 1))).toBeDefined();
    });
});

describe("the memory choices in settings.json", () => {

    const file = () => eeshaPath("settings.json");

    beforeEach(() => fs.rmSync(file(), { force: true }));
    afterEach(() => fs.rmSync(file(), { force: true }));

    it("is on with read and write when the file says nothing", () => {

        expect(readMemoryChoices()).toEqual({ access: "write", askOnSave: false, claudeMemoryOff: false });
        expect(memoryFrom({})).toEqual(DEFAULT_MEMORY);
        expect(memoryFrom({ eesha: { memory: "yes" } })).toEqual(DEFAULT_MEMORY);
    });

    it("takes the default for a value of the wrong kind, and keeps the right ones", () => {

        expect(memoryFrom({ eesha: { memory: { access: "everything", askOnSave: "yes", claudeMemoryOff: true } } }))
            .toEqual({ access: "write", askOnSave: false, claudeMemoryOff: true });

        expect(memoryFrom({ eesha: { memory: { access: "read", askOnSave: true } } }))
            .toEqual({ access: "read", askOnSave: true, claudeMemoryOff: false });
    });

    it("writes a change and keeps the rest of the file", async () => {

        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify({ eesha: { port: 7421, memory: { askOnSave: true } } }));

        expect(await saveMemoryChoices({ access: "read" })).toEqual({ ok: true });

        const written = JSON.parse(fs.readFileSync(file(), "utf8"));

        expect(written.eesha.port).toBe(7421);
        expect(written.eesha.memory).toEqual({ access: "read", askOnSave: true, claudeMemoryOff: false });
        expect(readMemoryChoices()).toEqual({ access: "read", askOnSave: true, claudeMemoryOff: false });
    });

    it("refuses a change of the wrong shape", () => {

        expect(checkMemoryChange({ access: "off", askOnSave: true, claudeMemoryOff: true })).toEqual({ change: { access: "off", askOnSave: true, claudeMemoryOff: true } });
        expect(checkMemoryChange({})).toEqual({ change: {} });
        expect(checkMemoryChange(undefined)).toHaveProperty("problem");
        expect(checkMemoryChange({ access: "all" })).toHaveProperty("problem");
        expect(checkMemoryChange({ askOnSave: 1 })).toHaveProperty("problem");
        expect(checkMemoryChange({ claudeMemoryOff: "yes" })).toHaveProperty("problem");
    });
});

describe("the memory tools", () => {

    it("lists the tools the choices allow", () => {

        const { memory, state } = setUp();

        expect(memory.tools().map(tool => tool.name)).toEqual(["memory_list", "memory_search", "memory_read", "memory_save", "memory_delete"]);
        expect(memory.on()).toBe(true);

        state.choices = { ...WRITE, access: "read" };

        expect(memory.tools().map(tool => tool.name)).toEqual(["memory_list", "memory_search", "memory_read"]);

        state.choices = { ...WRITE, access: "off" };

        expect(memory.tools()).toEqual([]);
        expect(memory.on()).toBe(false);
    });

    it("saves at each level and shows a notice, with no question", async () => {

        const { call, store, notes, asked } = setUp();

        const global = await call("memory_save", { level: "global", title: "Tabs", text: "Use tabs." }, IN_WORKSPACE);
        const workspace = await call("memory_save", { level: "workspace", title: "Cause", text: "The token expires." }, IN_WORKSPACE);
        const folder = await call("memory_save", { level: "folder", title: "Build", text: "npm run build." }, IN_WORKSPACE);

        expect(global.value).toEqual({ saved: { id: 1, level: "global", title: "Tabs" } });
        expect(workspace.value).toEqual({ saved: { id: 2, level: "workspace", where: "workspace Login bug", title: "Cause" } });
        expect(folder.value).toEqual({ saved: { id: 3, level: "folder", where: `folder ${API_FOLDER}`, title: "Build" } });

        expect(store.get(1)).toMatchObject({ level: "global", owner: "", author: "ai" });
        expect(store.get(2)).toMatchObject({ level: "workspace", owner: "ws-1" });
        expect(store.get(3)).toMatchObject({ level: "folder", owner: folderKey(API_FOLDER), place: API_FOLDER });

        expect(asked).toEqual([]);
        expect(notes).toEqual([
            "Memory saved (global): Tabs",
            "Memory saved (workspace Login bug): Cause",
            `Memory saved (folder ${API_FOLDER}): Build`
        ]);
    });

    it("lets a session reach only global, its own workspace and its own folders", async () => {

        const { call } = setUp();

        await call("memory_save", { level: "global", title: "g", text: "g" }, IN_WORKSPACE);
        await call("memory_save", { level: "workspace", title: "w", text: "w" }, IN_WORKSPACE);
        await call("memory_save", { level: "folder", title: "f", text: "f" }, IN_WORKSPACE);

        expect((await call("memory_list", {}, IN_WORKSPACE)).value.map((row: { title: string }) => row.title).sort()).toEqual(["f", "g", "w"]);
        expect((await call("memory_list", {}, ELSEWHERE)).value.map((row: { title: string }) => row.title)).toEqual(["g"]);
        expect((await call("memory_list", {}, NOWHERE)).value.map((row: { title: string }) => row.title)).toEqual(["g"]);
        expect((await call("memory_list", { level: "folder" }, IN_WORKSPACE)).value.map((row: { title: string }) => row.title)).toEqual(["f"]);

        // Another session cannot read, change or delete what is not its own.
        for (const [tool, args] of [["memory_read", { id: 2 }], ["memory_save", { id: 2, title: "x", text: "x" }], ["memory_delete", { id: 3 }]] as const) {

            const refused = await call(tool, args, ELSEWHERE);

            expect(refused.isError).toBe(true);
            expect(refused.text).toContain("There is no memory");
        }

        expect((await call("memory_read", { id: 2 }, IN_WORKSPACE)).value).toEqual({ id: 2, level: "workspace", where: "workspace Login bug", title: "w", text: "w", savedBy: "an agent" });
    });

    it("searches the session's own memories", async () => {

        const { call } = setUp();

        await call("memory_save", { level: "global", title: "Commit style", text: "Short messages." }, IN_WORKSPACE);
        await call("memory_save", { level: "workspace", title: "Cause", text: "A commit broke the token." }, IN_WORKSPACE);

        expect((await call("memory_search", { query: "commit" }, IN_WORKSPACE)).value).toHaveLength(2);
        expect((await call("memory_search", { query: "commit" }, ELSEWHERE)).value).toHaveLength(1);
        expect((await call("memory_search", {}, IN_WORKSPACE)).isError).toBe(true);
    });

    it("changes a memory by id and keeps its level", async () => {

        const { call, store, notes } = setUp();

        await call("memory_save", { level: "workspace", title: "Cause", text: "Unknown." }, IN_WORKSPACE);

        const changed = await call("memory_save", { id: 1, level: "global", title: "Cause", text: "The token expires." }, IN_WORKSPACE);

        expect(changed.value).toEqual({ saved: { id: 1, level: "workspace", where: "workspace Login bug", title: "Cause" } });
        expect(store.all()).toHaveLength(1);
        expect(store.get(1)).toMatchObject({ level: "workspace", owner: "ws-1", text: "The token expires.", author: "ai" });
        expect(notes[1]).toBe("Memory changed (workspace Login bug): Cause");
    });

    it("deletes a memory and says so", async () => {

        const { call, store, notes } = setUp();

        await call("memory_save", { level: "global", title: "Old", text: "Old." }, NOWHERE);

        expect((await call("memory_delete", { id: 1 }, NOWHERE)).value).toEqual({ deleted: 1 });
        expect(store.all()).toEqual([]);
        expect(notes[1]).toBe("Memory deleted (global): Old");
        expect((await call("memory_delete", { id: 1 }, NOWHERE)).isError).toBe(true);
    });

    it("refuses a save it cannot place, or with a bad title or text", async () => {

        const { call, store } = setUp();
        const both: SessionPlace = { folders: [API_FOLDER, WEB_FOLDER] };

        expect((await call("memory_save", { title: "t", text: "x" }, IN_WORKSPACE)).text).toContain("Give level");
        expect((await call("memory_save", { level: "team", title: "t", text: "x" }, IN_WORKSPACE)).isError).toBe(true);
        expect((await call("memory_save", { level: "workspace", title: "t", text: "x" }, NOWHERE)).text).toContain("no workspace");
        expect((await call("memory_save", { level: "folder", title: "t", text: "x" }, NOWHERE)).text).toContain("no folder");
        expect((await call("memory_save", { level: "folder", title: "t", text: "x" }, both)).text).toContain("several folders");
        expect((await call("memory_save", { level: "folder", folder: temporaryFolder(), title: "t", text: "x" }, both)).text).toContain("not one of this session's folders");
        expect((await call("memory_save", { level: "global", title: "two\nlines", text: "x" }, NOWHERE)).isError).toBe(true);
        expect((await call("memory_save", { level: "global", title: "t", text: "x".repeat(TEXT_LIMIT + 1) }, NOWHERE)).isError).toBe(true);
        expect((await call("memory_save", { level: "global", title: "t" }, NOWHERE)).isError).toBe(true);
        expect((await call("memory_read", { id: "one" }, NOWHERE)).isError).toBe(true);

        expect(store.all()).toEqual([]);
    });

    it("puts a folder memory in the folder named when the session has several", async () => {

        const { call, store } = setUp();
        const both: SessionPlace = { folders: [API_FOLDER, WEB_FOLDER] };

        expect((await call("memory_save", { level: "folder", folder: WEB_FOLDER, title: "t", text: "x" }, both)).isError).toBeUndefined();
        expect(store.get(1)).toMatchObject({ owner: folderKey(WEB_FOLDER), place: WEB_FOLDER });
    });

    it("asks first when the person chose that, and changes nothing on a no", async () => {

        const { call, store, asked, notes, answers } = setUp({ ...WRITE, askOnSave: true });

        answers.allow = false;

        const refused = await call("memory_save", { level: "global", title: "Tabs", text: "Use tabs." }, NOWHERE);

        expect(refused).toMatchObject({ isError: true, text: "The person said no. Nothing was changed." });
        expect(store.all()).toEqual([]);
        expect(asked).toEqual([{ connector: "memory", tool: "memory_save", text: "Save a global memory:\nTabs\nUse tabs." }]);

        answers.allow = true;

        expect((await call("memory_save", { level: "global", title: "Tabs", text: "Use tabs." }, NOWHERE)).isError).toBeUndefined();
        expect((await call("memory_save", { id: 1, title: "Tabs", text: "Use spaces." }, NOWHERE)).isError).toBeUndefined();
        expect((await call("memory_delete", { id: 1 }, NOWHERE)).isError).toBeUndefined();

        expect(asked.map(question => question.tool)).toEqual(["memory_save", "memory_save", "memory_save", "memory_delete"]);
        expect(asked[2]!.text).toContain("Change the global memory \"Tabs\"");
        expect(asked[3]!.text).toContain("Delete the global memory \"Tabs\"");

        // Asked, so no notice on top.
        expect(notes).toEqual([]);

        // A read never asks.
        await call("memory_list", {}, NOWHERE);

        expect(asked).toHaveLength(4);
    });

    it("refuses a tool the choices do not allow, even when it is called", async () => {

        const { call, store, state } = setUp({ ...WRITE, access: "read" });

        const refused = await call("memory_save", { level: "global", title: "t", text: "x" }, NOWHERE);

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("memory_save is not allowed");
        expect(store.all()).toEqual([]);
        expect((await call("memory_list", {}, NOWHERE)).value).toEqual([]);

        state.choices = { ...WRITE, access: "off" };

        expect((await call("memory_list", {}, NOWHERE)).isError).toBe(true);
        expect((await call("memory_nope", {}, NOWHERE)).isError).toBe(true);
    });
});

describe("what a new session is told about memory", () => {

    it("is nothing when memory is off", () => {

        const { memory } = setUp({ ...WRITE, access: "off" });

        expect(memory.instructions(IN_WORKSPACE)).toBeUndefined();
    });

    it("names the tools, how to save, and the titles the session can use", async () => {

        const { memory, call } = setUp();

        expect(memory.instructions(NOWHERE)).toContain("Nothing is saved yet.");

        await call("memory_save", { level: "global", title: "Tabs", text: "Use tabs." }, IN_WORKSPACE);
        await call("memory_save", { level: "workspace", title: "Cause", text: "The token expires." }, IN_WORKSPACE);
        await call("memory_save", { level: "workspace", title: "Other", text: "Other." }, ELSEWHERE);

        const told = memory.instructions(IN_WORKSPACE)!;

        expect(told).toContain("memory_list, memory_search, memory_read, memory_save, memory_delete");
        expect(told).toContain("- Use this memory, not a memory feature of your own.");
        expect(told).toContain("save it with memory_save");
        expect(told).toContain("- 1 (global) Tabs");
        expect(told).toContain("- 2 (workspace Login bug) Cause");
        expect(told).not.toContain("Other");

        // The text itself is not told - only the title.
        expect(told).not.toContain("The token expires.");
    });

    it("says read only, and names no save tool, when the agent may not change it", async () => {

        const { memory, state, call } = setUp();

        await call("memory_save", { level: "global", title: "Tabs", text: "Use tabs." }, NOWHERE);

        state.choices = { ...WRITE, access: "read" };

        const told = memory.instructions(NOWHERE)!;

        expect(told).toContain("You may read the memory. You may not change it.");
        expect(told).not.toContain("memory_save");
        expect(told).toContain("- 1 (global) Tabs");
    });

    it("tells sixty titles at most, and says how many more there are", () => {

        const { memory, store } = setUp();

        for (let count = 1; count <= 63; count++)
            store.add({ level: "global", owner: "", place: "", title: `Fact ${count}`, text: "x", author: "ai" }, count);

        const told = memory.instructions(NOWHERE)!;

        expect(told.split("\n").filter(line => /^- \d+ \(global\)/.test(line))).toHaveLength(60);
        expect(told).toContain("- 63 (global) Fact 63");
        expect(told).not.toContain("Fact 3\n");
        expect(told).toContain("and 3 more - find them with memory_search.");
    });
});

describe("the >memory rows", () => {

    it("offers memory at the first level only when it is on and matches", () => {

        const { memory, state } = setUp();

        expect(memory.rootRow("")).toEqual([{ name: "memory", detail: "Saved memories" }]);
        expect(memory.rootRow("MEM")).toHaveLength(1);
        expect(memory.rootRow("ado")).toEqual([]);

        state.choices = { ...WRITE, access: "off" };

        expect(memory.rootRow("")).toEqual([]);
        expect(memory.search([], "", NOWHERE)).toEqual([{ name: "off", detail: expect.stringContaining("Memory is off"), disabled: true }]);
    });

    it("lists the three levels, and greys the ones the session has not got", async () => {

        const { memory, call } = setUp();

        await call("memory_save", { level: "workspace", title: "Cause", text: "x" }, IN_WORKSPACE);

        expect(memory.search([], "", IN_WORKSPACE)).toEqual([
            { name: "global", detail: "Every session - 0 saved" },
            { name: "workspace", detail: "Login bug - 1 saved" },
            { name: "folder", detail: "This session's folders - 0 saved" }
        ]);

        expect(memory.search([], "", NOWHERE)).toEqual([
            { name: "global", detail: "Every session - 0 saved" },
            { name: "workspace", detail: "This session is in no workspace.", disabled: true },
            { name: "folder", detail: "This session has no folder.", disabled: true }
        ]);

        expect(memory.search([], "fol", IN_WORKSPACE).map(row => row.name)).toEqual(["folder"]);
    });

    it("lists a level's memories by id, found by id or title", async () => {

        const { memory, call } = setUp();

        await call("memory_save", { level: "global", title: "Tabs", text: "x" }, IN_WORKSPACE);
        await call("memory_save", { level: "global", title: "Commits", text: "x" }, IN_WORKSPACE);
        await call("memory_save", { level: "workspace", title: "Cause", text: "x" }, IN_WORKSPACE);

        expect(memory.search(["global"], "", IN_WORKSPACE)).toEqual([
            { name: "2", detail: "Commits", leaf: true },
            { name: "1", detail: "Tabs", leaf: true }
        ]);

        expect(memory.search(["GLOBAL"], "tab", IN_WORKSPACE)).toEqual([{ name: "1", detail: "Tabs", leaf: true }]);
        expect(memory.search(["global"], "2", IN_WORKSPACE)).toEqual([{ name: "2", detail: "Commits", leaf: true }]);
        expect(memory.search(["workspace"], "", ELSEWHERE)).toEqual([{ name: "none", detail: "Nothing saved here yet.", disabled: true }]);
        expect(memory.search(["global"], "zzz", IN_WORKSPACE)).toEqual([{ name: "none", detail: "No memory matches.", disabled: true }]);
        expect(memory.search(["team"], "", IN_WORKSPACE)).toEqual([]);
        expect(memory.search(["global", "1"], "", IN_WORKSPACE)).toEqual([]);
    });

    it("names the folder on each row when the session has several", async () => {

        const { memory, call } = setUp();
        const both: SessionPlace = { folders: [API_FOLDER, WEB_FOLDER] };

        await call("memory_save", { level: "folder", folder: WEB_FOLDER, title: "Build", text: "x" }, both);

        expect(memory.search(["folder"], "", both)).toEqual([{ name: "1", detail: "eesha-memory-web - Build", leaf: true }]);
    });

    it("turns a picked path into the memory's lines, only for a session that can use it", async () => {

        const { memory, call, state } = setUp();

        await call("memory_save", { level: "workspace", title: "Cause", text: "The token expires.\nAfter an hour." }, IN_WORKSPACE);

        expect(memory.reference(["workspace", "1"], IN_WORKSPACE)).toEqual({ line: "Memory 1 (workspace Login bug) - Cause:\nThe token expires.\nAfter an hour." });
        expect(memory.reference(["Workspace", "1"], IN_WORKSPACE)).toHaveProperty("line");

        expect(memory.reference(["workspace", "1"], ELSEWHERE)).toEqual({ problem: "no workspace memory 1 for this session" });
        expect(memory.reference(["global", "1"], IN_WORKSPACE)).toEqual({ problem: "no global memory 1 for this session" });
        expect(memory.reference(["workspace"], IN_WORKSPACE)).toEqual({ problem: "write it as >memory>global>12" });
        expect(memory.reference(["workspace", "one"], IN_WORKSPACE)).toHaveProperty("problem");

        state.choices = { ...WRITE, access: "off" };

        expect(memory.reference(["workspace", "1"], IN_WORKSPACE)).toEqual({ problem: "memory is off" });
    });
});

describe("the Memory page", () => {

    const workspaces = (folder: string): Workspace[] => [
        { name: "Login bug", id: "ws-1", folders: [folder] },
        { name: "Old work", id: "ws-old", folders: [folder], archived: true }
    ];

    it("groups every memory: Global first, then each workspace, then each folder", () => {

        const { memory, store } = setUp();
        const here = temporaryFolder();
        const gone = path.join(here, "moved-away");

        store.add({ level: "folder", owner: folderKey(here), place: here, title: "f", text: "f", author: "ai" });
        store.add({ level: "folder", owner: folderKey(gone), place: gone, title: "lost", text: "x", author: "ai" });
        store.add({ level: "workspace", owner: "ws-1", place: "", title: "w", text: "w", author: "person" });
        store.add({ level: "workspace", owner: "ws-old", place: "", title: "old", text: "x", author: "ai" });
        store.add({ level: "workspace", owner: "ws-deleted", place: "", title: "orphan", text: "x", author: "ai" });

        const view = memory.view(workspaces(here), [here, gone]);

        expect(view.choices).toEqual(WRITE);

        expect(view.groups.map(group => [group.level, group.label, group.missing, group.memories.map(row => row.title)])).toEqual([
            ["global", "Global", undefined, []],
            ["workspace", "ws-deleted", "gone", ["orphan"]],
            ["workspace", "Old work", "archived", ["old"]],
            ["workspace", "Login bug", undefined, ["w"]],
            ["folder", gone, "gone", ["lost"]],
            ["folder", here, undefined, ["f"]]
        ]);

        // Only a workspace that is not archived is offered for a new memory.
        expect(view.workspaces).toEqual([{ key: "ws-1", name: "Login bug" }]);

        // Each folder once.
        expect(view.folders).toEqual([here, gone]);
    });

    it("adds a memory the person wrote, at each level", () => {

        const { memory, store } = setUp();
        const here = temporaryFolder();
        const all = workspaces(here);

        expect(memory.save({ level: "global", title: "Tabs", text: "Use tabs." }, all)).toEqual({ ok: true });
        expect(memory.save({ level: "workspace", owner: "ws-1", title: "Cause", text: "x" }, all)).toEqual({ ok: true });
        expect(memory.save({ level: "folder", owner: here, title: "Build", text: "x" }, all)).toEqual({ ok: true });

        expect(store.get(1)).toMatchObject({ level: "global", owner: "", author: "person" });
        expect(store.get(2)).toMatchObject({ level: "workspace", owner: "ws-1", author: "person" });
        expect(store.get(3)).toMatchObject({ level: "folder", owner: folderKey(here), place: path.resolve(here), author: "person" });
    });

    it("refuses a memory with no title, no text, no level, or nowhere to belong", () => {

        const { memory, store } = setUp();
        const all = workspaces(temporaryFolder());

        for (const edit of [
            { level: "global", title: "", text: "x" },
            { level: "global", title: "t", text: "" },
            { level: "team", title: "t", text: "x" },
            { level: "workspace", title: "t", text: "x" },
            { level: "workspace", owner: "ws-unknown", title: "t", text: "x" },
            { level: "folder", title: "t", text: "x" },
            { level: "folder", owner: "relative/path", title: "t", text: "x" },
            { id: 99, level: "global", title: "t", text: "x" },
            undefined
        ])
            expect(memory.save(edit, all)).toHaveProperty("problem");

        expect(store.all()).toEqual([]);
    });

    it("changes a memory's text and moves it to another level, keeping who wrote it", () => {

        const { memory, store } = setUp();
        const here = temporaryFolder();
        const all = workspaces(here);

        store.add({ level: "global", owner: "", place: "", title: "Cause", text: "Unknown.", author: "ai" });

        expect(memory.save({ id: 1, level: "workspace", owner: "ws-1", title: "Cause", text: "The token expires." }, all)).toEqual({ ok: true });
        expect(store.get(1)).toMatchObject({ level: "workspace", owner: "ws-1", place: "", text: "The token expires.", author: "ai" });

        expect(memory.save({ id: 1, level: "folder", owner: here, title: "Cause", text: "The token expires." }, all)).toEqual({ ok: true });
        expect(store.get(1)).toMatchObject({ level: "folder", owner: folderKey(here), place: path.resolve(here) });

        expect(memory.save({ id: 1, level: "global", title: "Cause", text: "The token expires." }, all)).toEqual({ ok: true });
        expect(store.get(1)).toMatchObject({ level: "global", owner: "", place: "" });
        expect(store.all()).toHaveLength(1);
    });

    it("lets a memory stay in a workspace that is archived or gone, but not move into one", () => {

        const { memory, store } = setUp();
        const all = workspaces(temporaryFolder());

        store.add({ level: "workspace", owner: "ws-deleted", place: "", title: "orphan", text: "x", author: "ai" });
        store.add({ level: "global", owner: "", place: "", title: "g", text: "x", author: "ai" });

        expect(memory.save({ id: 1, level: "workspace", owner: "ws-deleted", title: "orphan", text: "y" }, all)).toEqual({ ok: true });
        expect(store.get(1)).toMatchObject({ owner: "ws-deleted", text: "y" });

        expect(memory.save({ id: 2, level: "workspace", owner: "ws-deleted", title: "g", text: "x" }, all)).toHaveProperty("problem");
        expect(store.get(2)).toMatchObject({ level: "global" });
    });

    it("deletes a memory, and says when it was already gone", () => {

        const { memory, store } = setUp();

        store.add({ level: "global", owner: "", place: "", title: "g", text: "x", author: "ai" });

        expect(memory.remove(1)).toEqual({ ok: true });
        expect(memory.remove(1)).toHaveProperty("problem");
        expect(memory.remove("1")).toHaveProperty("problem");
    });

    it("gives a moved folder's memories to the folder it is now", () => {

        const { memory, store } = setUp();
        const before = path.join(temporaryFolder(), "old-name");
        const after = temporaryFolder();

        store.add({ level: "folder", owner: folderKey(before), place: before, title: "Build", text: "x", author: "ai" });

        expect(memory.repoint(folderKey(before), path.join(after, "not-there"))).toHaveProperty("problem");
        expect(memory.repoint(folderKey(before), "relative")).toHaveProperty("problem");
        expect(memory.repoint("", after)).toHaveProperty("problem");
        expect(memory.repoint("no-such-folder", after)).toHaveProperty("problem");

        expect(memory.repoint(folderKey(before), after)).toEqual({ ok: true });
        expect(store.get(1)).toMatchObject({ owner: folderKey(after), place: path.resolve(after) });

        // A session in the new folder gets it; one in the old folder does not.
        expect(store.list(scopesOf({ folders: [after] }))).toHaveLength(1);
        expect(store.list(scopesOf({ folders: [before] }))).toHaveLength(0);
    });
});

describe("Claude's own memory", () => {

    const on: MemoryChoices = { access: "write", askOnSave: false, claudeMemoryOff: false };

    it("holds a Claude session until Claude's memory is turned off", () => {

        expect(claudeWaits("claude", on)).toBe(true);
        expect(() => memoryEnv("claude", on)).toThrow(CLAUDE_MEMORY_HELD);

        expect(claudeWaits("claude", { ...on, access: "read" })).toBe(true);
    });

    it("treats Claude run as an ACP agent the same way", () => {

        expect(claudeWaits("claude-cli", on)).toBe(true);
        expect(() => memoryEnv("claude-cli", on)).toThrow(CLAUDE_MEMORY_HELD);

        const agreed = { ...on, claudeMemoryOff: true };

        expect(claudeWaits("claude-cli", agreed)).toBe(false);
        expect(memoryEnv("claude-cli", agreed)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });

        expect(memoryEnv("claude-cli", { ...on, access: "off" })).toEqual({});
    });

    it("turns Claude's memory off for the session once the person agreed", () => {

        const agreed = { ...on, claudeMemoryOff: true };

        expect(claudeWaits("claude", agreed)).toBe(false);
        expect(memoryEnv("claude", agreed)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    });

    it("leaves Claude alone while Eesha Code's memory is off", () => {

        const off = { ...on, access: "off" as const };

        expect(claudeWaits("claude", off)).toBe(false);
        expect(memoryEnv("claude", off)).toEqual({});
        expect(memoryEnv("claude", { ...off, claudeMemoryOff: true })).toEqual({});
    });

    it("never holds or changes another runtime", () => {

        for (const runtime of ["kiro-cli", "ghcp", "copilot-cli", "gemini-cli"]) {

            expect(claudeWaits(runtime, on)).toBe(false);
            expect(memoryEnv(runtime, on)).toEqual({});
        }
    });
});
