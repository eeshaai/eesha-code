import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { LogEventLevel } from "serilogger";
import { resetLogSink, setLogSinks, textOf } from "../../../core/logging/logger";
import { SddCore } from "../../SddCore";
import { EventWriter } from "../../../core/events/EventWriter";
import { specEventsPath } from "../../../core/events/eventFile";
import { baseline } from "../reviewStore";
import {
    chatsWorking, context as testContext, openSpec, ownerOf, panels, phaseChats, recorded, rememberTaskSession, reset,
    type TestContext, taskSessions, terminal, typedTurn, watchers
} from "./testPanel";

/**
 * `runPhase` itself, replaced with a controllable fake. What the panel
 * does around a run - which markers it writes, what it records, what it
 * reports on failure - does not need a real agent behind it, only a
 * result to react to. `startSession` is left real; nothing here calls
 * it.
 */
vi.mock("../../phase/runPhase", async () => {

    const actual = await vi.importActual<typeof import("../../phase/runPhase")>(
        "../../phase/runPhase");

    return { ...actual, runPhase: vi.fn() };
});

import { runPhase } from "../../phase/runPhase";

const runPhaseMock = vi.mocked(runPhase);

/**
 * The spec controller, against a real spec folder on disk, through the
 * plain test host in testPanel.ts - no server.
 *
 * They check what the controller asked the host for (a terminal's name,
 * the chat it opened) instead of what a real host did.
 *
 * Nothing here starts an agent - the phases that would are not exercised,
 * because what can go wrong is the panel answering the view: a list
 * hardcoded empty so a button never appears, a session id that arrives
 * too late to be shown, and clicks that return in silence. All three
 * are assertions in this file.
 */

let workspace: string;
let home: string;

/**
 * The home directory is moved by environment variable rather than by
 * mocking `os`: `homedir()` is documented to read `USERPROFILE` on
 * Windows and `HOME` on POSIX, and an ESM module namespace cannot be
 * spied on anyway. Both are set so the test reads the same on either.
 *
 * Needed here because a revise snapshots the document being replaced
 * into the profile - see `reviewStore.ts` - and without this a test run
 * would write those snapshots into the real user's home directory.
 */
const HOME_VARIABLES = ["HOME", "USERPROFILE"] as const;

let restoreHome: (() => void)[] = [];

/** Every error line the panel wrote to the log. */
let errors: string[];

const SPEC = "demo";

