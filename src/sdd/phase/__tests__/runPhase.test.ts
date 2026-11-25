import { describe, expect, it, vi } from "vitest";
import { PluginHost, TaskExecutionContext, TaskResult } from "../../../core/plugins/PluginHost";
import { Task } from "../../../core/models/task";
import { PhaseRequest } from "../assemble";
import { runPhase, runSession, startSession } from "../runPhase";

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

function input(over = {}) {

    return { request: request(), specId: "specs/one", workspace: "C:/repo", runId: "r1", ...over };
}

const wrote = (...paths: string[]) => (path: string) => paths.includes(path);

describe("the call it makes", () => {

    it("runs the plugin the config named, with the args it resolved", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.plugin).toBe("ai@1");
        expect(calls[0].task.args).toMatchObject({ model: "auto", prompt: { literal: "WRITE THE DESIGN" } });
    });

    it("sends no standing instructions for a style with no intro", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

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

        await runPhase(
            input({ prompt: "The task reads ${{ params.repo }}.", verbatim: true }),
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

        await runPhase(input(), fake, wrote("specs/one/design.md"));

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

        await runPhase(input({ prompt: "look", verbatim: true, sentFiles: [picked] }), fake, wrote("specs/one/design.md"));
        await runPhase(input({ sentFiles: [picked] }), fake, wrote("specs/one/design.md"));
        await runPhase(input({ prompt: "look", verbatim: true }), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.attachments).toEqual([picked]);
        expect(calls[1].task.args?.attachments).toEqual([
            { name: "requirements", path: "C:/repo/specs/one/requirements.md" }, picked]);
        expect(calls[2].task.args).not.toHaveProperty("attachments");
    });

    it("hands over the files a wave works on, and none when it names none", async () => {

        const { host: fake, calls } = host();

        await runPhase(input({ files: ["src/api/users.ts"] }), fake, wrote("specs/one/design.md"));
        await runPhase(input({ files: [] }), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.files).toEqual(["src/api/users.ts"]);
        expect(calls[1].task.args).not.toHaveProperty("files");
    });

    it("names the first document when a phase writes several", async () => {

        const many = request({ targets: ["specs/one/plan.md", "specs/one/research.md"] });
        const { host: fake, calls } = host();

        await runPhase(input({ request: many }), fake, wrote("specs/one/plan.md", "specs/one/research.md"));

        expect(calls[0].task.args?.target).toBe("specs/one/plan.md");
    });

    it("runs in the repository, since every path in the prompt is relative to it", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(calls[0].context).toMatchObject({ cwd: "C:/repo", root: "C:/repo", workspace: "C:/repo" });
    });

    /*
     * No walker, no TaskRunner, no workflow model. Reaching PluginHost
     * through a stage-with-a-job-with-a-task would add a job named
     * `write` to every phase.
     */
    it("builds one task and calls the host once", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(calls).toHaveLength(1);
        expect(calls[0].task.needs).toEqual([]);
    });
});

describe("what the phase left behind", () => {

    it("succeeds when the document is there", async () => {

        const outcome = await runPhase(input(), host().host, wrote("specs/one/design.md"));

        expect(outcome).toEqual({ success: true, written: ["specs/one/design.md"], missing: [] });
    });

    /*
     * Checked against the disk rather than taken from the result,
     * because the two can disagree - and a session that talked itself
     * out of the work reports success from here.
     */
    it("fails a phase that reported success and wrote nothing", async () => {

        const outcome = await runPhase(input(), host().host, wrote());

        expect(outcome.success).toBe(false);
        expect(outcome.missing).toEqual(["specs/one/design.md"]);
        expect(outcome.message).toMatch(/reported success without writing 'specs\/one\/design.md'/);
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

        const outcome = await runPhase(input({ verbatim: true }), host().host, wrote());

        expect(outcome.success).toBe(true);
        expect(outcome.missing).toEqual(["specs/one/design.md"]);
        expect(outcome.message).toBeUndefined();
    });

    it("fails when the plugin failed, whatever is on disk", async () => {

        const { host: fake } = host({ success: false });
        const outcome = await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(outcome.success).toBe(false);
        expect(outcome.written).toEqual(["specs/one/design.md"]);
        expect(outcome.message).toMatch(/did not complete/);
    });

    it("says so when the phase ran out of time, rather than blaming the phase", async () => {

        const { host: fake } = host({ success: false, timedOut: true });
        const outcome = await runPhase(input(), fake, wrote());

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

        const outcome = await runPhase(
            input({ request: one }), host().host,
            wrote("specs/one/plan.md", "specs/one/research.md"));

        expect(outcome).toEqual({ success: true, written: ["specs/one/plan.md"], missing: [] });
    });
});

