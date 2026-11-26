import * as fs from "fs";
import * as path from "path";

import type { AgentProvider, ModelChoice, ProviderDeps } from "../AgentProvider";
import { AskDesk, type AgentEvent, type AgentMessage, type AgentSession, type AgentSessionConfig, type AgentSessionStatus } from "../AgentSession";
import { askCard, type GateCall } from "../permissions";
import { createJail } from "./pathJail";
import { checkPlan, markTaskDone } from "./planTools";

/*
 * The fake runtime: a runtime that calls no model and costs nothing.
 * It is for tests and for trying SDD by hand without spending money.
 * It is offered in the pickers
 * only when the `fakeRuntime` flag is on.
 *
 * What one turn does:
 *
 *   1. A drafting phase (the session has a `target` file) writes a
 *      sample document there. The Tasks phase (the session has a
 *      `checkPlan`) gets a small plan that the implement phase can run:
 *      two waves, three tasks, Files lines and the dependency graph.
 *      Every later turn in the same session writes the file again with
 *      one more "Revision" line, so What changed has something to show.
 *   2. When someone is watching (`interactive`), the first turn asks one
 *      question and puts the answer in the document.
 *   3. The implement phase (the session has a `plan`) ticks every task
 *      named under "## Tasks to implement now" in the prompt, through
 *      the same `task_done` step the real runtimes use. It writes no code.
 *   4. A chat message with the words "fake write" writes the file
 *      fake-note.txt in the working folder.
 *   5. A chat message with the words "fake slow" keeps working for about
 *      a minute, step by step, so a test can press Stop while it works.
 *
 * Every file it writes goes through the host's permission check first,
 * like a real runtime's edit. At a level that asks, the person gets a
 * permission card; a refused write is skipped.
 *
 * Each turn waits a little between steps, so a person can see it work.
 */

/** The fake runtime's id - what `ai.providers` and the pickers call it. */
export const FAKE_RUNTIME = "fake";

/** How long the fake waits between its steps, in milliseconds. */
const STEP_MS = 250;

/** The words in a chat message that make the fake write {@link FAKE_NOTE}. */
export const FAKE_WRITE_WORDS = "fake write";

/** The file a "fake write" message writes, in the working folder. */
export const FAKE_NOTE = "fake-note.txt";

/** The words in a chat message that make the fake work slowly, until it is stopped or about a minute has passed. */
export const FAKE_SLOW_WORDS = "fake slow";

/** How many steps a "fake slow" turn waits: a minute at the normal step. */
const SLOW_STEPS = 240;

/** The one question the fake asks, and its two answers. */
export const FAKE_QUESTION = "Fake runtime question: which answer should go into the document?";
export const FAKE_ANSWERS = ["Answer A", "Answer B"] as const;

export class FakeProvider implements AgentProvider {

    /**
     * @param stepMs Waits between steps. Tests pass 0.
     * @param deps   The host's permission check and folders. None: every write runs.
     */
    constructor(private readonly stepMs = STEP_MS, private readonly deps: ProviderDeps = {}) { }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {

        return new FakeSession(config, this.stepMs, this.deps);
    }

    async models(): Promise<ModelChoice[]> {

        return [{ id: "fake", name: "Fake (no model, no cost)" }];
    }
}

class FakeSession implements AgentSession {

    readonly id: string;

    readonly resumed?: boolean;

    status: AgentSessionStatus = "idle";

    private readonly handlers = new Set<(event: AgentEvent) => void>();

    private readonly desk = new AskDesk(event => this.emit(event));

    /** Turns done in this session - the first one is the draft, the rest are revisions. */
    private turns = 0;

    /** The answer to the one question, once given. */
    private answer: string | undefined;

    /** Bumped by abort, so a turn in flight stops at its next step. */
    private stopped = 0;

    constructor(private readonly config: AgentSessionConfig, private readonly stepMs: number, private readonly deps: ProviderDeps) {

        this.id = config.resume ?? `fake-${globalThis.crypto.randomUUID()}`;

        if (config.resume)
            this.resumed = true;

        // Stop on a new session's turn comes through this signal, as it
        // does for the real runtimes. Without it, Stop did nothing here.
        config.signal?.addEventListener("abort", () => void this.abort());
    }

    on(handler: (event: AgentEvent) => void): () => void {

        this.handlers.add(handler);

        return () => this.handlers.delete(handler);
    }

    async send(message: AgentMessage): Promise<void> {

        void this.turn(message).catch(() => undefined);
    }

    async sendAndWait(message: AgentMessage): Promise<void> {

        await this.turn(message);
    }

    async respond(askId: string, answer: string): Promise<void> {

        this.desk.respond(askId, answer);
    }

    async abort(): Promise<void> {

        this.stopped++;
    }