/** The repository root, so the shipped styles under `resources/` are the ones resolved. */
const resourcesPath = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * The shipped custom style with one of its stages set.
 *
 * Parsed and re-emitted rather than appended to. The shipped file
 * declares `stages:` itself, so a second block appended after it is a
 * duplicate key: YAML rejects the whole document ("Map keys must be
 * unique"), the style does not load at all, and a test about which
 * prompt a stage points at then fails with the stage *missing* rather
 * than with the wrong prompt - a fixture lying about what broke.
 *
 * Set, not added: a stage the shipped style already declares is updated
 * in place, and one it does not is appended. Either way there is one
 * `stages:` and one entry per id, which is the whole point.
 */
function styleWithStage(id: string, changes: Record<string, unknown>): string {

    const style = parse(fs.readFileSync(
        path.join(resourcesPath, "resources", "styles", "custom", "style.yml"), "utf8"));

    const stages = (style.stages ??= []) as Record<string, unknown>[];

    const stage = stages.find(one => one.id === id);

    if (stage)
        Object.assign(stage, changes);
    else
        stages.push({ id, ...changes });

    return stringify(style);
}

/**
 * The shipped style copied into the workspace as a style of its own,
 * `mine`, with `style.yml` replaced by `yaml` and settings.json enabling
 * it - what Eject Style makes. A workspace copy under the built-in's own
 * id would clash with it, and neither would load.
 */
function ownStyle(yaml: string): void {

    const from = path.join(resourcesPath, "resources", "styles", "custom");
    const to = path.join(workspace, ".eesha", "styles", "mine");

    fs.cpSync(from, to, { recursive: true });

    const style = parse(yaml);

    style.id = "mine";
    style.name = "Mine";

    fs.writeFileSync(path.join(to, "style.yml"), stringify(style), "utf8");

    write(".eesha/settings.json", JSON.stringify({ sdd: { styles: ["mine"] } }));
}

function write(relative: string, content: string): string {

    const full = path.join(workspace, ...relative.split("/"));

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");

    return full;
}

beforeEach(() => {

    reset();
    runPhaseMock.mockReset();

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-panel-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-panel-home-"));

    restoreHome = HOME_VARIABLES.map(name => {

        const previous = process.env[name];

        process.env[name] = home;

        return () => {

            if (previous === undefined)
                delete process.env[name];
            else
                process.env[name] = previous;
        };
    });

    errors = [];

    setLogSinks({
        emit: events => events
            .filter(event => event.level === LogEventLevel.error)
            .forEach(event => errors.push(textOf(event))),
        flush: () => Promise.resolve()
    });

    // The opening document, because discovery lists a folder as a spec
    // only once it has one.
    write(`.eesha/specs/${SPEC}/idea.md`, "---\ntype: feature\n---\n\n# The ask\n");

    write(`.eesha/specs/${SPEC}/requirements.md`,
        "---\ntype: feature\n---\n\n# Requirements\n\n### Requirement 1\n\nIt works.\n");
});

afterEach(() => {

    for (const panel of panels)
        panel.dispose();

    resetLogSink();

    restoreHome.forEach(restore => restore());

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
});

const context = (): TestContext => testContext();

const place = () => ({ workspace, resources: path.join(resourcesPath, "resources") });

/** Polls until the panel has done the thing, or gives up with what it saw. */
async function until<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {

    const deadline = Date.now() + timeoutMs;

    for (;;) {

        const value = read();

        if (done(value))
            return value;

        if (Date.now() > deadline)
            throw new Error(`Timed out waiting for the panel. Last seen: ${JSON.stringify(value)}`);

        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function show(ctx: TestContext) {

    const core = await SddCore.create({ workspace, resources: path.join(resourcesPath, "resources"), home: os.homedir() });

    const spec = (await core.specs()).find(candidate => candidate.name === SPEC);

    expect(spec, "the fixture spec must be discoverable, or nothing below means anything").toBeDefined();

    return openSpec(ctx, place(), spec!.name);
}

describe("what the panel writes down", () => {

    /*
     * A toast is gone when it is dismissed and the panel's own row goes
     * with the panel, so a failure that lands only there leaves nothing
     * to paste an hour later. The log is the copy that survives both.
     */
    it("logs a failure as well as showing it", async () => {

        const ctx = context();

        await show(ctx);

        // The folder goes, and the panel is asked to draw it again -
        // which is the shape of the real case, where the spec is
        // renamed or moved while its panel is open.
        fs.rmSync(path.join(workspace, ".eesha", "specs", SPEC), { recursive: true, force: true });

        await openSpec(ctx, place(), SPEC);

        expect(errors.some(line => line.includes(SPEC) && line.includes("no longer under the spec root"))).toBe(true);
    });
});

/*
 * A conversation's lines exist only in the page that received them
 * unless something writes them down, so closing the panel would lose
 * the conversation that produced a document. These tests check both
 * ends: the history comes back, and it is not written twice.
 */
describe("the conversation, after the panel is closed", () => {

    /** Lines as the view receives them, in order. */
    function drawn(panel: { sent<T>(type: string): T[] }) {

        return panel.sent<{ text: string; meta?: { kind?: string } }>("log");
    }

    function history() {

        return new EventWriter(specEventsPath(workspace, SPEC), `sdd:${SPEC}`);
    }

    it("comes back when the panel is opened again", async () => {

        history().log({ ownerId: "requirements", at: 1, stream: "stdout", text: "Recording Azure AD.", kind: "message" });

        const panel = await show(context());

        await panel.receive({ type: "ready" });

        expect(drawn(panel).map(line => line.text)).toContain("Recording Azure AD.");
    });

    it("comes back with its parts, not as flat sentences", async () => {

        history().log({
            ownerId: "requirements", at: 1, stream: "system", text: "Read done in 42ms",
            kind: "tool.end", tool: "Read", callId: "tu_01", ok: true, ms: 42
        });

        const panel = await show(context());

        await panel.receive({ type: "ready" });

        expect(drawn(panel).find(line => line.text === "Read done in 42ms")?.meta)
            .toMatchObject({ kind: "tool.end", tool: "Read", callId: "tu_01", ok: true, ms: 42 });
    });

    /*
     * A question open when the page closed has no promise behind it. It needs no marker to be drawn as history: an `ask` with
     * no `answer` beside it is an unanswered question, the same way a
     * `tool.start` with no `tool.end` is a call that never returned.
     */
    it("brings a question back without the answer nobody gave", async () => {

        history().log({
            ownerId: "requirements", at: 1, stream: "stdout", text: "Which auth?",
            kind: "ask", askId: "q1", prompt: "Which auth?"
        });

        const panel = await show(context());

        await panel.receive({ type: "ready" });

        const kinds = drawn(panel).map(line => line.meta?.kind);

        expect(kinds).toContain("ask");
        expect(kinds).not.toContain("answer");
    });

    /* Otherwise every open would write the whole history down again. */
    it("does not write down what it just read back", async () => {

        history().log({ ownerId: "requirements", at: 1, stream: "stdout", text: "once", kind: "message" });

        const panel = await show(context());

        await panel.receive({ type: "ready" });
        await panel.receive({ type: "ready" });

        expect(history().read().filter(event => event.text === "once")).toHaveLength(1);
    });

    it("shows nothing at all for a spec whose history was deleted", async () => {

        const panel = await show(context());

        await panel.receive({ type: "ready" });

        expect(drawn(panel)).toEqual([]);
    });
});

describe("what the panel tells the view", () => {

    it("sends the spec with its stages, so the stepper has something to draw", async () => {

        const panel = await show(context());

        const [message] = panel.sent<{ type: string; spec: { name: string; stages: { name: string }[] } }>("spec");

        expect(message.spec.name).toBe(SPEC);
        expect(message.spec.stages.map(stage => stage.name)).toContain("requirements");
    });

    /*
     * The panel must not post `sessions: []` unconditionally on every
     * send: the implement lens draws its Open session button off exactly
     * that list, so an empty one would never show the button, no matter
     * how many chats the panel had started.
     */
    it("sends the implementation chats it actually started, not an empty list", async () => {

        const ctx = context();

        await rememberTaskSession(ctx, SPEC, { task: "1", sessionId: "chat-7", at: 1 });

        const panel = await show(ctx);

        const [message] = panel.sent<{ type: string; sessions: { sessionId: string; kind?: string }[] }>("sessions");

        // `live` rides along with every record: this panel is not
        // holding that conversation, so its compose box stays off.
        expect(message.sessions)
            .toEqual([{ task: "1", sessionId: "chat-7", at: 1, live: false }]);
    });

    it("still sends an empty list for a spec whose chats were never here", async () => {

        const panel = await show(context());

        expect(panel.sent<{ sessions: unknown[] }>("sessions")[0].sessions).toEqual([]);
    });

    /* Without the id on the stage, the document's Open session button has nothing to render from. */
    it("carries a phase's session id on its stage, read back from the spec's own history", async () => {

        const ctx = context();

        new EventWriter(specEventsPath(workspace, SPEC), `sdd:`)
            .session("requirements", "chat-1", "claude");

        const panel = await show(ctx);

        const [message] = panel.sent<{ spec: { stages: { name: string; sessionId?: string }[] } }>("spec");

        expect(message.spec.stages.find(stage => stage.name === "requirements")?.sessionId).toBe("chat-1");
    });

    /*
     * A stage naming a `template:` runs this repository's file instead
     * of the shipped prompt. The chip has to follow it there - pointing
     * at the shipped one would show a person instructions the phase is
     * not running.
     */
    it("points at the repository's file when a stage named one, and at the shipped prompt otherwise", async () => {

        const ours = write("docs/instructions/requirements.md", "# Our requirements phase\n");

        ownStyle(styleWithStage("requirements", { instructions: "docs/instructions/requirements.md" }));

        const panel = await show(context());

        const [message] = panel.sent<{ spec: { stages: { name: string; prompt?: string }[] } }>("spec");

        expect(message.spec.stages.find(stage => stage.name === "requirements")?.prompt).toBe(ours);
        expect(message.spec.stages.find(stage => stage.name === "design")?.prompt)
            .toBe(path.join(workspace, ".eesha", "styles", "mine", "instructions", "design.md"));
    });

    it("says which documents exist, since that is what separates written from not", async () => {

        const panel = await show(context());

        const [message] = panel.sent<{ spec: { stages: { name: string; exists?: boolean }[] } }>("spec");

        const stages = message.spec.stages;

        expect(stages.find(stage => stage.name === "requirements")?.exists).toBe(true);
        expect(stages.find(stage => stage.name === "design")?.exists).toBe(false);
    });
});

describe("answering the view", () => {

    it("hands back a document's content when asked for it", async () => {

        const panel = await show(context());

        await panel.receive({ type: "requestDocument", path: path.join(workspace, ".eesha", "specs", SPEC, "requirements.md") });

        expect(panel.sent<{ content: string }>("document")[0].content).toContain("Requirement 1");
    });

    it("writes an edited document to disk and echoes it back", async () => {

        const panel = await show(context());

        const file = path.join(workspace, ".eesha", "specs", SPEC, "requirements.md");

        await panel.receive({ type: "saveDocument", path: file, content: "# Rewritten\n" });

        expect(fs.readFileSync(file, "utf8")).toBe("# Rewritten\n");
        expect(panel.sent<{ content: string }>("document").pop()!.content).toBe("# Rewritten\n");
    });

    it("opens a file through the host rather than rendering it itself", async () => {

        const panel = await show(context());

        await panel.receive({ type: "open", path: "C:/somewhere/instructions/design.md" });

        expect(recorded.opened).toEqual(["C:/somewhere/instructions/design.md"]);
    });

    it("opens the session the view asked for", async () => {

        const panel = await show(context());

        await panel.receive({ type: "openSession", sessionId: "chat-3" });

        expect(recorded.sessionsOpened).toEqual([{ sessionId: "chat-3" }]);
    });

    /*
     * Two presses of Start all is two agents handed the same list in the
     * same repository. The guard has to hold before any of the work
     * behind it resolves, which is what makes the *second* click the
     * interesting one.
     */
    it("refuses a second hand-over while one is already starting, and says why", async () => {

        const panel = await show(context());

        const tasks = [{ id: "1", text: "Do the thing" }];

        const drawn = panel.sent<unknown>("spec").length;

        const first = panel.receive({ type: "implement", tasks });
        const second = panel.receive({ type: "implement", tasks });

        await Promise.all([first, second]);

        expect(recorded.info.join("\n")).toContain("Already working - the panel takes one thing at a time");

        // The first hand-over fails (nothing answers `runPhase` here)
        // and redraws as it ends. Waited for, so its tail does not run
        // into the next test's fresh workspace.
        await until(() => panel.sent<unknown>("spec").length, count => count > drawn);
    });

    /*
     * A click that quietly does nothing is indistinguishable from a
     * broken button.
     */
    it("says something rather than nothing when there is no work left to implement", async () => {

        const panel = await show(context());

        await panel.receive({ type: "implement", tasks: [] });

        expect(recorded.info.join("\n")).toContain("Nothing to implement");
    });
});

/*
 * One chat per wave, and the engine owns the order: the next wave's
 * chat starts only when every task of the one before it is ticked on
 * disk. The agent's word is never read - only the plan.
 */
describe("implementing a plan wave by wave", () => {

    const PLAN = [
        "# Implementation Plan: demo",
        "",
        "## Tasks",
        "",
        "- [ ] 1. Parser",
        "  - [ ] 1.1 Add the parser",
        "  - [ ] 1.2 Add the walker",
        "- [ ] 2. Runner",
        "  - [ ] 2.1 Add the runner",
        "",
        "## Task Dependency Graph",
        "",
        "```json",
        '{ "waves": [ { "id": 0, "tasks": ["1.1", "1.2"] }, { "id": 1, "tasks": ["2.1"] } ] }',
        "```",
        ""
    ].join("\n");

    const HANDED = [
        { id: "1.1", text: "Add the parser", wave: 0 },
        { id: "1.2", text: "Add the walker", wave: 0 },
        { id: "2.1", text: "Add the runner", wave: 1 }
    ];

    /** Ticks these tasks in the plan on disk - what an agent does when it finishes one. */
    function tick(...ids: string[]) {

        const file = path.join(workspace, ".eesha", "specs", SPEC, "tasks.md");

        let text = fs.readFileSync(file, "utf8");

        for (const id of ids)
            text = text.replace(`- [ ] ${id} `, `- [x] ${id} `);

        fs.writeFileSync(file, text, "utf8");
    }

    /**
     * The wave chats' turns, in the order they started. A turn runs
     * until the test ends it - what a real chat's agent does when it
     * stops - so nothing here depends on how fast the panel is.
     */
    let turns: { done: boolean; end(success: boolean): void }[];

    /** Ends the n-th turn: its chat stops working and holds conversation `w<n>`. */
    const end = (n: number, success = true) => turns[n].end(success);

    /**
     * A message typed into a phase chat, as the chat code runs it - see
     * `typedTurn`. Fails the test when SDD refused it.
     */
    function typeIn(chatId: string) {

        const turn = typedTurn(SPEC, chatId);

        if (typeof turn === "string")
            throw new Error(`The message was refused: ${turn}`);

        return turn;
    }

    /** The prompt the n-th chat was started with. */
    const promptOf = (call: number) => runPhaseMock.mock.calls[call][0].request.prompt;

    /** Whether the panel last said it was busy. */
    const lastBusy = (panel: { sent<T>(type: string): T[] }) =>
        panel.sent<{ stageId?: string }>("busy").pop()?.stageId;

    /**
     * Hands the plan over and waits for the first chat to start. The
     * panel answers the message before the hand-over resolves - a click
     * is not held open - so the start is something to wait for.
     */
    async function start(panel: { receive(message: unknown): Promise<void>; sent<T>(type: string): T[] }) {

        await panel.receive({ type: "implement", tasks: HANDED });

        // Or an error, so a hand-over that failed says why instead of
        // timing out.
        const seen = await until(
            () => ({ calls: runPhaseMock.mock.calls.length, errors: [...recorded.errors], warnings: [...recorded.warnings] }),
            state => state.calls === 1 || state.errors.length > 0 || state.warnings.length > 0);

        expect(seen.errors).toEqual([]);
        expect(seen.warnings).toEqual([]);
    }

    /** Waits for the redraw the end of a chain sends, so nothing of it runs into the next test. */
    async function settled(panel: { sent<T>(type: string): T[] }) {

        await until(() => lastBusy(panel), busy => busy === undefined);
        await redrawn(panel);
    }

    /** Waits for one more `spec` message than has been sent so far. */
    async function redrawn(panel: { sent<T>(type: string): T[] }, since = panel.sent<unknown>("spec").length) {

        await until(() => panel.sent<unknown>("spec").length, count => count > since);
    }

    /** Presses Stop and waits for the redraw it causes. */
    async function stop(panel: { receive(message: unknown): Promise<void>; sent<T>(type: string): T[] }) {

        const drawn = panel.sent<unknown>("spec").length;

        await panel.receive({ type: "cancel" });
        await redrawn(panel, drawn);
    }

    /**
     * Presses Stop, then ends every turn still running - a stopped
     * chat's turn ends by itself in a real chat - and waits for the
     * redraw each end causes, so nothing of it runs into the next test.
     */
    async function stopAll(panel: { receive(message: unknown): Promise<void>; sent<T>(type: string): T[] }) {

        await stop(panel);

        for (const turn of turns)
            if (!turn.done) {

                const drawn = panel.sent<unknown>("spec").length;

                turn.end(false);

                await redrawn(panel, drawn);
            }
    }

    beforeEach(() => {

        write(`.eesha/specs/${SPEC}/design.md`, "# Design\n");
        write(`.eesha/specs/${SPEC}/tasks.md`, PLAN);

        // No wait between sessions, except in the test of that wait.
        write(".eesha/settings.json", JSON.stringify({ sdd: { nextSessionDelaySeconds: 0 } }));

        turns = [];

        runPhaseMock.mockImplementation(() => new Promise(resolve => {

            const n = turns.length;

            // The turn runs in the chat made for it just before.
            const chat = [...phaseChats.values()].pop()!;

            chat.working = true;

            const turn = {
                done: false,
                end: (success: boolean) => {

                    if (turn.done)
                        return;

                    turn.done = true;
                    chat.working = false;
                    chat.session = { sessionId: `w${n}` };

                    resolve(success
                        ? { success: true, sessionId: `w${n}`, written: [], missing: [] }
                        : { success: false, message: "The turn was stopped.", written: [], missing: [] });
                }
            };

            turns.push(turn);
        }));
    });

    it("starts the first wave only, then the next once every task of it is ticked", async () => {

        const panel = await show(context());

        await start(panel);

        expect(promptOf(0)).toContain("- 1.1 Add the parser (wave 0)\n- 1.2 Add the walker (wave 0)\n");
        expect(promptOf(0)).not.toContain("2.1");
        expect(lastBusy(panel)).toBe("implement");

        tick("1.1", "1.2");
        end(0);

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

        expect(promptOf(1)).toContain("- 2.1 Add the runner (wave 1)\n");
        expect(lastBusy(panel)).toBe("implement");

        tick("2.1");
        end(1);

        await settled(panel);

        expect(recorded.info.join("\n")).toContain("Every task handed over is ticked");
        expect(runPhaseMock).toHaveBeenCalledTimes(2);
    });

    /*
     * A wave's turn runs in its own chat, a normal session, which keeps
     * the conversation once the agent stops - so a correction is a
     * message there, not the whole wave started again.
     */
    it("runs a wave's turn in its own chat, and keeps the conversation on the chat's record", async () => {

        const ctx = context();
        const panel = await show(ctx);

        await panel.receive({ type: "implement", tasks: HANDED.slice(0, 2) });

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

        expect(runPhaseMock.mock.calls[0][0].keep).toBe(true);
        expect(runPhaseMock.mock.calls[0][0].via).toBeTypeOf("function");
        expect([...phaseChats.values()].map(chat => chat.phase)).toEqual(["implement@wave:0"]);

        tick("1.1", "1.2");
        end(0);

        await settled(panel);

        expect(taskSessions(ctx, SPEC).find(chat => chat.chatId === "chat-1")?.sessionId).toBe("w0");
    });

    /*
     * A plan with no graph is one chat: Next hands the agent every task,
     * not one at a time. Two of its tasks naming one file is no reason
     * to refuse - one agent works them one after another.
     */
    it("hands a plan with no graph to one chat, all its tasks in it", async () => {

        write(`.eesha/specs/${SPEC}/tasks.md`, PLAN
            .slice(0, PLAN.indexOf("## Task Dependency Graph"))
            .replace("  - [ ] 1.1 Add the parser\n", "  - [ ] 1.1 Add the parser\n    - Files: `src/index.ts`\n")
            .replace("  - [ ] 1.2 Add the walker\n", "  - [ ] 1.2 Add the walker\n    - Files: `src/index.ts`\n"));

        const panel = await show(context());

        await panel.receive({ type: "implement", tasks: HANDED.map(({ wave: _wave, ...task }) => task) });

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

        expect(recorded.errors).toEqual([]);
        expect(promptOf(0)).toContain("1.1 Add the parser");
        expect(promptOf(0)).toContain("1.2 Add the walker");
        expect(promptOf(0)).toContain("2.1 Add the runner");

        tick("1.1", "1.2", "2.1");
        end(0);

        await settled(panel);

        expect(runPhaseMock).toHaveBeenCalledTimes(1);
    });

    /*
     * Two agents on one file at once. The tasks phase is told not to
     * build such a wave; the engine checks anyway, before a chat opens.
     */
    it("refuses a wave whose tasks name the same file, before any chat opens", async () => {

        write(`.eesha/specs/${SPEC}/tasks.md`, PLAN
            .replace("  - [ ] 1.1 Add the parser\n", "  - [ ] 1.1 Add the parser\n    - Files: `src/parser.ts`, `src/index.ts`\n")
            .replace("  - [ ] 1.2 Add the walker\n", "  - [ ] 1.2 Add the walker\n    - Files: `src/walker.ts`, `src/index.ts`\n"));

        const panel = await show(context());

        await panel.receive({ type: "implement", tasks: HANDED });

        const seen = await until(() => [...recorded.errors], errors => errors.length > 0);

        expect(seen[0]).toContain("1.1 and 1.2 both name 'src/index.ts'");
        expect(runPhaseMock).not.toHaveBeenCalled();

        // The refusal ends the chain and redraws; waited for, so its
        // tail does not run into the next test.
        await until(() => lastBusy(panel), busy => busy === undefined);
        await redrawn(panel, 1);
    });

    it("files a wave's chat under the wave, naming every task it was handed", async () => {

        const ctx = context();
        const panel = await show(ctx);

        await start(panel);

        const working = await until(() => chatsWorking(ctx, SPEC, ["1.2"]), chats => chats.length > 0);

        expect(working.map(chat => [chat.task, chat.tasks])).toEqual([["wave:0", ["1.1", "1.2"]]]);

        await stopAll(panel);
    });

    /* An unticked box is a blocked task, and nothing later starts over it. */
    it("stops the chain when a wave ends with a task unticked, and says which", async () => {

        const panel = await show(context());

        await start(panel);

        tick("1.1");
        end(0);

        await settled(panel);

        expect(recorded.info.join("\n")).toContain("1.2 unticked");
        expect(runPhaseMock).toHaveBeenCalledTimes(1);
    });

    /*
     * A wave stopped short - a network drop, usually - and the plan
     * stopped with it. A message typed into that chat puts the plan
     * back: the chat shows as working, and once it ticks its boxes the
     * next wave starts without ▶.
     */
    it("carries the plan on after a message into the chat it stopped at", async () => {

        const ctx = context();
        const panel = await show(ctx);

        await start(panel);

        tick("1.1");
        end(0);

        await settled(panel);

        const record = () => taskSessions(ctx, SPEC).find(chat => chat.chatId === "chat-1");

        expect(recorded.info.join("\n")).toContain("Press Resume in the chat, or send it a message, and the plan carries on");
        expect(record()?.ended).toBe(true);

        // The chat is told to show Resume, and says yes when it asks.
        expect(recorded.resumeChanged).toEqual(["chat-1"]);
        expect(ownerOf(SPEC, "chat-1").resumable()).toBe(true);

        const typed = typeIn("chat-1");

        // Working again, and the plan with it. Resume goes.
        await until(() => record()?.ended, ended => ended === undefined);

        expect(lastBusy(panel)).toBe("implement");
        expect(recorded.resumeChanged).toEqual(["chat-1", "chat-1"]);
        expect(ownerOf(SPEC, "chat-1").resumable()).toBe(false);

        tick("1.2");
        await typed.end();

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

        expect(promptOf(1)).toContain("- 2.1 Add the runner (wave 1)\n");
        expect(record()?.ended).toBe(true);

        tick("2.1");
        end(1);

        await settled(panel);
    });

    /*
     * A correction after a wave that finished well: the chat shows as
     * working while its agent is on it, and the spec is busy with it so
     * no other phase starts under it. No plan was stopped, so nothing
     * starts after it.
     */
    it("marks a finished chat working while a message is being answered, and finished after", async () => {

        const ctx = context();
        const panel = await show(ctx);

        await panel.receive({ type: "implement", tasks: HANDED.slice(0, 2) });

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

        tick("1.1", "1.2");
        end(0);

        await settled(panel);

        const record = () => taskSessions(ctx, SPEC).find(chat => chat.chatId === "chat-1");

        const typed = typeIn("chat-1");

        await until(() => record()?.ended, ended => ended === undefined);

        expect(lastBusy(panel)).toBe("implement");

        const drawn = panel.sent<unknown>("spec").length;

        await typed.end();

        // The end redraws; waited for, so its tail does not run into the
        // next test.
        await redrawn(panel, drawn);

        expect(record()?.ended).toBe(true);
        expect(lastBusy(panel)).toBeUndefined();
        expect(runPhaseMock).toHaveBeenCalledTimes(1);
    });

    /*
     * A message typed into a wave chat runs on the implementation
     * phase's AI. That phase's prompt lists the tasks the chat was
     * handed, so they are read from the plan for it - without them the
     * prompt cannot be built and the message fails.
     */
    it("finds the AI and the plan for a message typed into a finished wave's chat", async () => {

        const panel = await show(context());

        await panel.receive({ type: "implement", tasks: HANDED.slice(0, 2) });

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

        tick("1.1", "1.2");
        end(0);

        await settled(panel);

        const owner = ownerOf(SPEC, "chat-1");

        expect((await owner.ai()).uses).toBeTruthy();
        expect((await owner.extras()).plan).toBe(path.join(workspace, ".eesha", "specs", SPEC, "tasks.md"));
    });

    /* A message into a wave chat is the spec's work too, so it waits while another wave works. */
    it("refuses a message into a finished wave's chat while the next wave works", async () => {

        const panel = await show(context());

        await start(panel);

        tick("1.1", "1.2");
        end(0);

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

        expect(typedTurn(SPEC, "chat-1")).toContain("Still working on implement");

        await stopAll(panel);
    });

    /* Two writers on the plan - a person revising it and an agent ticking it - is the one thing the instructions forbid. */
    it("refuses a revise of the plan while a wave's chat is open", async () => {

        const panel = await show(context());

        await start(panel);
        await panel.receive({ type: "run", stageId: "tasks", revise: true, note: "" });

        expect(recorded.info.join("\n")).toContain("Already working");
        expect(runPhaseMock).toHaveBeenCalledTimes(1);

        await stopAll(panel);
    });

    /** The last word the view had about the first wave's chat. */
    const firstChat = (panel: { sent<T>(type: string): T[] }) =>
        panel.sent<{ sessions: { chatId?: string; ended?: boolean; resumable?: boolean }[] }>("sessions")
            .pop()?.sessions.find(chat => chat.chatId === "chat-1");

    /** Hands the plan over and waits until its first chat is on record. */
    async function startOnRecord(ctx: ReturnType<typeof context>, panel: Awaited<ReturnType<typeof show>>) {

        await start(panel);

        await until(() => chatsWorking(ctx, SPEC, ["1.1"]), chats => chats.length > 0);
    }

    it("stops the open chat's turn when Stop is pressed, and starts no further wave", async () => {

        const ctx = context();
        const panel = await show(ctx);

        await startOnRecord(ctx, panel);

        await stop(panel);

        expect(phaseChats.get("chat-1")?.stopped).toBe(1);
        expect(recorded.info.join("\n")).toContain("no further wave will start");
        expect(recorded.info.join("\n")).toContain("Press Resume in the chat, or send it a message, to carry on");
        expect(lastBusy(panel)).toBeUndefined();

        // Its chat is told to show Resume.
        expect(recorded.resumeChanged).toEqual(["chat-1"]);
        expect(ownerOf(SPEC, "chat-1").resumable()).toBe(true);

        // The stopped turn ends, with the wave's boxes ticked or not -
        // and nothing follows until a message is typed into the chat.
        tick("1.1", "1.2");
        end(0, false);

        await until(() => firstChat(panel), chat => chat?.ended === true);

        expect(firstChat(panel)?.resumable).toBe(true);
        expect(runPhaseMock).toHaveBeenCalledTimes(1);
    });

    /*
     * A message typed into a stopped chat undoes the Stop: the panel is
     * busy again (Stop shows, Implement is off), and the plan carries on
     * once the chat ticks its boxes.
     */
    it("carries the plan on when a stopped chat is typed into, and Stop stops it again", async () => {

        const ctx = context();
        const panel = await show(ctx);

        await startOnRecord(ctx, panel);
        await stop(panel);

        end(0, false);

        await until(() => firstChat(panel), chat => chat?.ended === true);

        const chat = phaseChats.get("chat-1")!;
        const typed = typeIn("chat-1");

        expect(lastBusy(panel)).toBe("implement");

        await until(() => taskSessions(ctx, SPEC).find(one => one.chatId === "chat-1")?.ended, ended => ended === undefined);

        // Stop again: the turn is stopped again, and the chat can carry
        // the plan on again.
        const stopped = chat.stopped;

        await stop(panel);

        expect(chat.stopped).toBeGreaterThan(stopped);
        expect(lastBusy(panel)).toBeUndefined();

        await typed.end(false);

        await until(() => firstChat(panel), one => one?.ended === true && one.resumable === true);

        const again = typeIn("chat-1");

        expect(lastBusy(panel)).toBe("implement");

        // The wave is done: the next one starts by itself.
        tick("1.1", "1.2");
        await again.end();

        await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

        expect(promptOf(1)).toContain("- 2.1 Add the runner (wave 1)\n");

        tick("2.1");
        end(1);

        await settled(panel);
    });

    /* Between two sessions the next one waits, so Stop can still keep it from starting. */
    it("waits before the next session, and Stop during the wait keeps it from starting", async () => {

        // Not given, so the default of 10 holds.
        write(".eesha/settings.json", JSON.stringify({ sdd: {} }));

        const panel = await show(context());

        await start(panel);

        tick("1.1", "1.2");
        end(0);

        const waiting = await until(
            () => panel.sent<{ nextStartsIn?: number }>("lanes").pop()?.nextStartsIn,
            seconds => seconds !== undefined);

        expect(waiting).toBe(10);
        expect(recorded.info.join("\n")).toContain("Next session (2.1) starts in 10 seconds");
        expect(runPhaseMock).toHaveBeenCalledTimes(1);

        await stop(panel);

        expect(recorded.info.join("\n")).toContain("no further wave will start");
        expect(lastBusy(panel)).toBeUndefined();
        expect(panel.sent<{ nextStartsIn?: number }>("lanes").pop()?.nextStartsIn).toBeUndefined();
        expect(runPhaseMock).toHaveBeenCalledTimes(1);
    });

    it("starts no new session after the current one when Stop after current session is on", async () => {

        const panel = await show(context());

        await start(panel);

        await panel.receive({ type: "stopAfterCurrent", on: true });

        expect(panel.sent<{ stopAfterCurrent?: boolean }>("lanes").pop()?.stopAfterCurrent).toBe(true);

        tick("1.1", "1.2");
        end(0);

        await settled(panel);

        expect(recorded.info.join("\n")).toContain("Stopped after the current session - 2.1 did not start");
        expect(runPhaseMock).toHaveBeenCalledTimes(1);

        // Off again once the run is over, so the next run is not stopped by it.
        expect(panel.sent<{ stopAfterCurrent?: boolean }>("lanes").pop()?.stopAfterCurrent).toBe(false);
    });

    /*
     * The plan's order is a hard rule: one wave at a time, and nothing
     * starts while a task before it is unticked - different
     * repositories or not, because a later wave builds on the code the
     * earlier ones wrote.
     */
    describe("lanes", () => {

        const REPOS = [
            "# Implementation Plan: demo",
            "",
            "## Tasks",
            "",
            "- [ ] 1. Orders",
            "  - [ ] 1.1 Add the parser",
            "    - Files: `orders-api/src/parser.ts`",
            "  - [ ] 1.2 Add the walker",
            "    - Files: `orders-api/src/walker.ts`",
            "- [ ] 2. Billing",
            "  - [ ] 2.1 Add the runner",
            "    - Files: `billing/src/runner.ts`",
            "",
            "## Task Dependency Graph",
            "",
            "```json",
            '{ "waves": [ { "id": 0, "tasks": ["1.1"] }, { "id": 1, "tasks": ["1.2"] }, { "id": 2, "tasks": ["2.1"] } ] }',
            "```",
            ""
        ].join("\n");

        const THREE = [
            { id: "1.1", text: "Add the parser", wave: 0 },
            { id: "1.2", text: "Add the walker", wave: 1 },
            { id: "2.1", text: "Add the runner", wave: 2 }
        ];

        beforeEach(() => {

            write(`.eesha/specs/${SPEC}/tasks.md`, REPOS);
        });

        it("runs the waves one at a time in the plan's order, even in different repositories", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: THREE });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            expect(promptOf(0)).toContain("- 1.1 Add the parser (wave 0)");

            // Billing's wave is in another repository and still waits its turn.
            const queued = await until(() => panel.sent<{ queued: string[] }>("lanes").pop()?.queued, list => list?.length === 2);

            expect(queued).toEqual(["1.2", "2.1"]);

            tick("1.1");
            end(0);

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

            expect(promptOf(1)).toContain("- 1.2 Add the walker (wave 1)");

            tick("1.2");
            end(1);

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 3);

            expect(promptOf(2)).toContain("- 2.1 Add the runner (wave 2)");

            // One chat for the whole phase: the first wave made it, the later ones went on in it.
            expect([...phaseChats.values()].map(chat => chat.phase)).toEqual(["implement@1.1"]);

            await stopAll(panel);
        });

        it("drops every wave queued behind a chat that stopped short", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: THREE });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            // The first chat stops with 1.1 unticked: nothing after it starts.
            end(0);

            await settled(panel);

            const said = recorded.info.join("\n");

            expect(said).toContain("1.1 unticked");
            expect(said).toContain("1.2, 2.1 waited on it and will not start");
            expect(runPhaseMock).toHaveBeenCalledTimes(1);
        });

        /* A task done by hand must not show "implementing" and Stop, which would look stuck. */
        it("says a task done by hand is waiting on you, and Mark done ticks it and moves on", async () => {

            const panel = await show(context());

            await panel.receive({
                type: "implement",
                tasks: [THREE[0], { ...THREE[1], run: { kind: "manual" as const } }, THREE[2]]
            });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            tick("1.1");
            end(0);

            const waiting = await until(
                () => panel.sent<{ waiting: string[] }>("lanes").pop()?.waiting,
                list => list?.length === 1);

            expect(waiting).toEqual(["1.2"]);
            expect(runPhaseMock).toHaveBeenCalledTimes(1);

            await panel.receive({ type: "markDone", taskId: "1.2" });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

            const plan = fs.readFileSync(path.join(workspace, ".eesha", "specs", SPEC, "tasks.md"), "utf8");

            expect(plan).toContain("- [x] 1.2 Add the walker");
            expect(promptOf(1)).toContain("- 2.1 Add the runner (wave 2)");
            expect(panel.sent<{ waiting: string[] }>("lanes").pop()?.waiting).toEqual([]);

            await stopAll(panel);
        });

        /* A real terminal answers when the command ends - long after it was started. */
        it("waits for a command's late exit code, then ticks its task and moves on", async () => {

            let exit!: (code: number) => void;

            terminal.exit = () => new Promise(done => { exit = done; });

            const panel = await show(context());

            await panel.receive({
                type: "implement",
                tasks: [THREE[0], { ...THREE[1], run: { kind: "command" as const, command: "npm test" } }, THREE[2]]
            });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            tick("1.1");
            end(0);

            // The command is in the terminal and has not ended: nothing ticked, nothing next.
            await until(() => recorded.terminals[0]?.sent.length, count => count === 1);

            expect(recorded.terminals[0].sent).toEqual(["npm test"]);
            expect(fs.readFileSync(path.join(workspace, ".eesha", "specs", SPEC, "tasks.md"), "utf8")).toContain("- [ ] 1.2 Add the walker");
            expect(runPhaseMock).toHaveBeenCalledTimes(1);

            exit(0);

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

            expect(fs.readFileSync(path.join(workspace, ".eesha", "specs", SPEC, "tasks.md"), "utf8")).toContain("- [x] 1.2 Add the walker");
            expect(promptOf(1)).toContain("- 2.1 Add the runner (wave 2)");

            await stopAll(panel);
        });

        it("ticks nothing when a command's exit code comes after Stop", async () => {

            let exit!: (code: number) => void;

            terminal.exit = () => new Promise(done => { exit = done; });

            const panel = await show(context());

            await panel.receive({
                type: "implement",
                tasks: [THREE[0], { ...THREE[1], run: { kind: "command" as const, command: "npm test" } }, THREE[2]]
            });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            tick("1.1");
            end(0);

            await until(() => recorded.terminals[0]?.sent.length, count => count === 1);

            await stop(panel);

            exit(0);

            // Give the late answer its turn to run.
            await new Promise(done => setTimeout(done, 50));

            expect(fs.readFileSync(path.join(workspace, ".eesha", "specs", SPEC, "tasks.md"), "utf8")).toContain("- [ ] 1.2 Add the walker");
            expect(runPhaseMock).toHaveBeenCalledTimes(1);
        });

        it("ends a running command on Stop, and shows what it printed in the Logs tab", async () => {

            const PRINTED = "PASS walker.test.ts";

            let stopped = false;

            terminal.exit = (_command, run) => new Promise(done => {

                run?.output?.(PRINTED);
                run?.onStop?.(() => { stopped = true; done(undefined); });
            });

            const panel = await show(context());

            await panel.receive({
                type: "implement",
                tasks: [THREE[0], { ...THREE[1], run: { kind: "command" as const, command: "npm test" } }, THREE[2]]
            });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            tick("1.1");
            end(0);

            await until(() => recorded.terminals[0]?.sent.length, count => count === 1);

            expect(panel.posted.some(message => message.type === "log" && message.text === PRINTED && message.stream === "stdout")).toBe(true);

            await stop(panel);

            expect(stopped).toBe(true);
            expect(fs.readFileSync(path.join(workspace, ".eesha", "specs", SPEC, "tasks.md"), "utf8")).toContain("- [ ] 1.2 Add the walker");
        });

        /* ▶ on the last task must not start it with nothing before it coded. */
        it("refuses a ▶ on a task while a task before it is unticked, and names them", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: [THREE[2]] });

            const seen = await until(() => [...recorded.errors], errors => errors.length > 0);

            expect(seen[0]).toContain("Task 2.1 cannot start yet - the plan puts 1.1, 1.2 before it");
            expect(runPhaseMock).not.toHaveBeenCalled();

            // The refusal redraws as it ends; waited for, so its tail
            // does not run into the next test.
            await until(() => lastBusy(panel), busy => busy === undefined);
            await redrawn(panel, 1);
        });

        it("starts a task once every task before it is ticked", async () => {

            tick("1.1", "1.2");

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: [THREE[2]] });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            expect(promptOf(0)).toContain("2.1 Add the runner");

            await stopAll(panel);
        });

        /* The wave ahead is in a chat already, so the next one queues behind it rather than being refused. */
        it("queues a ▶ on the next wave behind the chat working the one before", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: [THREE[0]] });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            await panel.receive({ type: "implement", tasks: [THREE[1]] });

            const queued = await until(() => panel.sent<{ queued: string[] }>("lanes").pop()?.queued, list => list?.length === 1);

            expect(queued).toEqual(["1.2"]);
            expect(runPhaseMock).toHaveBeenCalledTimes(1);

            tick("1.1");
            end(0);

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 2);

            expect(promptOf(1)).toContain("1.2 Add the walker");

            await stopAll(panel);
        });

        /* Two waves ahead is still out of order: 1.2 sits between and nobody holds it. */
        it("refuses a ▶ two waves ahead even while the first is in a chat", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: [THREE[0]] });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            await panel.receive({ type: "implement", tasks: [THREE[2]] });

            const seen = await until(() => [...recorded.errors], errors => errors.length > 0);

            expect(seen[0]).toContain("Task 2.1 cannot start yet - the plan puts 1.2 before it");
            expect(runPhaseMock).toHaveBeenCalledTimes(1);

            await stopAll(panel);
        });
    });

    /* Two developers on one branch: wave 2 waits for nothing, so it is a second starting point. */
    describe("branches", () => {

        const BRANCHED = [
            "# Implementation Plan: demo",
            "",
            "## Tasks",
            "",
            "- [ ] 1. Orders",
            "  - [ ] 1.1 Add the parser",
            "    - Files: `orders-api/src/parser.ts`",
            "  - [ ] 1.2 Add the walker",
            "    - Files: `orders-api/src/walker.ts`",
            "- [ ] 2. Billing",
            "  - [ ] 2.1 Add the runner",
            "    - Files: `billing/src/runner.ts`",
            "",
            "## Task Dependency Graph",
            "",
            "```json",
            '{ "waves": [ { "id": 0, "tasks": ["1.1"] }, { "id": 1, "tasks": ["1.2"], "after": [0] }, { "id": 2, "tasks": ["2.1"], "after": [] } ] }',
            "```",
            ""
        ].join("\n");

        beforeEach(() => {

            write(`.eesha/specs/${SPEC}/tasks.md`, BRANCHED);
        });

        it("starts a task on another starting point while the first branch is unticked", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: [{ id: "2.1", text: "Add the runner", wave: 2 }] });

            await until(() => runPhaseMock.mock.calls.length, calls => calls === 1);

            expect(promptOf(0)).toContain("2.1 Add the runner");
            expect(recorded.errors).toEqual([]);

            await stopAll(panel);
        });

        it("still holds a wave back for the wave it waits for, and names only that one", async () => {

            const panel = await show(context());

            await panel.receive({ type: "implement", tasks: [{ id: "1.2", text: "Add the walker", wave: 1 }] });

            const seen = await until(() => [...recorded.errors], errors => errors.length > 0);

            expect(seen[0]).toContain("Task 1.2 cannot start yet - the plan puts 1.1 before it");
            expect(runPhaseMock).not.toHaveBeenCalled();

            await until(() => lastBusy(panel), busy => busy === undefined);
            await redrawn(panel, 1);
        });
    });
});

