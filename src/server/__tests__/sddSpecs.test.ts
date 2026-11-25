// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessions } from "../../core/agent";
import { AnswerBook } from "../../core/agent/permissions";
import { resetLogSink, setLogSinks } from "../../core/logging/logger";
import { HISTORY_SUBDIR } from "../../core/loader/constants";
import { profilePath } from "../../core/loader/profilePaths";
import { workspaceFolderName } from "../../core/store/databaseLocation";
import { readAiPick, writeAiPick } from "../../chat/aiChoice";
import { prefixedStore, SDD_PROFILE_PREFIX, sddStorePrefix } from "../ServerSddHost";
import type { Connectors } from "../connectors/Connectors";
import { Memory } from "../memory/Memory";
import { MemoryStore } from "../memory/memoryStore";
import { FileStore } from "../fileStore";
import { type PromptRequest, type ToPage, type Workspace, workspaceKey } from "../protocol";
import { specEventsPath } from "../../core/events/eventFile";
import { snapshot, writeNotes } from "../../sdd/panel/reviewStore";
import { placeOf, type SddServer, SddSpecs } from "../sddSpecs";
import { NO_WORKSPACE_SPECS, specCommand, specPathReference, specPathRows } from "../sddPaths";
import { archiveWorkspace, removeWorkspace, saveWorkspace } from "../workspaces";

/*
 * No phase calls an agent here. A test that runs one ends it by hand -
 * see `phaseEnds`. Every other test never starts a phase.
 */
const phase = vi.hoisted(() => ({
    end: undefined as undefined | ((outcome: { success: boolean; written: string[]; missing: string[] }) => void),

    /** What the last phase was started with - its request and the rest. */
    input: undefined as undefined | { request: { prompt: string; stage: { id: string } } }
}));

vi.mock("../../sdd/phase/runPhase", async () => ({
    ...await vi.importActual<object>("../../sdd/phase/runPhase"),
    runPhase: (input: typeof phase.input) => new Promise(resolve => { phase.input = input; phase.end = resolve; })
}));

/** Ends the phase the test started, as a finished one. */
function phaseEnds(): void {

    phase.end?.({ success: true, written: [], missing: [] });
    phase.end = undefined;
}

/*
 * The SDD module on the server: listing a workspace's specs, New spec, and a spec shown in
 * one tab at a time. The controller itself is tested in
 * src/sdd/panel/__tests__; no phase is started here, so no AI runs.
 */

const resources = path.resolve(__dirname, "..", "..", "..", "resources");

const folders: string[] = [];

function temporaryFolder(): string {

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-sdd-"));

    folders.push(folder);

    return folder;
}

/** A server with no HTTP: it writes down what went to which tab. */
function fakeServer() {

    const sent: { view?: string; message: ToPage }[] = [];
    const asked: { view: string; prompt: PromptRequest }[] = [];
    let chats = 0;

    const server: SddServer = {
        store: new FileStore(path.join(temporaryFolder(), "state.json")),
        sessions: new AgentSessions(),
        answers: new AnswerBook(path.join(temporaryFolder(), "permissions.json")),
        workerPath: "unused",
        resources,
        connectors: { connected: () => false } as unknown as Connectors,

        // Off: these tests are about other things.
        memory: new Memory({ store: new MemoryStore(":memory:"), readChoices: () => ({ access: "off", askOnSave: false, claudeMemoryOff: false }) }),
        cliPath: "unused",
        pluginNonce: "test-nonce",
        pluginDatabase: () => undefined,

        // A phase chat that runs nothing: `runPhase` is replaced here.
        newPhaseChat: async () => `chat-${++chats}`,
        phaseChat: chatId => ({ chatId, working: false, held: () => undefined, runOwned: async () => ({ success: true }), stop: () => undefined }),
        resumeChanged: () => undefined,

        toTab: (view, message) => { sent.push({ view, message }); },
        toAll: message => { sent.push({ message }); },
        askTab: async (view, prompt) => {

            asked.push({ view, prompt });

            return undefined;
        }
    };

    return { server, sent, asked };
}

let server: SddServer;
let sent: { view?: string; message: ToPage }[];
let asked: { view: string; prompt: PromptRequest }[];
let specs: SddSpecs;
let main: string;
let workspace: Workspace;

beforeEach(async () => {

    ({ server, sent, asked } = fakeServer());

    specs = new SddSpecs(server);
    main = temporaryFolder();
    workspace = { name: "Billing", folders: [main] };

    await saveWorkspace(server.store, workspace);

    // Quiet: a refused spec is logged as well as answered.
    setLogSinks({ emit: () => undefined, flush: () => Promise.resolve() });
});

afterEach(() => {

    specs.close();
    resetLogSink();

    for (const folder of folders.splice(0))
        fs.rmSync(folder, { recursive: true, force: true });
});

/** The built-in style's first spec type, as the New spec window offers it. */
async function firstType(): Promise<{ styleId: string; specTypeId: string }> {

    const offers = await specs.offers(placeOf(workspace));

    expect(offers.types.length).toBeGreaterThan(0);

    return { styleId: offers.types[0]!.styleId, specTypeId: offers.types[0]!.specTypeId };
}

function ideaOf(name: string): string | undefined {

    const found = findFile(main, path.join(name, "idea.md"));

    return found ? fs.readFileSync(found, "utf8") : undefined;
}

/** The first file under `folder` whose path ends in `tail`. */
function findFile(folder: string, tail: string): string | undefined {

    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {

        const full = path.join(folder, entry.name);

        if (entry.isDirectory()) {

            const found = findFile(full, tail);

            if (found)
                return found;

        } else if (full.endsWith(tail))
            return full;
    }

    return undefined;
}

describe("a workspace's specs", () => {

    it("finds the workspace by its key, and nothing for a key that is not saved (no SDD without a workspace)", () => {

        expect(specs.placeAt(workspaceKey(workspace))).toEqual({ key: workspaceKey(workspace), mainFolder: main, folders: [main] });
        expect(specs.placeAt("no-such-workspace")).toBeUndefined();
        expect(specs.placeAt(undefined)).toBeUndefined();
        expect(specs.placeAt(42)).toBeUndefined();
    });

    it("lists nothing in an empty SDD folder, with no note - the panel says so itself", async () => {

        expect(await specs.list(placeOf(workspace))).toEqual({ specs: [], notes: [], sort: "alpha" });
    });

    it("offers the built-in style's kinds, the four sources, and no taken names", async () => {

        const offers = await specs.offers(placeOf(workspace));

        expect(offers.types.map(one => one.label).length).toBeGreaterThan(0);
        expect(offers.sources.map(one => one.id)).toEqual(["manual", "ado", "gh", "file"]);
        expect(offers.taken).toEqual([]);
        expect(offers.broken).toEqual([]);
    });
});

