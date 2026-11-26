import { describe, expect, it, vi } from "vitest";
import { PluginHost, TaskExecutionContext, TaskResult } from "../../../core/plugins/PluginHost";
import { Task } from "../../../core/models/task";
import { PhaseRequest } from "../assemble";
import { runCall, runPhase, type RunPhaseInput, runSession, type SessionCall, type SessionHost } from "../runPhase";

/** A host that records what it was asked to run and answers with whatever the test wants. */
function host(result: Partial<TaskResult> = {}) {

    const calls: { task: Task; context: TaskExecutionContext }[] = [];

    const fake = {
        execute: async (task: Task, context: TaskExecutionContext) => {

            calls.push({ task, context });

            return { success: true, ...result } as TaskResult;
        }
    } as unknown as PluginHost;

    return { host: fake, calls };
}

function request(over: Partial<PhaseRequest> = {}): PhaseRequest {

    return {
        writesPlan: false,
        stage: {
            id: "design", label: "design", produces: ["design.md"],
            instructions: { root: "style", path: "instructions/design.md" }
        },
        prompt: "WRITE THE DESIGN",
        targets: ["specs/one/design.md"],
        context: ["specs/one/requirements.md"],
        attachments: [{ name: "requirements", path: "C:/repo/specs/one/requirements.md" }],
        documents: { requirements: "specs/one/requirements.md" },
        ai: { uses: "ai@1", args: { model: "auto" } },
        sources: { prompt: { text: "", scope: "builtin" } },
        ...over
    };
}

/** Where a phase chat's turn runs, for the call `runPhase` hands it. */
const AT: SessionHost = { specId: "specs/one", workspace: "C:/repo", runId: "r1" };

/**
 * Runs a phase the way its chat runs the turn: the call `runPhase`
 * builds goes through `runCall` to the fake host. The check is said in
 * the chat's thread, so it is not looked at here.
 */
function phase(over: Partial<RunPhaseInput>, plugins: PluginHost, exists: (path: string) => boolean) {

    return runPhase({ request: request(), workspace: "C:/repo", via: call => runCall(call, AT, plugins), ...over }, exists);
}

/** A call as a chat turn makes it, for the tests of the session's own hooks. */
const CALL: SessionCall = { session: "design", prompt: "WRITE THE DESIGN", attachments: [], title: "design - one", ai: { uses: "ai@1", args: {} } };

const wrote = (...paths: string[]) => (path: string) => paths.includes(path);

describe("the call it makes", () => {

    it("runs the plugin the config named, with the args it resolved", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.plugin).toBe("ai@1");
        expect(calls[0].task.args).toMatchObject({ model: "auto", prompt: { literal: "WRITE THE DESIGN" } });
    });

    it("sends no standing instructions for a style with no intro", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).not.toHaveProperty("systemMessage");
    });

    /*
     * The prompt is words, never a template. A person writing a spec
     * about a workflow types `${{ params.repo }}` as plain text, and a
     * thread replayed for another runtime carries whatever was said.
     * The host resolves every arg, so the prompt goes wrapped as a
     * literal, which the host passes through as it is.
     */
    it("sends the prompt as a literal, so `${{ }}` in it is never resolved", async () => {

        const { host: fake, calls } = host();

        await phase(
            { prompt: "The task reads ${{ params.repo }}.", verbatim: true },
            fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.prompt).toEqual({ literal: "The task reads ${{ params.repo }}." });
    });

    /*
     * The plugin fails a task whose session ended without the file on
     * disk. Handing the target over is what makes a phase's honesty the
     * document rather than the agent's word for it.
     */
    it("hands over the document the phase must produce", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.target).toBe("specs/one/design.md");
    });

    /*
     * A typed message (`verbatim`) drops the phase's own attachments -
     * the text is the whole instruction - but not the files a person
     * attached to it in the compose box: those are part of what was typed.
     */
    it("sends files attached in the compose box, even on a typed message", async () => {

        const { host: fake, calls } = host();
        const picked = { name: "README.md", path: "C:/repo/docs/README.md" };

        await phase({ prompt: "look", verbatim: true, sentFiles: [picked] }, fake, wrote("specs/one/design.md"));
        await phase({ sentFiles: [picked] }, fake, wrote("specs/one/design.md"));
        await phase({ prompt: "look", verbatim: true }, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.attachments).toEqual([picked]);
        expect(calls[1].task.args?.attachments).toEqual([
            { name: "requirements", path: "C:/repo/specs/one/requirements.md" }, picked]);
        expect(calls[2].task.args).not.toHaveProperty("attachments");
    });

    it("hands over the files a wave works on, and none when it names none", async () => {

        const { host: fake, calls } = host();

        await phase({ files: ["src/api/users.ts"] }, fake, wrote("specs/one/design.md"));
        await phase({ files: [] }, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.files).toEqual(["src/api/users.ts"]);
        expect(calls[1].task.args).not.toHaveProperty("files");
    });

    it("names the first document when a phase writes several", async () => {

        const many = request({ targets: ["specs/one/plan.md", "specs/one/research.md"] });
        const { host: fake, calls } = host();

        await phase({ request: many }, fake, wrote("specs/one/plan.md", "specs/one/research.md"));

        expect(calls[0].task.args?.target).toBe("specs/one/plan.md");
    });

    it("runs in the repository, since every path in the prompt is relative to it", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].context).toMatchObject({ cwd: "C:/repo", root: "C:/repo", workspace: "C:/repo" });
    });

    /*
     * No walker, no TaskRunner, no workflow model. Reaching PluginHost
     * through a stage-with-a-job-with-a-task would add a job named
     * `write` to every phase.
     */
    it("builds one task and calls the host once", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls).toHaveLength(1);
        expect(calls[0].task.needs).toEqual([]);
    });

    /* A phase is always waited for: its document is checked when the turn ends. */
    it("never tells the plugin not to wait", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).not.toHaveProperty("detach");
    });
});