describe("following the folder", () => {

    it("re-reads the spec when a document lands on disk", async () => {

        const panel = await show(context());

        const before = panel.sent("spec").length;

        write(`.eesha/specs/${SPEC}/design.md`, "# Design\n");

        watchers[0].fire();

        // Waited for rather than slept through: the re-read reads the
        // whole spec folder and every style, so any fixed delay is either
        // slower than it needs to be or flaky on a loaded machine - and a
        // test that fails on someone else's laptop is a test people learn
        // to re-run rather than read.
        const messages = await until(
            () => panel.sent<{ spec: { stages: { name: string; exists?: boolean }[] } }>("spec"),
            sent => sent.length > before);

        expect(messages.pop()!.spec.stages.find(stage => stage.name === "design")?.exists).toBe(true);
    });

    /*
     * The view asks for a document once and keeps it. An agent ticking a
     * box through `task_done` rewrites the file on disk; without this the
     * row on screen would stay unticked while the toast said every task
     * was done.
     */
    it("sends a served document again when it changes on disk, and not when it does not", async () => {

        const panel = await show(context());

        const file = path.join(workspace, ".eesha", "specs", SPEC, "requirements.md");

        await panel.receive({ type: "requestDocument", path: file });

        const before = panel.sent("document").length;

        // Some other file in the folder changed: nothing to send again.
        write(`.eesha/specs/${SPEC}/design.md`, "# Design\n");
        watchers[0].fire();

        expect(panel.sent("document").length).toBe(before);

        write(`.eesha/specs/${SPEC}/requirements.md`, "# Requirements\n\n- [x] ticked by the agent\n");
        watchers[0].fire();

        const documents = panel.sent<{ path: string; content: string }>("document");

        expect(documents.length).toBe(before + 1);
        expect(documents[documents.length - 1]).toEqual({ type: "document", path: file, content: "# Requirements\n\n- [x] ticked by the agent\n" });
    });

    /*
     * Its own folder, and nothing else. Watching the whole workspace
     * would mean every unrelated markdown save in a repository with a
     * docs tree re-reads the spec, re-lists every style on disk, and
     * posts to every open panel.
     */
    it("watches the spec's own folder, not the whole workspace", async () => {

        await show(context());

        const folders = watchers.map(watcher => watcher.folder);

        expect(folders).toHaveLength(1);
        expect(folders[0]).toBe(path.join(workspace, ".eesha", "specs", SPEC));
        expect(folders[0]).not.toBe(workspace);
    });

    /*
     * One watcher, however many times the spec is re-read. A send happens
     * on every file event, and a watcher rebuilt inside the thing it
     * triggers is a leak that grows with use.
     */
    it("does not build a second watcher when the spec is re-read", async () => {

        const panel = await show(context());

        const before = panel.sent("spec").length;
        

        watchers[0].fire();

        await until(() => panel.sent("spec"), sent => sent.length > before);

        expect(watchers).toHaveLength(1);
    });
});