describe("New spec", () => {

    it("writes idea.md with the one-line ask, lists the spec, and tells every tab - no AI, no phase started", async () => {

        const type = await firstType();

        const made = await specs.create({ workspace: workspaceKey(workspace), ...type, source: "manual", name: " mask-secrets ", text: "Mask secrets in the logs." });

        expect(made).toEqual({ name: "mask-secrets" });
        expect(ideaOf("mask-secrets")).toContain("Mask secrets in the logs.");
        expect(sent).toContainEqual({ message: { type: "eesha.specsChanged" } });

        const listed = await specs.list(placeOf(workspace));

        expect(listed.specs).toHaveLength(1);
        expect(listed.specs[0]).toMatchObject({ name: "mask-secrets", style: type.styleId, done: 1, working: false, waiting: false });
        expect(listed.specs[0]!.total).toBeGreaterThan(0);
        // idea is done; the first drafting phase waits for Next.
        expect(listed.specs[0]!.phase).toBe("requirements");

        // The name is taken now.
        expect((await specs.offers(placeOf(workspace))).taken).toContain("mask-secrets");
    });

    it("records an ADO work item and a GitHub issue by number or link", async () => {

        const type = await firstType();

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "ado", name: "item", text: "48213" })).toEqual({ name: "item" });
        expect(ideaOf("item")).toContain("48213");

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "gh", name: "issue", text: "https://github.com/o/r/issues/412" })).toEqual({ name: "issue" });
        expect(ideaOf("issue")).toContain("https://github.com/o/r/issues/412");
    });

    it("copies files with the ask into the spec folder", async () => {

        const type = await firstType();
        const ask = path.join(temporaryFolder(), "ask.md");

        fs.writeFileSync(ask, "# The ask\n\nFrom a file.\n", "utf8");

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "file", name: "from-file", files: [ask] })).toEqual({ name: "from-file" });
        expect(findFile(main, path.join("from-file", "ask.md"))).toBeDefined();
    });

    it("refuses a bad or taken name, a missing kind or source, an empty work item, and files that are not there", async () => {

        const type = await firstType();
        const key = workspaceKey(workspace);

        expect(await specs.create({ workspace: key, ...type, source: "manual", name: "" })).toEqual({ problem: "A spec needs a name." });
        expect(await specs.create({ workspace: key, ...type, source: "manual", name: "has space" })).toHaveProperty("problem");
        expect(await specs.create({ workspace: key, ...type, source: "manual", name: "../out" })).toHaveProperty("problem");

        expect(await specs.create({ workspace: key, ...type, source: "manual", name: "one" })).toEqual({ name: "one" });
        expect(await specs.create({ workspace: key, ...type, source: "manual", name: "one" })).toEqual({ problem: "A spec folder named 'one' already exists." });

        expect(await specs.create({ workspace: key, styleId: "nope", specTypeId: type.specTypeId, source: "manual", name: "two" })).toEqual({ problem: "Pick what kind of spec this is." });
        expect(await specs.create({ workspace: key, ...type, source: "fax", name: "two" })).toEqual({ problem: "Pick where the spec starts from." });
        expect(await specs.create({ workspace: key, ...type, source: "ado", name: "two", text: " " })).toEqual({ problem: "Type the work item id, or paste its link." });
        expect(await specs.create({ workspace: key, ...type, source: "gh", name: "two" })).toEqual({ problem: "Type the issue number, or paste its link." });
        expect(await specs.create({ workspace: key, ...type, source: "file", name: "two", files: [] })).toHaveProperty("problem");
        expect(await specs.create({ workspace: key, ...type, source: "file", name: "two", files: ["relative.md"] })).toEqual({ problem: "Not a full path: relative.md" });
        expect(await specs.create({ workspace: key, ...type, source: "file", name: "two", files: [path.join(main, "missing.md")] })).toHaveProperty("problem");

        // Nothing of "two" was written.
        expect(ideaOf("two")).toBeUndefined();
    });

    it("offers Kiro and Spec Kit, and Spec Kit only once the folder is set up for it", async () => {

        const offers = await specs.offers(placeOf(workspace));

        expect(offers.native.map(one => one.id)).toEqual(["kiro", "speckit"]);
        expect(offers.native[0]!.problem).toBeUndefined();
        expect(offers.native[0]!.root).toBe(path.join(main, ".kiro", "specs"));
        expect(offers.native[1]!.problem).toMatch(/specify init/);

        fs.mkdirSync(path.join(main, ".specify"));

        expect((await specs.offers(placeOf(workspace))).native[1]!.problem).toBeUndefined();
    });

    it("makes an empty Kiro spec, and starts Requirements with the description when the spec opens", async () => {

        const key = workspaceKey(workspace);

        expect(await specs.create({ workspace: key, styleId: "kiro", specTypeId: "", source: "manual", name: "rate-limits", text: " " }))
            .toEqual({ problem: "Say what the spec is about - it is sent with the first command." });

        expect(await specs.create({ workspace: key, styleId: "kiro", specTypeId: "", source: "manual", name: "rate-limits", text: "Limit failed logins." }))
            .toEqual({ name: "rate-limits" });

        expect(fs.readdirSync(path.join(main, ".kiro", "specs", "rate-limits"))).toEqual([]);
        expect((await specs.list(placeOf(workspace))).specs.map(one => [one.name, one.phase])).toEqual([["rate-limits", "requirements"]]);

        expect(await specs.open("tab-1", placeOf(workspace), "rate-limits")).toEqual({ ok: true });

        // The phase starts after the spec is read from disk, which takes
        // more than the default second when the whole suite runs at once.
        await vi.waitFor(() => expect(phase.input).toBeDefined(), { timeout: 10_000 });

        expect(phase.input!.request.stage.id).toBe("requirements");
        expect(phase.input!.request.prompt).toMatch(/^Start a new spec called "rate-limits"\./);
        expect(phase.input!.request.prompt).toContain("\n\nLimit failed logins.");

        phaseEnds();
        phase.input = undefined;
    });

    it("hands Spec Kit's first command to a new chat, since Spec Kit names the folder itself", async () => {

        const key = workspaceKey(workspace);
        const ask = { workspace: key, styleId: "speckit", specTypeId: "", source: "manual", name: "", text: "A login page." };

        expect(await specs.create(ask)).toEqual({ problem: "Spec Kit is not set up in this folder. Run 'specify init --here' in it first." });

        fs.mkdirSync(path.join(main, ".specify"));

        expect(await specs.create(ask)).toEqual({ chat: { folder: main, workspace: key, text: "/speckit.specify A login page." } });
        expect(fs.existsSync(path.join(main, "specs"))).toBe(false);
    });

    it("refuses a spec with no workspace", async () => {

        const type = await firstType();

        expect(await specs.create({ workspace: "no-such-workspace", ...type, source: "manual", name: "lost" })).toEqual({ problem: "That workspace is not here any more. Reload the page." });
        expect(await specs.create({ ...type, source: "manual", name: "lost" })).toHaveProperty("problem");
        expect(ideaOf("lost")).toBeUndefined();
    });
});