    async dispose(): Promise<void> {

        this.stopped++;
        this.status = "ended";
    }

    private emit(event: AgentEvent): void {

        for (const handler of this.handlers)
            handler(event);
    }

    private say(text: string): void {

        this.emit({ kind: "message", name: "fake.message", raw: undefined, text });
    }

    private async wait(): Promise<void> {

        if (this.stepMs > 0)
            await new Promise(resolve => setTimeout(resolve, this.stepMs));
    }

    private async turn(message: AgentMessage): Promise<void> {

        const turn = this.stopped;
        const live = () => this.stopped === turn;

        this.status = "working";
        this.turns++;

        try {

            this.say(`Fake runtime, turn ${this.turns}. No model is called.`);
            await this.wait();

            if (!live())
                return;

            if (this.config.plan) {

                await this.tickTasks(message.prompt, live);
                return;
            }

            const target = this.targetPath();

            if (!target) {

                if (message.prompt.toLowerCase().includes(FAKE_WRITE_WORDS)) {

                    await this.writeNote(live);
                    return;
                }

                if (message.prompt.toLowerCase().includes(FAKE_SLOW_WORDS)) {

                    for (let step = 0; step < SLOW_STEPS && live(); step++)
                        await this.wait();

                    if (live())
                        this.say("Fake answer, after working slowly.");

                    return;
                }

                this.say("Fake answer. Nothing was written, because this session names no file.");
                return;
            }

            if (this.config.interactive && this.turns === 1 && this.answer === undefined) {

                const pending = this.desk.ask({
                    prompt: FAKE_QUESTION,
                    options: FAKE_ANSWERS.map(label => ({ label })),
                    raw: undefined
                }, "fake.ask");

                this.answer = await pending.answer;
                this.emit({ kind: "answer", name: "fake.answer", raw: undefined, askId: pending.askId, text: this.answer });

                if (!live())
                    return;
            }

            const plan = this.config.checkPlan !== undefined;

            if (!await this.mayWrite(target)) {

                this.say(`Did not write ${path.basename(target)}, because the write was not allowed.`);
                return;
            }

            if (!live())
                return;

            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, plan ? fakePlan(this.turns) : fakeDocument(target, this.turns, this.answer), "utf8");

            this.emit({ kind: "tool.start", name: "fake.tool", raw: undefined, tool: "Write", path: target, detail: path.basename(target) });
            this.emit({ kind: "tool.end", name: "fake.tool", raw: undefined, tool: "Write", success: true });

            if (plan)
                this.say(`check_plan: ${checkPlan(target)}`);

            await this.wait();

            this.say(`Wrote ${path.basename(target)}${this.turns > 1 ? ` (revision ${this.turns - 1})` : ""}.`);

        } finally {

            if (live())
                this.emit({ kind: "idle", name: "fake.idle", raw: undefined });

            this.status = "idle";
        }
    }

    /** Writes fake-note.txt in the working folder, when the write is allowed. */
    private async writeNote(live: () => boolean): Promise<void> {

        const note = path.resolve(this.config.workingDirectory, FAKE_NOTE);

        if (!await this.mayWrite(note)) {

            this.say(`Did not write ${FAKE_NOTE}, because the write was not allowed.`);
            return;
        }

        if (!live())
            return;

        fs.writeFileSync(note, "Written by the fake runtime.\n", "utf8");

        this.emit({ kind: "tool.start", name: "fake.tool", raw: undefined, tool: "Write", path: note, detail: FAKE_NOTE });
        this.emit({ kind: "tool.end", name: "fake.tool", raw: undefined, tool: "Write", success: true });

        this.say(`Wrote ${FAKE_NOTE}.`);
    }

    /**
     * Whether a write of `file` may run: the host's permission check, as
     * a real runtime's edit is checked. A card is put to the person when
     * the level asks; with nobody watching, a write inside the folders
     * runs and one outside them does not. No check from the host: yes.
     */
    private async mayWrite(file: string): Promise<boolean> {

        const gate = this.deps.permissions?.(FAKE_RUNTIME, this.config.workingDirectory, this.config.chat);

        if (!gate)
            return true;

        const call: GateCall = { tool: "Write", what: "edit", paths: [file], writes: true, acpKind: "edit" };
        const decision = gate.decide(call, createJail(this.config.workingDirectory, this.deps.directories?.()));

        if (decision.verdict !== "ask")
            return decision.verdict === "allow";

        if (!this.config.interactive)
            return decision.card.type !== "outside";

        const answered = await askCard(request => this.desk.ask(request, "fake.permission"), gate, call, decision.card, file);

        return answered?.allow === true;
    }

    /** The session's target as a full path. */
    private targetPath(): string | undefined {

        const target = this.config.checkPlan ?? this.config.target;

        return target ? path.resolve(this.config.workingDirectory, target) : undefined;
    }

    /** Ticks each task the prompt hands over, through task_done. */
    private async tickTasks(prompt: string, live: () => boolean): Promise<void> {

        const ids = handedTasks(prompt);

        if (!ids.length) {

            this.say("No tasks were handed over, so none were ticked.");
            return;
        }

        for (const id of ids) {

            if (!live())
                return;

            this.emit({ kind: "tool.start", name: "fake.tool", raw: undefined, tool: "task_done", detail: id });

            const said = markTaskDone(this.config.plan!, { task: id });

            this.emit({ kind: "tool.end", name: "fake.tool", raw: undefined, tool: "task_done", success: said.startsWith("Ticked"), detail: said });

            await this.wait();
        }

        this.say(`## Changed\n\nNothing - the fake runtime writes no code. It ticked ${ids.join(", ")}.`);
    }
}

