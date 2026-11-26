import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentSession } from "../../AgentSession";
import { coreProviders } from "../..";
import type { PermissionCard } from "../../../models/permissionCard";
import type { GateCall, GateDecision, PermissionGate } from "../../permissions";
import { FAKE_ANSWERS, FAKE_NOTE, FAKE_QUESTION, FakeProvider, handedTasks } from "../FakeProvider";

/*
 * The fake runtime: no model, no cost. It writes the phase's file, asks
 * one question when someone watches, writes again on a revise, and
 * ticks the tasks an implement prompt hands it.
 */

let dir: string;

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-runtime-"));
});

afterEach(() => {

    fs.rmSync(dir, { recursive: true, force: true });
});

/** A session with no waits, and every event it sends. */
async function open(config: Partial<Parameters<FakeProvider["createSession"]>[0]> = {}): Promise<{ session: AgentSession; events: AgentEvent[] }> {

    const session = await new FakeProvider(0).createSession({ workingDirectory: dir, env: {}, ...config });
    const events: AgentEvent[] = [];

    session.on(event => events.push(event));

    return { session, events };
}

describe("FakeProvider", () => {

    it("is registered in the core providers as 'fake'", async () => {

        expect(await coreProviders().get("fake")).toBeInstanceOf(FakeProvider);
    });

    it("writes the phase's file and ends the turn idle", async () => {

        const { session, events } = await open({ target: "specs/one/requirements.md" });

        await session.sendAndWait({ prompt: "Draft it." });

        const text = fs.readFileSync(path.join(dir, "specs/one/requirements.md"), "utf8");

        expect(text.startsWith("# Requirements\n")).toBe(true);
        expect(text).toContain("### Requirement 1: Sample behaviour");
        expect(text).toContain("#### Acceptance Criteria");
        expect(events.at(-1)?.kind).toBe("idle");
        expect(session.status).toBe("idle");
    });

    it("works slowly for a 'fake slow' message until it is stopped, and then says nothing more", async () => {

        // A real step, so the turn is still working when it is stopped.
        const session = await new FakeProvider(20).createSession({ workingDirectory: dir, env: {} });
        const events: AgentEvent[] = [];

        session.on(event => events.push(event));

        const turn = session.sendAndWait({ prompt: "Please fake slow." });

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(session.status).toBe("working");

        await session.abort();
        await turn;

        // Its first line only: no answer, and no idle - the turn was stopped.
        expect(events.map(event => event.kind)).toEqual(["message"]);
    });

    it("stops a turn when the signal it was made with is aborted, as Stop does in the app", async () => {

        const stop = new AbortController();
        const session = await new FakeProvider(20).createSession({ workingDirectory: dir, env: {}, signal: stop.signal });
        const events: AgentEvent[] = [];

        session.on(event => events.push(event));

        const turn = session.sendAndWait({ prompt: "fake slow" });

        await new Promise(resolve => setTimeout(resolve, 100));

        stop.abort();
        await turn;

        expect(events.map(event => event.kind)).toEqual(["message"]);
        expect(session.status).toBe("idle");
    });

    it("answers a 'fake slow' message once its steps are done", async () => {

        const { session, events } = await open();

        await session.sendAndWait({ prompt: "fake slow" });

        expect(events.some(event => event.kind === "message" && event.text === "Fake answer, after working slowly.")).toBe(true);
        expect(events.at(-1)?.kind).toBe("idle");
    });

    it("writes the file again on a revise, with a revision line", async () => {

        const { session } = await open({ target: "design.md" });

        await session.sendAndWait({ prompt: "Draft it." });
        await session.sendAndWait({ prompt: "Revise it." });

        expect(fs.readFileSync(path.join(dir, "design.md"), "utf8")).toContain("Revision 1: written again by the fake runtime.");
    });

    it("asks one question when someone is watching, and puts the answer in the document", async () => {

        const { session, events } = await open({ target: "requirements.md", interactive: true });

        const turn = session.sendAndWait({ prompt: "Draft it." });

        // The question comes before anything is written.
        await new Promise(resolve => setTimeout(resolve, 0));

        const ask = events.find(event => event.kind === "ask");

        expect(ask?.kind === "ask" && ask.prompt).toBe(FAKE_QUESTION);
        expect(ask?.kind === "ask" && ask.options?.map(one => one.label)).toEqual([...FAKE_ANSWERS]);
        expect(fs.existsSync(path.join(dir, "requirements.md"))).toBe(false);

        await session.respond!(ask?.kind === "ask" ? ask.askId : "", "Answer B");
        await turn;

        expect(fs.readFileSync(path.join(dir, "requirements.md"), "utf8")).toContain("The person answered the fake question: Answer B.");
        expect(events.some(event => event.kind === "answer" && event.text === "Answer B")).toBe(true);
    });

    it("asks nothing when nobody is watching", async () => {

        const { session, events } = await open({ target: "requirements.md" });

        await session.sendAndWait({ prompt: "Draft it." });

        expect(events.some(event => event.kind === "ask")).toBe(false);
    });

    it("writes a plan to the Tasks phase's file", async () => {

        const { session } = await open({ target: "tasks.md", checkPlan: path.join(dir, "tasks.md") });

        await session.sendAndWait({ prompt: "Plan it." });

        const text = fs.readFileSync(path.join(dir, "tasks.md"), "utf8");

        expect(text).toContain("- [ ] 1.1 First sample task");
        expect(text).toContain("## Task Dependency Graph");
    });

    it("ticks the tasks the implement prompt hands it, and only those", async () => {

        const plan = path.join(dir, "tasks.md");

        fs.writeFileSync(plan, [
            "- [ ] 1. Group",
            "  - [ ] 1.1 One",
            "    - Files: `a.txt`",
            "  - [ ] 1.2 Two",
            "    - Files: `b.txt`",
            "- [ ] 2. Three",
            "    - Files: `c.txt`",
            ""
        ].join("\n"));

        const { session, events } = await open({ plan });

        await session.sendAndWait({
            prompt: [
                "# Implementation",
                "",
                "## Tasks to implement now",
                "",
                "- 1.1 One (wave 0) - plan line 2",
                "    - Files: `a.txt`",
                "- 1.2 Two (wave 0) - plan line 4",
                "    - 2 details that start with a number",
                "",
                "## The ask",
                "",
                "- 2 is not handed over."
            ].join("\n")
        });

        const text = fs.readFileSync(plan, "utf8");

        expect(text).toContain("- [x] 1.1 One");
        expect(text).toContain("- [x] 1.2 Two");
        expect(text).toContain("- [ ] 2. Three");
        expect(events.filter(event => event.kind === "tool.start" && event.tool === "task_done")).toHaveLength(2);
    });

    it("stops a turn when it is aborted", async () => {

        const session = await new FakeProvider(20).createSession({ workingDirectory: dir, env: {}, target: "requirements.md" });

        const turn = session.sendAndWait({ prompt: "Draft it." });

        await session.abort();
        await turn;

        expect(fs.existsSync(path.join(dir, "requirements.md"))).toBe(false);
    });

    it("keeps a resumed session's id", async () => {

        const session = await new FakeProvider(0).createSession({ workingDirectory: dir, env: {}, resume: "fake-earlier" });

        expect(session.id).toBe("fake-earlier");
        expect(session.resumed).toBe(true);
    });
});