describe("the order of the list, and Clear spec history", () => {

    it("lists A to Z, or most recently changed first once the workspace asks, keeps that, and tells every tab", async () => {

        const type = await firstType();

        for (const name of ["alpha-spec", "zeta-spec"])
            await specs.create({ workspace: workspaceKey(workspace), ...type, source: "manual", name, text: "Something." });

        // alpha-spec was changed long ago.
        const folder = path.dirname(findFile(main, path.join("alpha-spec", "idea.md"))!);
        const old = new Date("2020-01-01T00:00:00Z");

        for (const entry of [folder, ...fs.readdirSync(folder).map(name => path.join(folder, name))])
            fs.utimesSync(entry, old, old);

        const names = async () => (await specs.list(placeOf(workspace))).specs.map(row => row.name);

        expect(await names()).toEqual(["alpha-spec", "zeta-spec"]);

        sent.length = 0;
        await specs.setSort(placeOf(workspace), "recent");

        expect(sent).toContainEqual({ message: { type: "eesha.specsChanged" } });
        expect((await specs.list(placeOf(workspace))).sort).toBe("recent");
        expect(await names()).toEqual(["zeta-spec", "alpha-spec"]);

        // Kept per workspace, under the name the Specs view uses.
        expect(server.store.get(sddStorePrefix(workspaceKey(workspace)) + "specSort")).toBe("recent");
    });

    it("throws away the main folder's spec history and says how many files went", () => {

        const history = profilePath(HISTORY_SUBDIR, workspaceFolderName(main), "some-spec");

        fs.mkdirSync(history, { recursive: true });
        fs.writeFileSync(path.join(history, "design.md"), "old");
        fs.writeFileSync(path.join(history, "tasks.md"), "old");

        expect(specs.clearHistory(placeOf(workspace))).toBe(2);
        expect(fs.existsSync(history)).toBe(false);
        expect(specs.clearHistory(placeOf(workspace))).toBe(0);
    });
});

describe("Copy a style", () => {

    it("offers the built-in style with its files and a free name, and the workspace first", async () => {

        const offers = await specs.copyOffers(placeOf(workspace));

        expect(offers.styles.map(one => one.id)).toEqual(["custom", "kiro", "speckit"]);
        expect(offers.styles[0].suggested).toBe("custom-1");
        expect(offers.styles[0].files).toContain("style.yml");
        expect(offers.places.map(one => one.id)).toEqual(["workspace", "profile"]);
        expect(offers.places[0].folder).toBe(path.join(main, ".eesha", "styles"));
    });

    it("copies it into the workspace under the name typed, and tells every tab", async () => {

        const done = await specs.copyStyle({ workspace: workspaceKey(workspace), styleId: "custom", place: "workspace", name: "team-flow" });

        expect("text" in done && done.text).toContain("'team-flow'");
        expect(fs.readFileSync(path.join(main, ".eesha", "styles", "team-flow", "style.yml"), "utf8")).toMatch(/^id: team-flow$/m);
        expect(sent.some(one => one.message.type === "eesha.specsChanged")).toBe(true);
    });

    it("refuses a taken or bad name, an unknown style or place, and a workspace that is gone", async () => {

        const key = workspaceKey(workspace);

        expect(await specs.copyStyle({ workspace: key, styleId: "custom", place: "workspace", name: "custom" })).toEqual({ problem: "A style named 'custom' already exists." });
        expect(await specs.copyStyle({ workspace: key, styleId: "custom", place: "workspace", name: "" })).toEqual({ problem: "The new style needs a name." });
        expect(await specs.copyStyle({ workspace: key, styleId: "nope", place: "workspace", name: "x" })).toEqual({ problem: "Pick the built-in style to copy." });
        expect(await specs.copyStyle({ workspace: key, styleId: "custom", name: "x" })).toEqual({ problem: "Pick where the copy goes." });
        expect(await specs.copyStyle({ workspace: "gone", styleId: "custom", place: "workspace", name: "x" })).toEqual({ problem: "That workspace is not here any more. Reload the page." });
        expect(fs.existsSync(path.join(main, ".eesha", "styles"))).toBe(false);
    });
});