/**
 * The task ids under "## Tasks to implement now" in an implement
 * prompt, in order. Each task is a row `- <id> <title> (wave N) - plan
 * line M` at the start of a line (see `taskRows` in
 * src/sdd/phase/assemble.ts); its detail lines are indented and skipped.
 */
export function handedTasks(prompt: string): string[] {

    const start = prompt.search(/^##\s+Tasks to implement now\s*$/m);

    if (start < 0)
        return [];

    const rest = prompt.slice(start).split(/\r?\n/).slice(1);
    const end = rest.findIndex(line => /^##\s/.test(line));
    const section = end < 0 ? rest : rest.slice(0, end);

    const ids: string[] = [];

    for (const line of section) {

        const match = /^-\s+(\d+(?:\.\d+)*|T\d{3,})\.?\s/.exec(line);

        if (match && !ids.includes(match[1]!))
            ids.push(match[1]!);
    }

    return ids;
}

/** The phase's name from its file name: requirements.md is "Requirements". */
function titleOf(target: string): string {

    const base = path.basename(target, path.extname(target)).replace(/[-_]+/g, " ");

    return base.charAt(0).toUpperCase() + base.slice(1);
}

/** A sample document in the grammar's shapes. Requirements get a numbered requirement with criteria. */
export function fakeDocument(target: string, turn: number, answer?: string): string {

    const title = titleOf(target);
    const requirements = /requirement/i.test(path.basename(target));

    const lines = [
        `# ${title}`,
        "",
        "## Overview",
        "",
        `A sample ${title.toLowerCase()} document written by the fake runtime. No model was called and nothing was charged.`,
        ""
    ];

    if (requirements)
        lines.push(
            "## Requirements",
            "",
            "### Requirement 1: Sample behaviour",
            "",
            "**User Story:** As a tester, I want a sample requirement, so that the next phases have something to cite.",
            "",
            "#### Acceptance Criteria",
            "",
            "1. WHEN the fake runtime drafts THEN THE document SHALL have this criterion.",
            "2. IF the draft is revised THEN THE document SHALL list the revision below.",
            "");
    else
        lines.push(
            "## Details",
            "",
            "### Item 1: Sample item",
            "",
            "Sample text. It cites [Requirements : 1.1](requirements.md).",
            "");

    if (answer)
        lines.push("## Decisions", "", `- The person answered the fake question: ${answer}.`, "");

    lines.push("## Assumptions", "", "- Written by the fake runtime, for testing only.", "");

    for (let revision = 1; revision < turn; revision++)
        lines.push(`Revision ${revision}: written again by the fake runtime.`, "");

    return lines.join("\n");
}

/** A small plan the implement phase can run: two waves, three tasks. */
export function fakePlan(turn: number): string {

    const lines = [
        "# Tasks",
        "",
        "## Plan",
        "",
        "- [ ] 1. Sample group",
        "  - [ ] 1.1 First sample task",
        "    - Written by the fake runtime.",
        "    - Files: `fake/one.txt`",
        "    - _Requirements: 1.1_",
        "  - [ ] 1.2 Second sample task",
        "    - Written by the fake runtime.",
        "    - Files: `fake/two.txt`",
        "    - _Requirements: 1.2_",
        "- [ ] 2. Last sample task",
        "  - Written by the fake runtime.",
        "  - Files: `fake/three.txt`",
        "  - _Requirements: 1.1_",
        ""
    ];

    for (let revision = 1; revision < turn; revision++)
        lines.push(`Revision ${revision}: written again by the fake runtime.`, "");

    lines.push(
        "## Task Dependency Graph",
        "",
        "```json",
        JSON.stringify({ waves: [{ id: 0, tasks: ["1.1", "1.2"] }, { id: 1, tasks: ["2"] }] }, null, 2),
        "```",
        "");

    return lines.join("\n");
}
