import { LogLine, RunStatus } from "../models/run";
import { ParamValue } from "../models/workflowTypes";
import type { PluginUi } from "../plugins/Plugin";
import type { RunStamps } from "../templating/TemplateResolver";

/**
 * Where a run currently is, at task resolution.
 *
 * Job-level status alone can only say "this job is running" - it cannot
 * say *which task*, which is the one thing someone watching a pipeline
 * actually wants to know.
 */
export interface TaskStatusUpdate {

    /** Opaque, produced by the walker. */
    taskId: string;

    stage?: string;

    job?: string;

    /** The runnable unit this task belongs to - the task's own id (inline) or its job id (default engine). */
    ownerId?: string;

    taskIndex: number;

    name?: string;

    /** Set for a `uses:` task, so the store can record what ran. */
    plugin?: string;

    /** `manual` for a task that had to be approved. Recorded even when `auto`, because the audit trail is the product. */
    trigger?: "auto" | "manual";

    /** 1 on the first run; higher once `retries:` has given it another go. */
    attempt?: number;

    /** An external provider-owned conversation this task held - see `PluginResult.session`. */
    sessionId?: string;

    status: RunStatus;
}

/**
 * One run variable, with the task that produced it.
 *
 * The producing task travels with the value because a name on its own
 * does not say where it came from - `NOTES` is `${{ run.context.NOTES }}`
 * in a file, but which of six tasks wrote it is the thing someone
 * reading the run actually wants.
 *
 * The value is whatever `storedOutput` decided: a plugin declaring one
 * output stores it bare, anything else stores the whole map. That rule
 * lives in `runContext.ts` and is not re-derived anywhere that reads this.
 */
export interface RunOutput {

    value: unknown;

    /** The walker's task id - the same one statuses and logs are addressed to. */
    setByTask: string;
}

/**
 * The file-level context a run resolved - every value an expression
 * could read, for reading rather than for resolving.
 *
 * Not a scope in the sense the rest of the product uses that word:
 * `Scope` elsewhere says which of folder, workspace, profile or
 * built-in a file came from. This is what `${{ }}` resolved against.
 *
 * Deliberately *file* level. Vars and `cwd:` can be overridden by a job
 * and again by a task, so this is not what every expression in the run
 * saw - it is what the file declares, which is the one version that
 * exists before any job does. A surface showing it has to say so; see
 * the Data tab, which labels the section.
 *
 */
export interface RunContext {

    workspace: string;

    cwd: string;

    /**
     * The person's home directory - what `${{ home }}` resolves to.
     *
     * A directory like the other three, and listed beside them for the
     * same reason: a panel that answers "what was this run given" and
     * leaves out an anchor every expression in the file can read is
     * answering it wrong.
     */
    home: string;

    /** What the run was asked for before it started. Empty for a `tasks.yml`, which has no `params:`. */
    params: Record<string, ParamValue>;

    /**
     * The run's stamps - `${{ dateToday }}`, `${{ runId }}` and their
     * siblings, as this run resolved them. Absent when none were recorded.
     */
    stamps?: RunStamps;

    /**
     * The `variables` section of settings.json the run read, both
     * scopes merged and settled - what `${{ Team.Name }}` meant. Absent
     * when neither file declares any.
     */
    variables?: Record<string, unknown>;

    /** The file's own constants, resolved. NO SECRETS. */
    vars: Record<string, unknown>;

    /**
     * The env this file *declares* - its `env:` block plus whatever its
     * `dotenv:` files supplied. Masked. NO SECRETS.
     *
     * Deliberately **not** the machine's environment. `${{ env.NAME }}`
     * resolves against the process environment merged underneath this,
     * so what an expression can read is wider than what is here - but
     * putting every variable on the machine into a panel would be
     * putting every token on the machine into a screenshot.
     *
     * Masking is real but weak: `SecretMasker` redacts values a plugin
     * declared and read, and nothing else. A `.env` value nothing
     * declared appears as it is.
     */
    env: Record<string, string>;
}

/**
 * One task's *own* level, after its job's and its own declarations are
 * merged over the file's.
 *
 * The three things that actually differ per level. `params` and the
 * `workspaceFolder`/`workspaceConfig`/`home` anchors are fixed for the whole
 * run, so they stay on {@link RunContext} and are not repeated here.
 *
 * Worth reporting because the file-level answer can be plainly wrong for
 * a given task: a job declaring `vars: { target: staging }` over a
 * file-level `production` means every task in it read `staging`, and a
 * panel showing the file's value would disagree with the run.
 */
export interface TaskContext {

    /** What relative paths in this task mean - its own `cwd:`, or its job's, or the file's. */
    cwd: string;