describe("a spec shown in a tab", () => {

    async function made(name = "shown"): Promise<void> {

        expect(await specs.create({ workspace: workspaceKey(workspace), ...await firstType(), source: "manual", name, text: "Show it." })).toEqual({ name });
    }

    it("opens in a tab and sends that tab the spec, and passes the tab's messages to it", async () => {

        await made();

        expect(await specs.open("tab-1", placeOf(workspace), "shown")).toEqual({ ok: true });
        expect(specs.shownIn("tab-1")).toEqual({ place: placeOf(workspace), spec: "shown" });

        const drawn = sent.filter(one => one.view === "tab-1" && one.message.type === "eesha.sdd");

        expect(drawn.length).toBeGreaterThan(0);
        expect(drawn.some(one => (one.message as { message: { type: string } }).message.type === "spec")).toBe(true);

        expect(specs.receive("tab-1", { type: "ready" } as never)).toBe(true);
        expect(specs.receive("tab-2", { type: "ready" } as never)).toBe(false);
    });

    it("says the agent waits only to pages showing this workspace's specs, never as a plain notice to every tab", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        const [entry] = (specs as unknown as { entries: Set<{ controller: { host: { announceAsk(where: string): void } } }> }).entries;

        sent.length = 0;
        entry.controller.host.announceAsk("Design");

        expect(sent.filter(one => one.message.type !== "eesha.specsChanged")).toEqual([{ message: { type: "eesha.sddNote", workspace: workspaceKey(workspace), text: "The agent in Design is waiting for an answer." } }]);
    });

    /** The entry the server holds for a spec, and its private `posted` - what the controller's page line calls. */
    function held(): { entry: object; posted(message: object): void } {

        const inner = specs as unknown as { entries: Set<object>; posted(entry: object, message: object): void };
        const [entry] = inner.entries;

        return { entry, posted: message => inner.posted(entry, message) };
    }

    it("says a phase was cut off when Eesha Code stopped while it ran, once, on the next open", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        held().posted({ type: "busy", stageId: "design" });

        // Eesha Code is killed mid-phase (nothing is closed); a new one
        // starts over the same store.
        const killed = specs;

        specs = new SddSpecs(server);
        sent.length = 0;

        await specs.open("tab-1", placeOf(workspace), "shown");

        expect(sent.filter(one => one.message.type === "eesha.note")).toEqual([
            { view: "tab-1", message: { type: "eesha.note", text: "The phase 'Design' was cut off when Eesha Code stopped while it ran. Its document may be half written - run it again." } }
        ]);

        // Said once.
        specs.close();
        specs = new SddSpecs(server);
        sent.length = 0;

        await specs.open("tab-1", placeOf(workspace), "shown");

        expect(sent.filter(one => one.message.type === "eesha.note")).toEqual([]);

        killed.close();
    });

    it("says nothing was cut off when the phase ended before Eesha Code stopped", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        held().posted({ type: "busy", stageId: "design" });
        held().posted({ type: "busy" });

        specs.close();
        specs = new SddSpecs(server);
        sent.length = 0;

        await specs.open("tab-1", placeOf(workspace), "shown");

        expect(sent.filter(one => one.message.type === "eesha.note")).toEqual([]);
    });

    it("tells every tab's list only when the spec's row moved, not on every redraw", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        const changed = () => sent.filter(one => one.message.type === "eesha.specsChanged").length;

        // Every row read, kept, so the test waits for the reads to
        // finish rather than for a fixed time - a slow machine can take
        // longer than any fixed wait.
        const inner = specs as unknown as { readRow(entry: object): Promise<void> };
        const realRead = inner.readRow.bind(specs);
        const reads: Promise<void>[] = [];

        inner.readRow = entry => {

            const read = realRead(entry);

            reads.push(read);

            return read;
        };

        // Past the burst's quiet time, then every read it started.
        const settle = async () => {

            await new Promise(resolve => setTimeout(resolve, 400));
            await Promise.all(reads.splice(0));
        };

        // Opening drew it, so its row is read already - by a read that
        // may have started before the reads above were kept, on a slow
        // machine. Waited for by its result.
        await settle();
        await vi.waitFor(() => expect((held().entry as { row?: string }).row).toBeDefined(), { timeout: 10_000 });
        await settle();

        // A burst of redraws with the row unchanged: nothing.
        sent.length = 0;

        for (let i = 0; i < 5; i++)
            held().posted({ type: "spec", spec: { stages: [] } });

        await settle();

        expect(changed()).toBe(0);

        // The row moved since it was last read: told once for the burst.
        (held().entry as { row?: string }).row = "an older row";
        sent.length = 0;

        for (let i = 0; i < 5; i++)
            held().posted({ type: "spec", spec: { stages: [] } });

        await settle();

        expect(changed()).toBe(1);
    });

    it("refuses a spec that is not in the SDD folder", async () => {

        expect(await specs.open("tab-1", placeOf(workspace), "missing")).toHaveProperty("problem");
        expect(specs.shownIn("tab-1")).toBeUndefined();
    });

    it("moves to the newest tab that opens it, and tells the old one which spec went - not that its chat did", async () => {

        await made();

        await specs.open("tab-1", placeOf(workspace), "shown");
        await specs.open("tab-2", placeOf(workspace), "shown");

        expect(sent).toContainEqual({ view: "tab-1", message: { type: "eesha.specMoved", workspace: placeOf(workspace).key, spec: "shown" } });
        expect(sent).not.toContainEqual({ view: "tab-1", message: { type: "eesha.moved" } });
        expect(specs.shownIn("tab-1")).toBeUndefined();
        expect(specs.shownIn("tab-2")?.spec).toBe("shown");
        expect(specs.receive("tab-1", { type: "ready" } as never)).toBe(false);
    });

    it("lets go of an idle spec when its tab goes", async () => {

        await made();

        await specs.open("tab-1", placeOf(workspace), "shown");

        specs.tabGone("tab-1");

        expect(specs.shownIn("tab-1")).toBeUndefined();
        expect(specs.working).toBe(0);
        expect(specs.receive("tab-1", { type: "ready" } as never)).toBe(false);
    });

    it("asks a connector write in the tab showing the spec, by the id its connector tools are started with", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        const id = specs.idOf(placeOf(workspace), "shown");

        expect(id).toMatch(/^sdd-\d+-shown$/);
        expect(specs.viewOf(id!)).toBe("tab-1");

        // A chat's id, or a spec no tab shows, finds no tab.
        expect(specs.viewOf("2026-11-15T10-00-00-abcd")).toBeUndefined();

        specs.tabGone("tab-1");

        expect(specs.viewOf(id!)).toBeUndefined();
        expect(asked).toEqual([]);
    });

    /*
     * The id is the spec's held copy, not its name: once that copy is
     * let go, a connector call still carrying the old id must not reach
     * the tab that opens the spec again - that tab's tools have a new id.
     */
    it("gives a spec opened again a new connector id, and the old id reaches no tab", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        const old = specs.idOf(placeOf(workspace), "shown")!;

        specs.tabGone("tab-1");

        expect(specs.idOf(placeOf(workspace), "shown")).toBeUndefined();

        await specs.open("tab-2", placeOf(workspace), "shown");

        const fresh = specs.idOf(placeOf(workspace), "shown");

        expect(fresh).toMatch(/^sdd-\d+-shown$/);
        expect(fresh).not.toBe(old);
        expect(specs.viewOf(fresh!)).toBe("tab-2");
        expect(specs.viewOf(old)).toBeUndefined();
    });

    /*
     * One spec's save can change another's row (a shared steering file,
     * a moved folder), so a redraw asked by one spec redraws every spec
     * of the workspace that a tab shows - each in its own tab.
     */
    it("redraws two specs of one workspace at once, each in its own tab", async () => {

        await made("first");
        await made("second");
        await specs.open("tab-1", placeOf(workspace), "first");
        await specs.open("tab-2", placeOf(workspace), "second");

        sent.length = 0;

        const [one] = (specs as unknown as { entries: Set<{ controller: { host: { redrawAll(): Promise<void> } } }> }).entries;

        await one.controller.host.redrawAll();

        const drawnIn = (view: string) => sent.filter(item =>
            item.view === view && item.message.type === "eesha.sdd" && (item.message as { message: { type: string; spec?: { name: string } } }).message.type === "spec");

        expect(drawnIn("tab-1").map(item => (item.message as { message: { spec: { name: string } } }).message.spec.name)).toEqual(["first"]);
        expect(drawnIn("tab-2").map(item => (item.message as { message: { spec: { name: string } } }).message.spec.name)).toEqual(["second"]);
    });

    /*
     * A tab closed while its phase runs: the phase keeps running and the
     * spec stays held (and counted as working). When the phase ends,
     * nobody is looking, so the spec is let go - and it is not said to
     * be cut off on the next open, because it ended.
     */
    it("lets go of a spec whose phase ends after its tab closed, and does not call it cut off", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), "shown");

        expect(specs.receive("tab-1", { type: "run", stageId: "requirements", revise: false })).toBe(true);

        await vi.waitFor(() => expect(phase.end).toBeDefined());

        specs.tabGone("tab-1");

        expect(specs.working).toBe(1);
        expect(specs.idOf(placeOf(workspace), "shown")).toBeDefined();

        sent.length = 0;
        phaseEnds();

        await vi.waitFor(() => expect(specs.working).toBe(0));

        expect(specs.idOf(placeOf(workspace), "shown")).toBeUndefined();
        expect(sent.some(item => item.message.type === "eesha.specsChanged")).toBe(true);

        sent.length = 0;
        await specs.open("tab-2", placeOf(workspace), "shown");

        expect(sent.filter(item => item.message.type === "eesha.note")).toEqual([]);
    });
});