describe("what the phase left behind", () => {

    it("succeeds when the document is there", async () => {

        const outcome = await phase({}, host().host, wrote("specs/one/design.md"));

        expect(outcome).toEqual({ success: true, written: ["specs/one/design.md"], missing: [] });
    });

    /*
     * Checked against the disk rather than taken from the result,
     * because the two can disagree - and a session that talked itself
     * out of the work reports success from here.
     */
    it("fails a phase that reported success and wrote nothing", async () => {

        const outcome = await phase({}, host().host, wrote());

        expect(outcome.success).toBe(false);
        expect(outcome.missing).toEqual(["specs/one/design.md"]);
        expect(outcome.message).toMatch(/reported success without writing 'specs\/one\/design.md'/);
    });

    /*
     * The chat says a missing document in its thread before its turn
     * ends, so the check it is handed must name the document - and say
     * nothing when the document is there.
     */
    it("hands the chat a check that names a missing document, and nothing when it is there", async () => {

        const said: (string | undefined)[] = [];

        for (const exists of [wrote(), wrote("specs/one/design.md")])
            await runPhase(
                {
                    request: request(),
                    workspace: "C:/repo",
                    via: async (_call, check) => {

                        said.push(check({ success: true }));

                        return { success: true };
                    }
                },
                exists);

        expect(said[0]).toMatch(/reported success without writing 'specs\/one\/design.md'/);
        expect(said[1]).toBeUndefined();
    });

    /*
     * A verbatim turn is the compose box: the typed text is the whole
     * instruction, so `callPlugin` does not send the target and the
     * agent is never told to write it. "Record the approval" correctly
     * writes nothing, and failing it for that would make the box
     * unusable for everything except drafting. The document is still
     * reported, so a caller that cares can look.
     */
    it("does not hold a verbatim turn to a document nobody asked it for", async () => {

        const outcome = await phase({ verbatim: true }, host().host, wrote());

        expect(outcome.success).toBe(true);
        expect(outcome.missing).toEqual(["specs/one/design.md"]);
        expect(outcome.message).toBeUndefined();
    });

    it("fails when the plugin failed, whatever is on disk", async () => {

        const { host: fake } = host({ success: false });
        const outcome = await phase({}, fake, wrote("specs/one/design.md"));

        expect(outcome.success).toBe(false);
        expect(outcome.written).toEqual(["specs/one/design.md"]);
        expect(outcome.message).toMatch(/did not complete/);
    });

    it("says so when the phase ran out of time, rather than blaming the phase", async () => {

        const { host: fake } = host({ success: false, timedOut: true });
        const outcome = await phase({}, fake, wrote());

        expect(outcome.message).toMatch(/hit its time limit/);
    });

    /*
     * A phase held to account for a page it was right not to write is
     * a phase that always writes it - so only the declared target
     * gates the outcome. A companion the work called for is neither
     * demanded nor claimed here; it reaches later phases by existing.
     */
    it("is held to its declared target and nothing else it wrote", async () => {

        const one = request({ targets: ["specs/one/plan.md"] });

        const outcome = await phase(
            { request: one }, host().host,
            wrote("specs/one/plan.md", "specs/one/research.md"));

        expect(outcome).toEqual({ success: true, written: ["specs/one/plan.md"], missing: [] });
    });
});