/*
 * A plan row's command runs in the host's terminal, standing in the
 * folder the plan's paths are relative to - the workspace folder
 * holding the spec, never the first folder of the workspace, and never
 * a terminal left standing somewhere else.
 */
describe("a plan row's command", () => {

    it("runs in a terminal standing in the spec's workspace folder, one per folder", async () => {

        const panel = await show(context());

        await panel.receive({ type: "runCommand", command: "git -C orders-api status" });

        await until(() => recorded.terminals.length, count => count === 1);

        expect(recorded.terminals[0].cwd).toBe(workspace);
        expect(recorded.terminals[0].sent).toEqual(["git -C orders-api status"]);
        expect(recorded.terminals[0].shown).toBe(1);

        // The same folder reuses the terminal rather than opening another.
        await panel.receive({ type: "runCommand", command: "git status" });

        await until(() => recorded.terminals[0].sent.length, count => count === 2);

        expect(recorded.terminals).toHaveLength(1);
        expect(recorded.terminals[0].sent).toEqual(["git -C orders-api status", "git status"]);
    });

    /*
     * A command nobody can stop - an `npm run watch` would run until
     * the server itself was stopped. The host hands over a way to stop
     * it, so the button is Stop while it runs, and a second press of
     * the same row does not start it twice.
     */
    it("shows the command as running, stops it on Stop, and does not start it twice", async () => {

        let stopped = 0;

        const commands = (panel: { posted: { type: string }[] }) =>
            (panel.posted.filter(message => message.type === "commands").at(-1) as { running: string[] } | undefined)?.running;

        const panel = await show(context());

        await panel.receive({ type: "runCommand", command: "npm run watch" });

        await until(() => terminal.sentRuns.length, count => count === 1);

        terminal.sentRuns[0].onStop?.(() => { stopped++; terminal.sentRuns[0].ended?.(); });

        expect(commands(panel)).toEqual(["npm run watch"]);

        await panel.receive({ type: "runCommand", command: "npm run watch" });

        await until(
            () => panel.sent<{ text: string }>("log").some(line => line.text.includes("Already running: npm run watch")),
            seen => seen);

        expect(recorded.terminals[0].sent).toEqual(["npm run watch"]);

        await panel.receive({ type: "stopCommand", command: "npm run watch" });

        expect(stopped).toBe(1);
        expect(commands(panel)).toEqual([]);
    });
});