describe("SDD and the chats are kept apart", () => {

    it("keeps SDD's saved values under their own keys, so a chat's pick never changes SDD's", async () => {

        const key = workspaceKey(workspace);
        const sdd = prefixedStore(server.store, sddStorePrefix(key));

        await writeAiPick(sdd, { provider: "claude", model: "opus" });

        // What a chat writes, with the chat's own store: the same names with no prefix.
        await writeAiPick(server.store, { provider: "copilot" });

        expect(readAiPick(sdd)).toEqual({ provider: "claude", model: "opus" });
        expect(readAiPick(server.store)).toEqual({ provider: "copilot" });
        expect(sddStorePrefix(key)).not.toBe(SDD_PROFILE_PREFIX);
    });

    it("takes a tab's messages to a spec only when that tab shows the spec - a chat's tab reaches no spec", async () => {

        await made();

        expect(specs.receive("chat-tab", { type: "advance" } as never)).toBe(false);
    });

    async function made(): Promise<void> {

        expect(await specs.create({ workspace: workspaceKey(workspace), ...await firstType(), source: "manual", name: "apart" })).toEqual({ name: "apart" });
    }
});

describe("what a spec's page may read and save", () => {

    /** What the controller sent the tab about this file, once it has. */
    async function documentSent(file: string): Promise<string> {

        let content: string | undefined;

        await vi.waitFor(() => {

            const found = sent
                .map(one => one.message.type === "eesha.sdd" ? (one.message as { message: { type: string; path?: string; content?: string } }).message : undefined)
                .filter(one => one?.type === "document" && one.path === file)
                .pop();

            expect(found).toBeDefined();
            content = found!.content;
        });

        return content!;
    }

    let idea: string;
    let secret: string;

    beforeEach(async () => {

        await specs.create({ workspace: workspaceKey(workspace), ...await firstType(), source: "manual", name: "guarded", text: "Guard the files." });

        idea = findFile(main, path.join("guarded", "idea.md"))!;
        secret = path.join(temporaryFolder(), "secret.txt");
        fs.writeFileSync(secret, "do not show", "utf8");

        await specs.open("tab-1", placeOf(workspace), "guarded");
    });

    it("reads a file of the spec", async () => {

        specs.receive("tab-1", { type: "requestDocument", path: idea });

        expect(await documentSent(idea)).toContain("Guard the files.");
    });

    it("answers a file outside the workspace as missing", async () => {

        specs.receive("tab-1", { type: "requestDocument", path: secret });

        expect(await documentSent(secret)).toBe("");
    });

    it("saves a file of the spec", async () => {

        specs.receive("tab-1", { type: "saveDocument", path: idea, content: "# Changed" });

        await vi.waitFor(() => expect(fs.readFileSync(idea, "utf8")).toBe("# Changed"));
    });

    it("refuses to save a file outside the workspace, and says so", async () => {

        specs.receive("tab-1", { type: "saveDocument", path: secret, content: "overwritten" });

        await vi.waitFor(() => expect(sent.some(one => one.message.type === "eesha.note" && String((one.message as { text: string }).text).includes("Not saved"))).toBe(true));

        expect(fs.readFileSync(secret, "utf8")).toBe("do not show");
    });
});

describe("specs of workspaces that share a main folder - one per work item", () => {

    it("lists this workspace's own specs first, then the ones made in another workspace on the folder", async () => {

        const type = await firstType();
        const second: Workspace = { id: `${workspaceKey(workspace)}::b`, name: "13 Logout", folders: [main], created: 2 };

        await saveWorkspace(server.store, second);

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "manual", name: "b-login" })).toEqual({ name: "b-login" });
        expect(await specs.create({ workspace: workspaceKey(second), ...type, source: "manual", name: "a-logout" })).toEqual({ name: "a-logout" });

        const firstList = (await specs.list(placeOf(workspace))).specs;

        expect(firstList.map(row => [row.name, row.elsewhere])).toEqual([["b-login", undefined], ["a-logout", true]]);

        const secondList = (await specs.list(placeOf(second))).specs;

        expect(secondList.map(row => [row.name, row.elsewhere])).toEqual([["a-logout", undefined], ["b-login", true]]);
    });

    it("gives a spec it did not make - one with no recorded workspace, or one made by someone else - to the folder's first workspace", async () => {

        const type = await firstType();
        const second: Workspace = { id: `${workspaceKey(workspace)}::b`, name: "13 Logout", folders: [main], created: 2 };

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "manual", name: "old" })).toEqual({ name: "old" });

        // As if it had never been noted down.
        await server.store.update("eesha.specWorkspaces", undefined);
        await saveWorkspace(server.store, second);

        expect((await specs.list(placeOf(workspace))).specs[0]?.elsewhere).toBeUndefined();
        expect((await specs.list(placeOf(second))).specs[0]?.elsewhere).toBe(true);
    });

    it("gives the specs of a workspace taken off the list back to the folder's first workspace", async () => {

        const type = await firstType();
        const second: Workspace = { id: `${workspaceKey(workspace)}::b`, name: "13 Logout", folders: [main], created: 2 };

        await saveWorkspace(server.store, second);

        expect(await specs.create({ workspace: workspaceKey(second), ...type, source: "manual", name: "gone" })).toEqual({ name: "gone" });

        await removeWorkspace(server.store, workspaceKey(second));

        expect((await specs.list(placeOf(workspace))).specs[0]?.elsewhere).toBeUndefined();
    });
});