describe("cancellation and output", () => {

    it("passes the run's output and kill hooks straight through", async () => {

        const onOutput = vi.fn();
        const registerKill = vi.fn();
        const { host: fake, calls } = host();

        await runCall(CALL, { ...AT, onOutput, registerKill, isCancelled: () => true }, fake);

        calls[0].context.onOutput("hello", "stdout");
        calls[0].context.registerKill(() => { });

        expect(onOutput).toHaveBeenCalledWith("hello", "stdout");
        expect(registerKill).toHaveBeenCalled();
        expect(calls[0].context.isCancelled?.()).toBe(true);
    });

    it("supplies no-ops when a caller wires nothing", async () => {

        const { host: fake, calls } = host();

        await runCall(CALL, AT, fake);

        expect(() => calls[0].context.onOutput("x", "system")).not.toThrow();
        expect(() => calls[0].context.registerKill(() => { })).not.toThrow();
    });
});

/*
 * How the documents actually reach the session. The plugin takes
 * context as content under a name, resolved from a file input by the
 * host - so this is the seam where "the documents in your context"
 * stops being a phrase in a prompt and becomes something the agent has.
 */
describe("handing the files over", () => {

    it("passes them to the plugin as attachments, not as inlined context", async () => {

        const withFiles = request({
            attachments: [
                { name: "grammar", path: "/app/styles/custom/instructions/grammar.md" },
                { name: "requirements", path: "C:/repo/specs/one/requirements.md" }
            ]
        });

        const { host: fake, calls } = host();

        await phase({ request: withFiles }, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.attachments).toEqual(withFiles.attachments);
        expect(calls[0].task.args).not.toHaveProperty("context");
    });

    /*
     * An instruction file ships with Eesha Code, nowhere near the
     * repository - which is why these are attachments rather than
     * context documents resolved from the workspace.
     */
    it("carries a path from outside the working directory unchanged", async () => {

        const outside = request({ attachments: [{ name: "grammar", path: "/app/styles/custom/instructions/grammar.md" }] });
        const { host: fake, calls } = host();

        await phase({ request: outside }, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.attachments).toEqual([{ name: "grammar", path: "/app/styles/custom/instructions/grammar.md" }]);
    });

    it("sends no attachments key at all when there is nothing to attach", async () => {

        const { host: fake, calls } = host();

        await phase({ request: request({ attachments: [] }) }, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).not.toHaveProperty("attachments");
    });

    /*
     * A chat history names a session by its opening text and truncates
     * from the right. A spec-first title would make every session of one spec share
     * a prefix and the only distinguishing word was the one cut off.
     */
    it("titles the session phase first, then the spec", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.title).toBe("design - one");
    });

    /*
     * A message typed into a conversation already going is sent as
     * typed. The title, the attachments and the target paragraph belong
     * to the phase's opening turn; the person said what they meant.
     */
    it("sends a verbatim continue as typed - no title, attachments or target", async () => {

        const { host: fake, calls } = host();

        await phase(
            { prompt: "tighten section 2", continueSession: "chat-1", keep: true, verbatim: true },
            fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).toMatchObject(
            { prompt: { literal: "tighten section 2" }, verbatim: true, continueSession: "chat-1", keep: true });
        expect(calls[0].task.args).not.toHaveProperty("title");
        expect(calls[0].task.args).not.toHaveProperty("attachments");
        expect(calls[0].task.args).not.toHaveProperty("target");
    });

    /*
     * A hand-over to another runtime carries a typed message. The panel
     * sends it with no targets, so the new runtime keeps its title and
     * attachments but is never told to write the document - and a
     * question is not failed for leaving the file alone.
     */
    it("sends no target and requires no file when the request names none", async () => {

        const { host: fake, calls } = host();

        const outcome = await phase(
            { prompt: "## Handed over\n\nwhy two stories?", keep: true, request: request({ targets: [] }) },
            fake, wrote());

        expect(calls[0].task.args).toHaveProperty("title");
        expect(calls[0].task.args).toHaveProperty("attachments");
        expect(calls[0].task.args).not.toHaveProperty("target");
        expect(outcome.success).toBe(true);
    });

    it("sends no verbatim flag on an ordinary phase run", async () => {

        const { host: fake, calls } = host();

        await phase({}, fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).not.toHaveProperty("verbatim");
    });
});