describe("the review", () => {

    const doc = () => path.join(workspace, ".eesha", "specs", SPEC, "requirements.md");

    it("sends the notes with the spec, so a badge is there when the document is", async () => {

        write(`.eesha/specs/${SPEC}/review.json`, JSON.stringify({
            version: 1,
            notes: [{
                id: "n1",
                artifact: `.eesha/specs/${SPEC}/requirements.md`,
                line: 7,
                anchorText: "It works.",
                body: "Say how.",
                createdAt: "2026-09-02T00:00:00.000Z"
            }]
        }));

        const panel = await show(context());

        const sent = await until(
            () => panel.sent<{ notes: { body: string; artifact: string }[] }>("notes"),
            seen => seen.length > 0);

        expect(sent[0].notes[0].body).toBe("Say how.");

        // The file names the document the repository's way; the view
        // opens files, so it is handed the path this machine opens.
        expect(sent[0].notes[0].artifact).toBe(doc());
    });

    it("writes notes to a file the spec folder can commit, and echoes back what it wrote", async () => {

        const panel = await show(context());

        await panel.receive({
            type: "saveNotes",
            notes: [{
                id: "n1",
                artifact: doc(),
                line: 7,
                anchorText: "It works.",
                body: "Say how.",
                createdAt: "2026-09-02T00:00:00.000Z"
            }]
        });

        const file = path.join(workspace, ".eesha", "specs", SPEC, "review.json");

        await until(() => fs.existsSync(file), seen => seen);

        const written = JSON.parse(fs.readFileSync(file, "utf8")).notes[0];

        expect(written.body).toBe("Say how.");

        // Committed and read on other machines, so the document is
        // named the way the repository names it - not the way this
        // laptop's drive does.
        expect(written.artifact).toBe(`.eesha/specs/${SPEC}/requirements.md`);

        const echoed = await until(
            () => panel.sent<{ notes: unknown[] }>("notes"),
            seen => seen.some(one => one.notes.length === 1));

        expect(echoed.pop()!.notes).toHaveLength(1);
    });

    /*
     * Undefined is a real answer and not the same as an empty
     * document: nothing to compare has to mark nothing, where an empty
     * baseline would mark every line of a first draft as new.
     */
    it("answers with no content when no version of a document was ever put aside", async () => {

        const panel = await show(context());

        await panel.receive({ type: "requestBaseline", path: doc() });

        const sent = await until(
            () => panel.sent<{ content?: string }>("baseline"),
            seen => seen.length > 0);

        expect(sent[0].content).toBeUndefined();
    });

});