    /** NO SECRETS. */
    vars: Record<string, unknown>;

    /** Declared env only, redacted by declared secret name - same terms as {@link RunContext.env}. */
    env: Record<string, string>;
}

/**
 * The origin `PluginHost.resolveInputs` records for an arg the task
 * itself wrote, as opposed to one a default filled in.
 *
 * Declared here, beside {@link GateRequest.origins}, because the panel
 * reads it back to decide which args to show - and the panel cannot
 * import the host itself without pulling Node's `fs` into a browser
 * bundle. A copy of the literal in the page could drift from the host.
 */
export const CALLER_ORIGIN = "caller (task args)";

export interface GateRequest {

    runId: string;

    /** Opaque, produced by the walker - what an approval is addressed to. */
    taskId: string;

    stage?: string;

    job?: string;

    /** The runnable unit this gate belongs to - see {@link TaskStatusUpdate.ownerId}. */
    ownerId?: string;

    taskIndex: number;

    name: string;

    /** The task this task runs, when it runs one. Absent for a `run:` task. */
    plugin?: string;

    /** The exact command line, or the plugin reference. NO SECRETS. */
    detail: string;

    /** Resolved `args:` for a `uses:` task. NO SECRETS. */
    args?: Record<string, unknown>;

    /**
     * The plugin's one long arg, resolved and promoted out of
     * {@link args} - see `TaskPreview.body`. NO SECRETS.
     *
     * Absent on a gate rebuilt after a restart: the task's row stores
     * the merged args and nothing about their shape, so a reopened
     * panel falls back to showing the plugin id and the flat list.
     */
    body?: { arg: string; text: string };

    /**
     * Where each resolved arg came from, keyed as {@link args} is - see
     * `PluginHost.resolveInputs`. Absent on a rebuilt gate, for the same
     * reason {@link body} is.
     */
    origins?: Record<string, string>;

    /**
     * Why the preview above is incomplete, when resolving it failed.
     *
     * Shown rather than swallowed: a gate that silently displays the raw
     * engine is asking for approval of something other than what will
     * run.
     */
    problem?: string;
}

export type GateDecision =
    | { approved: true }
    | { approved: false; reason?: string };

export interface ExecutionCallbacks {

    onLog(line: LogLine): void;

    /** Status of a whole runnable unit - a task (inline) or a job (default engine). What the tree rows and map stations are colored from. */
    onOwnerStatus(ownerId: string, status: RunStatus): void;

    /** Optional so the `tasks.yml` path is unaffected until it reports tasks too. */
    onTaskStatus?(update: TaskStatusUpdate): void;

    /**
     * Asks a human to approve a `trigger: manual` task, and does not
     * resolve until they answer.
     *
     * Optional on the interface, but its absence is **not** consent: an
     * executor with no approver attached rejects the gate rather than
     * running through it. A gate that quietly opens when nobody is
     * watching is worse than no gate, because the file still claims one.
     */
    onGate?(request: GateRequest): Promise<GateDecision>;

    /**
     * A task's `artifact:` landed in a run variable.
     *
     * Reported rather than kept only in memory: a run parked at a gate
     * holds nothing but its rows, and what earlier tasks produced is
     * half of what a human is deciding about.
     */
    onVariable?(name: string, value: unknown, setByTask: string): void;

    /**
     * What a task's `args:` came to, reported as the plugin receives them.
     *
     * The resolved values, never the templates: approving or reading
     * `${{ vars.target }}` tells nobody anything, and `deploy --to
     * production` does. Reported from the one place that resolves them
     * for real, so the page showing this cannot drift from what ran.
     *
     * Only for a `uses:` task that actually ran. A task skipped by its
     * `if:`, one that never resolved, and one never reached report
     * nothing - there is nothing that existed to report. NO SECRETS.
     *
     * `origins` says where each value came from (task args, a
     * settings.json default, the manifest), keyed by arg name. Live
     * only - it is not recorded, so a replayed run reports args with
     * no origins, and the page shows the value alone.
     */
    onTaskArgs?(taskId: string, args: Record<string, unknown>, origins?: Record<string, string>): void;

    /**
     * What one task's own level came to - see {@link TaskContext}.
     *
     * Reported from where the executor already resolves it, for the same
     * reason as `onTaskArgs`: a second resolution for display could
     * disagree with the one that ran.
     */
    onTaskContext?(taskId: string, scope: TaskContext): void;

    /**
     * A plugin handed back a tab for its step - see `PluginResult.ui`.
     * Reported once the task's last attempt has ended, masked like
     * args. Only for a plugin that returned one.
     */
    onTaskUi?(taskId: string, ui: PluginUi): void;

}