describe("the Spec explorer", () => {

    it("lists every folder of the workspace, each spec's kind, where it is kept, and its phases", async () => {

        const other = temporaryFolder();
        const both: Workspace = { id: "two-folders", name: "Two folders", folders: [main, other], created: 3 };

        await saveWorkspace(server.store, both);

        const key = workspaceKey(both);
        const type = await firstType();

        expect(await specs.create({ workspace: key, ...type, source: "manual", name: "login", text: "Add a login page." })).toEqual({ name: "login" });
        expect(await specs.create({ workspace: key, styleId: "kiro", specTypeId: "", source: "manual", name: "rate-limits", text: "Limit failed logins." })).toEqual({ name: "rate-limits" });

        // A spec in the second folder: New spec on that folder.
        expect(await specs.create({ workspace: key, folder: other, ...type, source: "manual", name: "export", text: "Export to CSV." })).toEqual({ name: "export" });

        const view = await specs.explorer(placeOf(both));

        expect(view.folders.map(one => [one.folder, one.main])).toEqual([[main, true], [other, false]]);

        const [first, second] = view.folders;

        expect(first!.specs.map(one => [one.name, one.native, one.root])).toEqual([
            ["login", undefined, ".eesha/specs"],
            ["rate-limits", "kiro", ".kiro/specs"]
        ]);
        expect(second!.specs.map(one => one.name)).toEqual(["export"]);
        expect(fs.existsSync(path.join(other, ".eesha", "specs", "export", "idea.md"))).toBe(true);

        const login = first!.specs[0]!;

        expect(login.phases[0]).toEqual({ id: "idea", label: login.phases[0]!.label, status: "done", chatless: true });
        expect(login.phases.find(one => one.status === "next")?.id).toBe("requirements");

        const kiro = first!.specs[1]!;

        expect(kiro.phases.map(one => one.id)).toEqual(["requirements", "design", "tasks", "implement"]);
        expect(kiro.phases.some(one => one.chatless)).toBe(false);
    });

    it("archives a spec by hand, in its own folder only, keeps it, and tells every tab", async () => {

        const other = temporaryFolder();
        const both: Workspace = { id: "archive-two", name: "Archive two", folders: [main, other], created: 4 };

        await saveWorkspace(server.store, both);

        const key = workspaceKey(both);
        const type = await firstType();

        // One name in both folders: archiving one leaves the other.
        await specs.create({ workspace: key, ...type, source: "manual", name: "login", text: "Add a login page." });
        await specs.create({ workspace: key, folder: other, ...type, source: "manual", name: "login", text: "Add a login page there." });

        sent.length = 0;
        await specs.setArchived(placeOf(both), "login", true);

        expect(sent).toContainEqual({ message: { type: "eesha.specsChanged" } });

        const archived = async () => (await specs.explorer(placeOf(both))).folders.map(folder => folder.specs.find(one => one.name === "login")?.archived);

        expect(await archived()).toEqual([true, undefined]);
        expect((await specs.list(placeOf(both))).specs.find(one => one.name === "login")?.archived).toBe(true);

        // Its folder stays.
        expect(findFile(main, path.join("login", "idea.md"))).toBeDefined();

        await specs.setArchived(placeOf(both), "login", false);

        expect(await archived()).toEqual([undefined, undefined]);
    });

    it("refuses a folder that is not the workspace's", async () => {

        expect(specs.placeAt(workspaceKey(workspace), temporaryFolder())).toBeUndefined();
        expect(specs.placeAt(workspaceKey(workspace), main)?.mainFolder).toBe(main);

        expect(await specs.create({ workspace: workspaceKey(workspace), folder: temporaryFolder(), styleId: "kiro", specTypeId: "", source: "manual", name: "x", text: "y" }))
            .toEqual({ problem: "That folder is not in this workspace any more. Reload the page." });
    });

    it("lists a spec's sessions from its history, and leaves out the implementation phase's own notes", () => {

        const file = specEventsPath(main, "login");

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, [
            { kind: "session", ownerId: "requirements", sessionId: "s1", model: "sonnet", at: 1 },
            { kind: "end", ownerId: "requirements", status: "success", at: 2 },
            { kind: "restart", ownerId: "requirements", at: 3 },
            { kind: "start", ownerId: "requirements", text: "Shorter, please", at: 4 },
            { kind: "session", ownerId: "requirements", sessionId: "s2", at: 5 },
            { ownerId: "implement", stream: "stdout", text: "Already working.", at: 6 },
            { kind: "session", ownerId: "implement@wave:1", sessionId: "s3", at: 7 }
        ].map(one => JSON.stringify(one)).join("\n") + "\n");

        expect(specs.sessions(placeOf(workspace), "login")).toEqual([
            { ownerId: "requirements", iteration: 1, current: false, at: 1, model: "sonnet", status: "success" },
            { ownerId: "requirements", iteration: 2, current: true, at: 4, note: "Shorter, please" },
            { ownerId: "implement@wave:1", iteration: 1, current: true, at: 7 }
        ]);

        expect(specs.sessions(placeOf(workspace), "no-history")).toEqual([]);
    });
});

describe("the start page's recent specs", () => {

    /** Sets when a spec last changed: its folder and every file in it, as the list reads it. */
    function changedAt(folder: string, name: string, seconds: number): void {

        const spec = path.join(folder, ".eesha", "specs", name);

        for (const target of [spec, ...fs.readdirSync(spec).map(one => path.join(spec, one))])
            fs.utimesSync(target, seconds, seconds);
    }

    it("lists the newest specs of every workspace not archived, each once, under the workspace that made it", async () => {

        const type = await firstType();
        const other = temporaryFolder();
        const second: Workspace = { id: `${workspaceKey(workspace)}::b`, name: "13 Logout", folders: [main, other], created: 2 };
        const shelved: Workspace = { id: "shelved", name: "Shelved", folders: [temporaryFolder()], created: 3 };

        await saveWorkspace(server.store, second);
        await saveWorkspace(server.store, shelved);

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "manual", name: "login" })).toEqual({ name: "login" });
        expect(await specs.create({ workspace: workspaceKey(second), ...type, source: "manual", name: "logout" })).toEqual({ name: "logout" });
        expect(await specs.create({ workspace: workspaceKey(second), folder: other, ...type, source: "manual", name: "export" })).toEqual({ name: "export" });
        expect(await specs.create({ workspace: "shelved", ...type, source: "manual", name: "hidden" })).toEqual({ name: "hidden" });

        await archiveWorkspace(server.store, "shelved", true);

        changedAt(main, "login", 1000);
        changedAt(main, "logout", 3000);
        changedAt(other, "export", 2000);

        const all = (await specs.recent(10)).specs;

        // Two workspaces share the main folder: each spec shows once, not twice.
        expect(all.map(row => [row.name, row.workspace, row.folder])).toEqual([
            ["logout", workspaceKey(second), undefined],
            ["export", workspaceKey(second), other],
            ["login", workspaceKey(workspace), undefined]
        ]);
        expect(all[0]).toMatchObject({ working: false, waiting: false, modified: 3_000_000 });

        expect((await specs.recent(2)).specs.map(row => row.name)).toEqual(["logout", "export"]);
    });

    it("leaves out a folder that cannot be read and still lists the rest", async () => {

        const type = await firstType();
        const lost: Workspace = { id: "lost", name: "Lost", folders: [path.join(temporaryFolder(), "not-there")], created: 2 };

        await saveWorkspace(server.store, lost);

        expect(await specs.create({ workspace: workspaceKey(workspace), ...type, source: "manual", name: "login" })).toEqual({ name: "login" });

        expect((await specs.recent(5)).specs.map(row => row.name)).toEqual(["login"]);
    });
});