describe("revising a document", () => {

    /**
     * `SddCore.phase()` is the boundary between `run()` and actually
     * running a phase - nothing else in this file exercises a real
     * `runPhase`, and this test does not either. The spy throws so
     * `run()`'s own `catch` reports it and stops, which is enough to
     * prove exactly what note `phase()` was handed.
     */
    function stopBeforePhase() {

        return vi.spyOn(SddCore.prototype, "phase").mockImplementation(() => {

            throw new Error("stopped before phase() for the test");
        });
    }

    afterEach(() => {

        vi.restoreAllMocks();
    });

    /*
     * There is no session yet to continue - see `sendMessage` - so a
     * document phase with an existing draft is run fresh, straight on
     * whatever the compose box sent. No confirmation and no
     * input box: restarting must not lose the conversation, which
     * is the wrong outcome, not a safety check worth a dialog over.
     */
    it("runs straight on the note it was sent, with no confirmation", async () => {

        write(`.eesha/specs/${SPEC}/design.md`, "# Design\n\nSee requirements.\n");

        const phase = stopBeforePhase();
        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements", revise: true, note: "split requirement 3" });

        await until(() => phase.mock.calls.length > 0, seen => seen);

        expect(recorded.warnings).toEqual([]);
        // No tasks: only a wave chat's turn is handed some.
        expect(phase).toHaveBeenCalledWith(
            expect.anything(), "requirements", { note: "split requirement 3" }, undefined);
    });

    it("treats no note as the ordinary revise - the document as it stands is the input", async () => {

        const phase = stopBeforePhase();
        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements", revise: true });

        await until(() => phase.mock.calls.length > 0, seen => seen);

        expect(phase).toHaveBeenCalledWith(expect.anything(), "requirements", { note: "" }, undefined);
    });

    /* "Send notes to the chat" on the Doc tab: the notes go into the message box of the phase's chat. */
    it("puts the notes in the message box of the phase's chat", async () => {

        new EventWriter(specEventsPath(workspace, SPEC), `sdd:${SPEC}`).control("start", "requirements", { chatId: "chat-7" });

        const panel = await show(context());

        await panel.receive({ type: "notesToChat", stageId: "requirements", text: "split requirement 3" });

        expect(panel.sent("phaseChat")).toEqual([{ type: "phaseChat", stageId: "requirements", chatId: "chat-7", text: "split requirement 3" }]);
    });

    it("says so when the phase has no chat yet, and moves nowhere", async () => {

        const panel = await show(context());

        await panel.receive({ type: "notesToChat", stageId: "requirements", text: "split requirement 3" });

        expect(panel.sent("phaseChat")).toEqual([]);
        expect(recorded.info.join("\n")).toContain("requirements has no chat yet");
    });
});