describe("cancellation and output", () => {

    it("passes the run's output and kill hooks straight through", async () => {

        const onOutput = vi.fn();
        const registerKill = vi.fn();
        const { host: fake, calls } = host();

        await runPhase(
            input({ onOutput, registerKill, isCancelled: () => true }),
            fake, wrote("specs/one/design.md"));

        calls[0].context.onOutput("hello", "stdout");
        calls[0].context.registerKill(() => { });

        expect(onOutput).toHaveBeenCalledWith("hello", "stdout");
        expect(registerKill).toHaveBeenCalled();
        expect(calls[0].context.isCancelled?.()).toBe(true);
    });

    it("supplies no-ops when a caller wires nothing", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

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

        await runPhase(input({ request: withFiles }), fake, wrote("specs/one/design.md"));

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

        await runPhase(input({ request: outside }), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.attachments).toEqual([{ name: "grammar", path: "/app/styles/custom/instructions/grammar.md" }]);
    });

    it("sends no attachments key at all when there is nothing to attach", async () => {

        const { host: fake, calls } = host();

        await runPhase(input({ request: request({ attachments: [] }) }), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).not.toHaveProperty("attachments");
    });

    /*
     * A chat history names a session by its opening text and truncates
     * from the right. A spec-first title would make every session of one spec share
     * a prefix and the only distinguishing word was the one cut off.
     */
    it("titles the session phase first, then the spec", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args?.title).toBe("design - one");
    });

    /*
     * A message typed into a conversation already going is sent as
     * typed. The title, the attachments and the target paragraph belong
     * to the phase's opening turn; the person said what they meant.
     */
    it("sends a verbatim continue as typed - no title, attachments or target", async () => {

        const { host: fake, calls } = host();

        await runPhase(
            input({ prompt: "tighten section 2", continueSession: "chat-1", keep: true, verbatim: true }),
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

        const outcome = await runPhase(
            { ...input({ prompt: "## Handed over\n\nwhy two stories?", keep: true }), request: request({ targets: [] }) },
            fake, wrote());

        expect(calls[0].task.args).toHaveProperty("title");
        expect(calls[0].task.args).toHaveProperty("attachments");
        expect(calls[0].task.args).not.toHaveProperty("target");
        expect(outcome.success).toBe(true);
    });

    it("sends no verbatim flag on an ordinary phase run", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

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

        const outcome = await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(outcome.sessionId).toBe("chat-42");
    });

    /* The conversation behind a failure is the one most worth reopening. */
    it("reports it for a failed phase too", async () => {

        const { host: fake } = host({ success: false, session: { id: "chat-43" } });

        const outcome = await runPhase(input(), fake, wrote());

        expect(outcome.success).toBe(false);
        expect(outcome.sessionId).toBe("chat-43");
    });

    it("reports it when the phase wrote nothing but claimed success", async () => {

        const { host: fake } = host({ session: { id: "chat-44" } });

        expect((await runPhase(input(), fake, wrote())).sessionId).toBe("chat-44");
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

        const outcome = await runPhase(
            input({ onSession: (id: string) => void seen.push(id) }),
            fake, wrote("specs/one/design.md"));

        expect(seen).toEqual(["chat-45"]);
        expect(reportedBeforeReturn).toBe(true);
        expect(outcome.sessionId).toBe("chat-45");
    });

    it("carries the id back from a detached start too, which is the whole point of one", async () => {

        const { host: fake } = host({ session: { id: "chat-46" } });

        const outcome = await runPhase(
            input({ detach: true }), fake, wrote());

        expect(outcome.sessionId).toBe("chat-46");
    });

    it("leaves it absent when the plugin reported none", async () => {

        const outcome = await runPhase(input(), host().host, wrote("specs/one/design.md"));

        expect(outcome.sessionId).toBeUndefined();
    });
});