describe("the widget over a phase chat", () => {

    const NAME = "refund-limit";

    /** A Feature spec: Idea, Requirements, Design, Tasks, Implementation. Answers its folder. */
    async function made(): Promise<string> {

        expect(await specs.create({ workspace: workspaceKey(workspace), ...await firstType(), source: "manual", name: NAME, text: "Hold big refunds." })).toEqual({ name: NAME });

        return path.dirname(findFile(main, path.join(NAME, "idea.md"))!);
    }

    it("lists the spec's phases and the one to start next, and says nothing of a document not written yet", async () => {

        await made();

        const view = await specs.widget(placeOf(workspace), NAME, "requirements");

        expect(view!.spec).toBe(NAME);
        expect(view!.phases.map(one => [one.id, one.status])).toEqual([
            ["idea", "done"], ["requirements", "next"], ["design", "upcoming"], ["tasks", "upcoming"], ["implement", "upcoming"]
        ]);
        expect(view!.phases[0]!.chatless).toBe(true);
        expect(view!.next).toEqual({ id: "requirements", label: "Requirements" });
        expect(view!.doc).toBeUndefined();
        expect([view!.working, view!.waiting]).toEqual([false, false]);

        // Reading it holds no spec open.
        expect(specs.idOf(placeOf(workspace), NAME)).toBeUndefined();

        expect(await specs.widget(placeOf(workspace), "not-there")).toBeUndefined();
    });

    it("counts the blocks the last turn changed and the open notes of the chat's own document", async () => {

        const folder = await made();
        const doc = path.join(folder, "requirements.md");

        fs.writeFileSync(doc, "# Requirements\n\nA refund above the limit is held.\n");

        // No copy was put aside: nothing to compare, so no count at all.
        expect((await specs.widget(placeOf(workspace), NAME, "requirements"))!.doc).toEqual({ phase: "requirements", file: "requirements.md", notes: 0 });

        snapshot(folder, main, doc);
        fs.writeFileSync(doc, "# Requirements\n\nA refund above the limit is held.\n\nA manager approves it.\n");

        writeNotes(folder, main, [
            { id: "n1", artifact: doc, line: 3, anchorText: "A refund above the limit is held.", body: "Say who sets the limit.", createdAt: "2026-11-25T10:00:00Z" },
            { id: "n2", artifact: doc, line: 5, anchorText: "A manager approves it.", body: "Done already.", createdAt: "2026-11-25T10:01:00Z", resolved: true },
            { id: "n3", artifact: path.join(folder, "design.md"), line: 1, anchorText: "Design", body: "On another document.", createdAt: "2026-11-25T10:02:00Z" }
        ]);

        const view = (await specs.widget(placeOf(workspace), NAME, "requirements"))!;

        expect(view.doc).toMatchObject({ phase: "requirements", file: "requirements.md", changed: 1, notes: 1 });
        expect(view.doc!.notesText).toContain("1 review note was left on this document.");
        expect(view.doc!.notesText).toContain("Say who sets the limit.");
        expect(view.doc!.notesText).not.toContain("Done already.");

        // The document is written, so the next phase is Design.
        expect(view.next).toEqual({ id: "design", label: "Design" });

        // A wave chat's phase has no document of its own.
        expect((await specs.widget(placeOf(workspace), NAME, "implement@wave:2"))!.doc).toBeUndefined();
    });

    it("says why the next phase cannot start while a document before it has an open question", async () => {

        const folder = await made();

        fs.writeFileSync(path.join(folder, "requirements.md"), "# Requirements\n\nText.\n\n## Open Questions\n\n- **QN-1** One refund, or all refunds in a day?\n");

        const next = (await specs.widget(placeOf(workspace), NAME, "requirements"))!.next!;

        expect(next.id).toBe("design");
        expect(next.blocked).toMatch(/^Answer the open questions in requirements\.md \(QN-1\) first/);

        expect(await specs.start(placeOf(workspace), NAME, "design")).toEqual({ problem: next.blocked });

        // Refused with no tab: nothing is held open for it.
        expect(specs.idOf(placeOf(workspace), NAME)).toBeUndefined();
        expect(specs.working).toBe(0);
    });

    it("starts the next phase with no tab, answers its chat at once, and lets go when the phase ends", async () => {

        await made();

        expect(await specs.start(placeOf(workspace), NAME, "requirements")).toEqual({ chatId: "chat-1" });

        await vi.waitFor(() => expect(phase.end).toBeDefined(), { timeout: 10_000 });

        expect(phase.input!.request.stage.id).toBe("requirements");
        expect(sent.some(item => item.message.type === "eesha.specsChanged")).toBe(true);
        expect((await specs.widget(placeOf(workspace), NAME))!.working).toBe(true);

        // A second start while it works is refused, and stops nothing.
        expect(await specs.start(placeOf(workspace), NAME, "design"))
            .toEqual({ problem: `${NAME} is still working on requirements. Wait for it, or stop it on the spec.` });
        expect(specs.working).toBe(1);

        phaseEnds();
        phase.input = undefined;

        await vi.waitFor(() => expect(specs.working).toBe(0));

        expect(specs.idOf(placeOf(workspace), NAME)).toBeUndefined();
    });

    it("hands text typed in the spec's box to the phase's first pass", async () => {

        await made();

        expect(await specs.start(placeOf(workspace), NAME, "requirements", "Mobile login only.")).toEqual({ chatId: "chat-1" });

        await vi.waitFor(() => expect(phase.end).toBeDefined(), { timeout: 10_000 });

        expect(phase.input!.request.prompt).toContain("> Mobile login only.");

        phaseEnds();
        phase.input = undefined;

        await vi.waitFor(() => expect(specs.working).toBe(0));
    });

    it("refuses the Idea, the implementation, a phase the spec does not have, and a spec that is not there", async () => {

        await made();

        expect(await specs.start(placeOf(workspace), NAME, "idea")).toEqual({ problem: "Idea does not start from here. Open the spec to work on it." });
        expect(await specs.start(placeOf(workspace), NAME, "implement")).toEqual({ problem: "Implementation does not start from here. Open the spec to work on it." });
        expect(await specs.start(placeOf(workspace), NAME, "nope")).toEqual({ problem: `'${NAME}' has no phase 'nope'.` });
        expect(await specs.start(placeOf(workspace), "not-there", "requirements")).toEqual({ problem: `There is no spec 'not-there' in ${main}.` });

        expect(specs.idOf(placeOf(workspace), NAME)).toBeUndefined();
        expect(specs.working).toBe(0);
        expect(phase.end).toBeUndefined();
    });

    it("starts a phase of a spec a tab shows, and that tab is told the chat too", async () => {

        await made();
        await specs.open("tab-1", placeOf(workspace), NAME);

        sent.length = 0;

        expect(await specs.start(placeOf(workspace), NAME, "requirements")).toEqual({ chatId: "chat-1" });

        expect(sent.some(item => item.view === "tab-1"
            && item.message.type === "eesha.sdd"
            && (item.message as { message: { type: string; chatId?: string } }).message.type === "phaseChat"
            && (item.message as { message: { chatId?: string } }).message.chatId === "chat-1")).toBe(true);

        await vi.waitFor(() => expect(phase.end).toBeDefined(), { timeout: 10_000 });

        phaseEnds();
        phase.input = undefined;

        // Its tab still shows it, so it is kept.
        await vi.waitFor(() => expect(specs.working).toBe(0));
        expect(specs.idOf(placeOf(workspace), NAME)).toBeDefined();
    });
});