/*
 * What a run writes down, once a real `runPhase` call is in the loop -
 * `runPhaseMock` stands in for it, so these do not need a real agent,
 * only a result for the panel to react to.
 */
describe("running a phase - what the panel records", () => {

    function history() {

        return new EventWriter(specEventsPath(workspace, SPEC), `sdd:${SPEC}`);
    }

    /*
     * `restart` means "the earlier draft is superseded, hide it" - true
     * of a genuine restart, false of a revise that carries the same
     * conversation on. Writing it on every run regardless would let a
     * live 45-turn conversation show as three lines on reopen: the
     * agent still had all of it, `currentEvents` did not.
     */
    it("runs a fresh phase in a new phase chat named after the spec and the phase, and records it", async () => {

        runPhaseMock.mockImplementation(async input => {

            // What the chat would do: run the call, then check it.
            const ran = await input.via!({ session: "requirements", prompt: "p", title: "t", attachments: [], ai: input.request.ai }, () => undefined);

            return { success: ran.success, written: [], missing: [], sessionId: "session-1" };
        });

        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements" });

        await until(() => history().read().some(event => event.kind === "end"), seen => seen);

        const chat = phaseChats.get("chat-1")!;

        expect(chat.phase).toBe("requirements");
        expect(chat.title).toBe(`${SPEC} · Requirements`);
        expect(chat.calls).toHaveLength(1);
        expect(panel.sent<{ stageId: string; chatId: string }>("phaseChat")).toEqual([{ type: "phaseChat", stageId: "requirements", chatId: "chat-1" }]);

        const start = history().read().find(event => event.kind === "start" && event.ownerId === "requirements");

        expect(start?.chatId).toBe("chat-1");
        expect(history().read().some(event => event.kind === "session" && event.sessionId === "session-1")).toBe(true);

        // A second fresh run is a second chat, numbered.
        await panel.receive({ type: "run", stageId: "requirements" });
        await until(() => phaseChats.size === 2, seen => seen);

        expect(phaseChats.get("chat-2")!.title).toBe(`${SPEC} · Requirements #2`);
    });

    /*
     * A message typed into a phase chat can rewrite the phase's
     * document, the same as Revise. Without a copy taken first, "What
     * changed" would compare against the draft from before the last
     * button press.
     */
    it("puts the phase's document aside before a message typed into its chat", async () => {

        runPhaseMock.mockResolvedValue({ success: true, written: [], missing: [], sessionId: "session-1" });

        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements" });
        await until(() => history().read().some(event => event.kind === "end"), seen => seen);

        const folder = path.join(workspace, ".eesha", "specs", SPEC);
        const file = path.join(folder, "requirements.md");

        const draft = "# Requirements\n\nDraft after the button.\n";

        fs.writeFileSync(file, draft);

        await ownerOf(SPEC, "chat-1").keepBaseline();

        expect(baseline(folder, workspace, file)).toBe(draft);
    });

    it("does not mark a restart when the same conversation is carried on", async () => {

        // The phase ran before, in its own chat, which holds the
        // conversation - a Revise carries it on in that chat.
        runPhaseMock.mockResolvedValue({ success: true, written: [], missing: [], sessionId: "session-1" });

        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements" });
        await until(() => runPhaseMock.mock.calls.length > 0, seen => seen);
        await until(() => history().read().some(event => event.kind === "end"), seen => seen);

        const chat = phaseChats.get("chat-1")!;

        chat.session = { sessionId: "session-1" };

        const before = history().read().filter(event => event.kind === "restart").length;

        runPhaseMock.mockClear();
        panel.posted.length = 0;

        await panel.receive({ type: "run", stageId: "requirements", revise: true, note: "tighten it" });

        await until(() => runPhaseMock.mock.calls.length > 0, seen => seen);

        expect(history().read().filter(event => event.kind === "restart").length).toBe(before);
        expect(panel.sent<{ stageId: string }>("clearLog").some(one => one.stageId === "requirements"))
            .toBe(false);

        // The continue was actually offered to the plugin - not merely
        // "no restart", but the same session, in the same chat.
        expect(runPhaseMock.mock.calls[0][0].continueSession).toBe("session-1");
        expect(phaseChats.size).toBe(1);
        expect(panel.sent<{ chatId: string }>("phaseChat").map(one => one.chatId)).toEqual(["chat-1"]);
    });

    /*
     * The other half of the same rule: nothing to continue is a genuine
     * restart, and the marker plus the view's own clear still belong
     * here.
     */
    it("marks a restart and clears the view when there is nothing to continue", async () => {

        runPhaseMock.mockResolvedValue({ success: true, written: [], missing: [] });

        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements", revise: true, note: "tighten it" });

        await until(() => runPhaseMock.mock.calls.length > 0, seen => seen);

        expect(history().read().some(event => event.kind === "restart" && event.ownerId === "requirements"))
            .toBe(true);
        expect(panel.sent<{ stageId: string }>("clearLog").some(one => one.stageId === "requirements"))
            .toBe(true);
    });

    /*
     * `onSession` and the outcome both carry the same id on the ordinary
     * path. Recording it both times would leave two junk lines in the file on
     * every single turn, for the life of the spec.
     */
    it("records a session id once, not twice, when onSession already reported it", async () => {

        runPhaseMock.mockImplementation(async input => {

            input.onSession?.("chat-9");

            return { success: true, written: [], missing: [], sessionId: "chat-9" };
        });

        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements", revise: false });

        await until(() => runPhaseMock.mock.calls.length > 0, seen => seen);
        await until(
            () => history().read().filter(event => event.kind === "session" && event.sessionId === "chat-9"),
            seen => seen.length > 0);

        expect(history().read().filter(event => event.kind === "session" && event.sessionId === "chat-9"))
            .toHaveLength(1);
    });

    /*
     * A failed phase must not leave only a toast: the popup closes, the
     * tab says nothing happened, and reopening the panel shows a `start`
     * with no explanation for why there is no `end` worth having. The
     * reason travels with the record and lands in the phase's own
     * log too.
     */
    it("writes down why a phase failed, not only a toast that closes", async () => {

        runPhaseMock.mockResolvedValue({
            success: false, written: [], missing: ["specs/one/requirements.md"], message: "the agent refused"
        });

        const panel = await show(context());

        await panel.receive({ type: "run", stageId: "requirements", revise: false });

        await until(
            () => panel.sent<{ stageId: string; text: string }>("log")
                .filter(line => line.stageId === "requirements" && line.text.includes("the agent refused")),
            seen => seen.length > 0);

        const end = history().read().find(event => event.kind === "end" && event.ownerId === "requirements");

        expect(end).toMatchObject({ status: "failed", text: "the agent refused" });
    });
});