/*
 * The id arrives as the conversation opens and is the only chance to
 * learn it - reading it back from the store afterwards would race the
 * write it depends on. It is what lets a user reopen the chat that
 * drafted a document and see how it got there.
 */
describe("the session it opened", () => {

    it("reports the id the plugin gave back", async () => {

        const { host: fake } = host({ session: { id: "chat-42" } });

        const outcome = await phase({}, fake, wrote("specs/one/design.md"));

        expect(outcome.sessionId).toBe("chat-42");
    });

    /* The conversation behind a failure is the one most worth reopening. */
    it("reports it for a failed phase too", async () => {

        const { host: fake } = host({ success: false, session: { id: "chat-43" } });

        const outcome = await phase({}, fake, wrote());

        expect(outcome.success).toBe(false);
        expect(outcome.sessionId).toBe("chat-43");
    });

    it("reports it when the phase wrote nothing but claimed success", async () => {

        const { host: fake } = host({ session: { id: "chat-44" } });

        expect((await phase({}, fake, wrote())).sessionId).toBe("chat-44");
    });

    /*
     * Sooner than the outcome, and that is the whole point of the hook:
     * a drafting phase is minutes of an agent working, so the button
     * that opens its chat has to exist while it is working rather than
     * once the document has landed.
     */
    it("hands the id over as the plugin opens the conversation, not when the phase ends", async () => {

        const seen: string[] = [];
        let reportedBeforeReturn = false;

        const fake = {
            execute: async (_task: Task, context: TaskExecutionContext) => {

                context.onSession?.("chat-45");
                reportedBeforeReturn = seen.length === 1;

                return { success: true, session: { id: "chat-45" } } as TaskResult;
            }
        } as unknown as PluginHost;

        const result = await runCall(CALL, { ...AT, onSession: id => void seen.push(id) }, fake);

        expect(seen).toEqual(["chat-45"]);
        expect(reportedBeforeReturn).toBe(true);
        expect(result.sessionId).toBe("chat-45");
    });

    it("leaves it absent when the plugin reported none", async () => {

        const outcome = await phase({}, host().host, wrote("specs/one/design.md"));

        expect(outcome.sessionId).toBeUndefined();
    });
});

/*
 * What a surface's Stop can actually pull. PluginHost hands the
 * plugin's cancel handlers (ai@1's AbortController) to
 * context.registerCancel - never to registerKill, which is the
 * sandbox's process-kill channel an in-process ai task never fills.
 * runCall therefore routes BOTH into the caller's one kill hook, and
 * this is the pin: lose either registration and Stop goes back to
 * being a flag nothing polls.
 */
describe("stopping a phase", () => {

    it("routes the plugin's cancel handlers into the caller's kill hook", async () => {

        const pulled: string[] = [];

        const fake = {
            execute: async (_task: Task, context: TaskExecutionContext) => {

                context.registerCancel?.(() => pulled.push("cancelled"));
                context.registerKill(() => pulled.push("killed"));

                return { success: true } as TaskResult;
            }
        } as unknown as PluginHost;

        const stops: (() => void)[] = [];

        await runCall(CALL, { ...AT, registerKill: kill => { stops.push(kill); } }, fake);

        // Both mechanisms land in the hook - the cancel bundle and the
        // process kill - and pulling them stops the agent both ways.
        expect(stops).toHaveLength(2);

        for (const stop of stops)
            stop();

        expect(pulled).toContain("cancelled");
        expect(pulled).toContain("killed");
    });
});

/*
 * A chat gone back to an earlier message sends a note in front of what
 * the person typed; `shown` is what the thread shows instead. Wrapped
 * like the prompt, so neither is read as a template.
 */
describe("shown", () => {

    const call = {
        session: "chat", prompt: "## Earlier in this chat\n\n...\n\n## My message\n\nUse ${{ port }}.", attachments: [],
        title: "chat", ai: { uses: "ai@1", args: {} }
    };

    it("goes with a verbatim send, as written", async () => {

        const { host: fake, calls } = host();

        await runSession({ ...call, verbatim: true, shown: "Use ${{ port }}." }, { specId: "chat:1", workspace: "C:/repo", runId: "r1" }, fake);

        expect(calls[0].task.args).toMatchObject({ shown: { literal: "Use ${{ port }}." }, verbatim: true });
    });

    it("is dropped from a composed send, which has no typed text to show", async () => {

        const { host: fake, calls } = host();

        await runSession({ ...call, shown: "Use ${{ port }}." }, { specId: "chat:1", workspace: "C:/repo", runId: "r1" }, fake);

        expect(calls[0].task.args).not.toHaveProperty("shown");
    });
});