/** A permission check that gives `verdict` for every call, and allows only the answer "Allow". */
function gateSaying(verdict: GateDecision["verdict"], calls: GateCall[] = []): PermissionGate {

    return {
        level: () => "agent",
        decide: call => {

            calls.push(call);

            return verdict === "ask"
                ? { verdict, card: { type: "edit", title: "fake wants to write a file", shown: call.paths?.[0] ?? "" } as unknown as PermissionCard }
                : verdict === "deny" ? { verdict, reason: "no", note: "no" } : { verdict };
        },
        answer: (_call, _card, text) => text === "Allow" ? { allow: true, note: "allowed" } : { allow: false, note: "refused" }
    };
}

/** A session whose writes go through `gate`. */
async function openGated(gate: PermissionGate, config: Partial<Parameters<FakeProvider["createSession"]>[0]> = {}): Promise<{ session: AgentSession; events: AgentEvent[] }> {

    const session = await new FakeProvider(0, { permissions: () => gate }).createSession({ workingDirectory: dir, env: {}, ...config });
    const events: AgentEvent[] = [];

    session.on(event => events.push(event));

    return { session, events };
}

describe("FakeProvider permission check", () => {

    it("writes fake-note.txt for a 'fake write' message when the check allows it", async () => {

        const calls: GateCall[] = [];
        const { session } = await openGated(gateSaying("allow", calls));

        await session.sendAndWait({ prompt: "Please fake write a note." });

        expect(fs.readFileSync(path.join(dir, FAKE_NOTE), "utf8")).toBe("Written by the fake runtime.\n");
        expect(calls).toEqual([expect.objectContaining({ what: "edit", writes: true, paths: [path.join(dir, FAKE_NOTE)] })]);
    });

    it("writes nothing for a message without the words", async () => {

        const { session } = await openGated(gateSaying("allow"));

        await session.sendAndWait({ prompt: "Hello." });

        expect(fs.existsSync(path.join(dir, FAKE_NOTE))).toBe(false);
    });

    it("skips the write when the check refuses it", async () => {

        const { session, events } = await openGated(gateSaying("deny"), { target: "requirements.md" });

        await session.sendAndWait({ prompt: "Draft it." });

        expect(fs.existsSync(path.join(dir, "requirements.md"))).toBe(false);
        expect(events.some(event => event.kind === "message" && event.text.includes("was not allowed"))).toBe(true);
    });

    it("puts a permission card to the person and writes after Allow", async () => {

        const { session, events } = await openGated(gateSaying("ask"), { interactive: true });

        const turn = session.sendAndWait({ prompt: "fake write" });

        await vi.waitFor(() => expect(events.some(event => event.kind === "ask")).toBe(true));

        const ask = events.find(event => event.kind === "ask");

        expect(ask?.kind === "ask" && ask.permission?.tool).toBe("Write");
        expect(fs.existsSync(path.join(dir, FAKE_NOTE))).toBe(false);

        await session.respond!(ask?.kind === "ask" ? ask.askId : "", "Allow");
        await turn;

        expect(fs.existsSync(path.join(dir, FAKE_NOTE))).toBe(true);
    });

    it("writes nothing when the person refuses the card", async () => {

        const { session, events } = await openGated(gateSaying("ask"), { interactive: true });

        const turn = session.sendAndWait({ prompt: "fake write" });

        await vi.waitFor(() => expect(events.some(event => event.kind === "ask")).toBe(true));

        const ask = events.find(event => event.kind === "ask");

        await session.respond!(ask?.kind === "ask" ? ask.askId : "", "Deny");
        await turn;

        expect(fs.existsSync(path.join(dir, FAKE_NOTE))).toBe(false);
    });

    it("writes inside the folders without a card when nobody is watching", async () => {

        const { session, events } = await openGated(gateSaying("ask"));

        await session.sendAndWait({ prompt: "fake write" });

        expect(events.some(event => event.kind === "ask")).toBe(false);
        expect(fs.existsSync(path.join(dir, FAKE_NOTE))).toBe(true);
    });
});

describe("handedTasks", () => {

    it("reads only the rows under 'Tasks to implement now'", () => {

        expect(handedTasks("## Tasks to implement now\n\n- 3.1 A (wave 1)\n    - 9 detail\n- T004 B\n\n## Next\n- 5 C")).toEqual(["3.1", "T004"]);
    });

    it("is empty with no such section", () => {

        expect(handedTasks("- 1 A")).toEqual([]);
    });
});