describe(">spec in a message box", () => {

    const NAME = "refund-limit";

    async function made(name = NAME): Promise<string> {

        expect(await specs.create({ workspace: workspaceKey(workspace), ...await firstType(), source: "manual", name, text: "Hold big refunds." })).toEqual({ name });

        return path.dirname(findFile(main, path.join(name, "idea.md"))!);
    }

    const rows = (below: string[], query = "") => specPathRows(specs, workspaceKey(workspace), below, query);
    const run = (action: Parameters<typeof specCommand>[3], name = NAME, phase?: string) => specCommand(specs, workspaceKey(workspace), name, action, phase);

    it("lists spec at the first level, then New spec and every spec with the phase it is at", async () => {

        await made();
        await made("login");

        expect(await rows([])).toEqual([{ name: "spec", detail: "Specs of this workspace" }]);
        expect(await rows([], "sp")).toHaveLength(1);
        expect(await rows([], "ado")).toEqual([]);

        expect((await rows(["spec"])).map(row => [row.name, row.detail, row.leaf])).toEqual([
            ["new", "Make a new spec - type what it is about after it", true],
            ["login", "at Requirements", undefined],
            [NAME, "at Requirements", undefined]
        ]);
        expect((await rows(["spec"], "refund")).map(row => row.name)).toEqual([NAME]);
    });

    it("lists a spec's written documents, then its actions - greyed with the reason when one cannot run", async () => {

        const folder = await made();

        let under = await rows(["spec", NAME]);

        // Only idea.md is written: one document, so no "all".
        expect(under.filter(row => row.hint === "document").map(row => row.name)).toEqual(["idea"]);
        expect(under.find(row => row.name === "next")).toMatchObject({ detail: "Start Requirements in a new chat", hint: "action", leaf: true });
        expect(under.find(row => row.name === "resume")).toMatchObject({ disabled: true, hint: "no phase has run yet" });
        expect(under.find(row => row.name === "notes")).toMatchObject({ disabled: true, hint: "no open notes" });
        expect(under.find(row => row.name === "changes")).toMatchObject({ disabled: true, hint: "no document written yet" });
        expect(under.some(row => row.name === "stop")).toBe(false);
        expect(under.filter(row => row.hint === "action").map(row => row.name)).toEqual(["open", "next", "plan", "watch"]);

        fs.writeFileSync(path.join(folder, "requirements.md"), "# Requirements\n\nText.\n\n## Open Questions\n\n- **QN-1** Which limit?\n");

        under = await rows(["spec", NAME]);

        expect(under.filter(row => row.hint === "document").map(row => row.name)).toEqual(["idea", "requirements", "all"]);
        expect(under.find(row => row.name === "next")).toMatchObject({ disabled: true, hint: "open questions first" });
        expect(under.find(row => row.name === "changes")!.disabled).toBeUndefined();

        expect((await rows(["spec", NAME], "req")).map(row => row.name)).toEqual(["requirements"]);
        expect(await rows(["spec", "not-there"])).toEqual([]);
    });

    it("gives the agent a document's full path, and all of them for all", async () => {

        const folder = await made();
        const key = workspaceKey(workspace);

        fs.writeFileSync(path.join(folder, "requirements.md"), "# Requirements\n");

        expect(await specPathReference(specs, key, ["spec", NAME, "requirements"]))
            .toEqual({ line: `Spec '${NAME}', Requirements: ${path.join(folder, "requirements.md")}` });

        expect((await specPathReference(specs, key, ["spec", NAME, "all"])).line!.split("\n")).toEqual([
            `Spec '${NAME}', Idea: ${path.join(folder, "idea.md")}`,
            `Spec '${NAME}', Requirements: ${path.join(folder, "requirements.md")}`
        ]);

        expect(await specPathReference(specs, key, ["spec", NAME, "design"])).toEqual({ problem: `spec '${NAME}' has no written document 'design'` });
        expect(await specPathReference(specs, key, ["spec", "nope", "design"])).toEqual({ problem: "there is no spec 'nope' in this workspace" });
        expect(await specPathReference(specs, key, ["spec", NAME, "open"])).toEqual({ problem: "an action runs only when it is the whole message" });
        expect(await specPathReference(specs, key, ["spec", NAME])).toEqual({ problem: "write it as >spec>name>design" });
    });

    it("runs open, watch, plan and changes by telling the page what to open", async () => {

        const folder = await made();

        expect(await run("watch")).toEqual({ spec: NAME });
        expect(await run("open")).toEqual({ spec: NAME, open: {} });
        expect(await run("plan")).toEqual({ spec: NAME, open: { phase: "implement" } });
        expect(await run("changes")).toEqual({ problem: `${NAME} has no written document yet.` });
        expect(await run("notes")).toEqual({ problem: `${NAME} has no written document yet.` });
        expect(await run("open", "REFUND-LIMIT")).toEqual({ spec: NAME, open: {} });
        expect(await run("open", "nope")).toEqual({ problem: "There is no spec 'nope' in this workspace." });

        const doc = path.join(folder, "requirements.md");

        fs.writeFileSync(doc, "# Requirements\n\nA refund above the limit is held.\n");

        // In a normal chat the last written document is the one meant.
        expect(await run("changes")).toEqual({ spec: NAME, open: { phase: "requirements" }, note: "The last turn changed nothing in requirements.md." });
        expect(await run("notes")).toEqual({ problem: "requirements.md has no open review notes." });

        writeNotes(folder, main, [{ id: "n1", artifact: doc, line: 3, anchorText: "A refund above the limit is held.", body: "Say who sets the limit.", createdAt: "2026-11-25T10:00:00Z" }]);

        const notes = await run("notes") as { text: string };

        expect(notes.text).toContain("Say who sets the limit.");
    });

    it("runs next by starting the phase, resume by going to its newest chat, and stop by stopping it", async () => {

        await made();

        expect(await run("resume")).toEqual({ spec: NAME, open: {}, note: `No phase of ${NAME} has run yet. Start one with >spec>${NAME}>next.` });
        expect(await run("stop")).toEqual({ problem: `Nothing of ${NAME} runs now.` });

        expect(await run("next")).toEqual({ spec: NAME, chatId: "chat-1" });

        await vi.waitFor(() => expect(phase.end).toBeDefined(), { timeout: 10_000 });

        expect(phase.input!.request.stage.id).toBe("requirements");
        expect(await run("resume")).toEqual({ spec: NAME, chatId: "chat-1" });
        expect((await rows(["spec", NAME])).find(row => row.name === "next")).toMatchObject({ disabled: true, hint: "the spec is working" });
        expect((await rows(["spec", NAME])).some(row => row.name === "stop")).toBe(true);

        expect(await run("stop")).toEqual({ spec: NAME, note: `Stopping ${NAME}.` });

        phaseEnds();
        phase.input = undefined;

        await vi.waitFor(() => expect(specs.working).toBe(0));
    });

    it("finds a spec kept in another folder of the workspace, and names that folder", async () => {

        const other = temporaryFolder();
        const both: Workspace = { id: "two", name: "Two", folders: [main, other], created: 5 };

        await saveWorkspace(server.store, both);

        expect(await specs.create({ workspace: workspaceKey(both), folder: other, ...await firstType(), source: "manual", name: "export", text: "Export." })).toEqual({ name: "export" });

        expect(await specCommand(specs, workspaceKey(both), "export", "open")).toEqual({ spec: "export", folder: other, open: {} });
        expect(await specPathRows(specs, "no-such-workspace", ["spec"], "")).toEqual([{ name: "none", detail: "This session's workspace is not here any more.", disabled: true }]);
    });

    it("says specs are only in a workspace, in a session that is in none", async () => {

        expect(await specPathRows(specs, undefined, [], "")).toEqual([{ name: "spec", detail: "Specs - only in a workspace", hint: "no workspace", disabled: true }]);
        expect(await specPathRows(specs, undefined, ["spec"], "")).toEqual([{ name: "none", detail: NO_WORKSPACE_SPECS, disabled: true }]);
        expect(NO_WORKSPACE_SPECS).toMatch(/Open the workspace/);
    });
});