/*
 * The two kinds of start, and the one field between them.
 *
 * These are one function with one field between them, not two functions built by copy: a phase builder wires the transcript, the session id, the kill hook and cancellation, and a copy for the sessions nobody waits on would wire none of them. Nothing else would keep the two in step.
 */
describe("starting without waiting", () => {

    it("tells the plugin not to wait", async () => {

        const { host: fake, calls } = host();

        await runPhase(input({ detach: true }), fake, wrote());

        expect(calls[0].task.args?.detach).toBe(true);
    });

    it("says nothing about detaching when the phase is waited for", async () => {

        const { host: fake, calls } = host();

        await runPhase(input(), fake, wrote("specs/one/design.md"));

        expect(calls[0].task.args).not.toHaveProperty("detach");
    });

    /*
     * A target the task will never check is a promise the task does not
     * keep. Where the document goes is in the prompt either way.
     */
    it("names no target, because nothing is going to verify one", async () => {

        const { host: fake, calls } = host();

        await runPhase(input({ detach: true }), fake, wrote());

        expect(calls[0].task.args).not.toHaveProperty("target");
    });

    /* The task returned when the prompt landed. Nothing has happened yet. */
    it("succeeds with the document unwritten, which is what has not happened yet means", async () => {

        const outcome = await runPhase(input({ detach: true }), host().host, wrote());

        expect(outcome).toEqual({ success: true, written: [], missing: [], sessionId: undefined });
    });

    it("reports a start that failed against the phase it was starting", async () => {

        const { host: fake } = host({ success: false });

        const outcome = await runPhase(input({ detach: true }), fake, wrote());

        expect(outcome.success).toBe(false);
        expect(outcome.message).toMatch(/Could not start the design conversation/);
    });

    /*
     * The anti-drift assertion: whatever a caller with no stage sends,
     * a phase sends the same way. If these two ever diverge, it shows
     * up here first.
     */
    it("builds the same call as a caller that has no stage to build a request from", async () => {

        const viaPhase = host();
        const viaPrimitives = host();

        await runPhase(
            input({ detach: true, prompt: "TALK TO THEM" }),
            viaPhase.host, wrote());

        await startSession(
            {
                session: "design",
                prompt: "TALK TO THEM",
                system: undefined,
                attachments: [{ name: "requirements", path: "C:/repo/specs/one/requirements.md" }],
                title: "design - one",
                ai: { uses: "ai@1", args: { model: "auto" } }
            },
            { specId: "specs/one", workspace: "C:/repo", runId: "r1" },
            viaPrimitives.host);

        expect(viaPhase.calls[0].task).toEqual(viaPrimitives.calls[0].task);
        expect(viaPhase.calls[0].context.cwd).toBe(viaPrimitives.calls[0].context.cwd);
        expect(viaPhase.calls[0].context.ownerId).toBe(viaPrimitives.calls[0].context.ownerId);
    });

    it("hands a detached start the same cancellation hooks a waited one gets", async () => {

        const registerKill = vi.fn();
        const { host: fake, calls } = host();

        await runPhase(
            input({ detach: true, registerKill, isCancelled: () => true }),
            fake, wrote());

        calls[0].context.registerKill(() => { });

        expect(registerKill).toHaveBeenCalled();
        expect(calls[0].context.isCancelled?.()).toBe(true);
    });
});

/*
 * What a surface's Stop can actually pull. PluginHost hands the
 * plugin's cancel handlers (ai@1's AbortController) to
 * context.registerCancel - never to registerKill, which is the
 * sandbox's process-kill channel an in-process ai task never fills.
 * runPhase therefore routes BOTH into the caller's one kill hook, and
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

        await runPhase(
            input({ registerKill: (kill: () => void) => stops.push(kill) }),
            fake, wrote("specs/one/design.md"));

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