/*
 * The gate. A phase writes down what it could not settle, and until
 * somebody answers it the panel refuses the controls that would advance
 * past it - so what the panel owes the view is the unanswered questions
 * of each document, and nothing for the documents that have none.
 */
describe("open questions", () => {

    /** This spec's stages as the view received them, once the panel has drawn. */
    async function stages(panel: { sent<T>(type: string): T[] }) {

        const sent = await until(
            () => panel.sent<{ spec: { stages: { name: string; openQuestions?: { id?: string }[] }[] } }>("spec"),
            messages => messages.length > 0);

        return sent[sent.length - 1].spec.stages;
    }

    const questioned = (body: string) =>
        write(`.eesha/specs/${SPEC}/requirements.md`,
            `# Requirements\n\n## Open Questions\n\n${body}\n\n### Requirement 1\n\nIt works.\n`);

    it("carries the unanswered ones and nothing for a clean document", async () => {

        questioned("- **QN-1** Which auth flow?");

        const found = await stages(await show(context()));

        expect(found.find(stage => stage.name === "requirements")?.openQuestions)
            .toEqual([{ id: "QN-1", text: "Which auth flow?" }]);

        // Every other document in this fixture is unwritten or clean,
        // and an empty array would read to the view as "blocked by
        // nothing", which is a different statement from "not blocked".
        expect(found.filter(stage => stage.name !== "requirements").every(stage => !stage.openQuestions)).toBe(true);
    });

    it("says nothing about a question that has been answered", async () => {

        questioned("- **QN-1** Which auth flow?\n  **A:** Device code.");

        const found = await stages(await show(context()));

        expect(found.find(stage => stage.name === "requirements")?.openQuestions).toBeUndefined();
    });

    /*
     * The style's own switch. Off, the section is still written and
     * still travels in git - the panel simply stops reporting it, so
     * nothing downstream has to know why.
     */
    it("reports nothing when the style turns the gate off", async () => {

        questioned("- **QN-1** Which auth flow?");

        const style = parse(fs.readFileSync(
            path.join(resourcesPath, "resources", "styles", "custom", "style.yml"), "utf8"));

        style.blockOnOpenQuestions = false;

        ownStyle(stringify(style));

        const found = await stages(await show(context()));

        // Asserted present first: a spec that stopped being discovered
        // would report no questions too, and pass this for the wrong
        // reason.
        expect(found.map(stage => stage.name)).toContain("requirements");
        expect(found.find(stage => stage.name === "requirements")?.openQuestions).toBeUndefined();
    });
});

/*
 * A started phase stays on the runtime its conversation is on, whatever
 * the spec's AI says now: a session id belongs to the runtime that
 * issued it.
 */
describe("a started phase's runtime", () => {

    beforeEach(() => {

        new EventWriter(specEventsPath(workspace, SPEC), `sdd:${SPEC}`).session("requirements", "chat-1", "ghcp", "gpt-5");

        runPhaseMock.mockResolvedValue({ success: true, sessionId: "chat-2", written: [], missing: [] });
    });

    it("keeps a revise on the runtime its conversation started on when the spec's AI has moved", async () => {

        const panel = await show(context());

        await panel.receive({ type: "setAiChoice", pick: { provider: "claude" } });
        await panel.receive({ type: "run", stageId: "requirements", revise: true, note: "and imports" });

        await until(() => runPhaseMock.mock.calls.length, count => count > 0);

        expect(runPhaseMock.mock.calls[0][0].request.ai.args.provider).toBe("ghcp");
    });
});

describe("the Permissions picker", () => {

    it("sends a level for each runtime with the choices", async () => {

        const panel = await show(context());

        await panel.receive({ type: "ready" });

        await until(() => panel.sent<{ choice: { levels?: unknown } }>("aiChoice").length, count => count > 0);

        const choice = panel.sent<{ choice: { providers: string[]; levels?: Record<string, unknown>; savedAnswers?: number } }>("aiChoice")[0].choice;

        expect(Object.keys(choice.levels ?? {})).toEqual(choice.providers);
        expect(choice.savedAnswers).toBe(0);
    });
});
