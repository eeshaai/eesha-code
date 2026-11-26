import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { repoRoot, snapshot } from "../chat/turnSnapshot";
import { eeshaPath, readJson, writeAtomic } from "./paths";
import { EVAL_NAME, EVAL_TEXT_MAX, type EvalPick } from "./protocol";

/*
 * The Evaluator's files. One evaluation sends the same message to a few
 * variants - a runtime and a model each - and shows them side by side.
 *
 *   ~/.eesha/evals/<name>/eval.json      what the evaluation is: its folder,
 *                                        where it started from, its variants
 *   ~/.eesha/evals/<name>/state.json     its variants' saved picks
 *   ~/.eesha/evals/<name>/copies/<v>/    one variant's own copy of the folder
 *   ~/.eesha/evals/<name>/scratch/<v>/   one variant's uploads and notes
 *
 * Nothing of an evaluation is in `sessions/`, `state.json` or the
 * no-workspace `events/` folder, so no session list, search or start
 * page ever shows a variant.
 *
 * A variant works in its own copy. For a folder in a git repository the
 * copy is a new repository with no remote, started from a commit that
 * holds the folder as it was when the evaluation was made - tracked
 * files as they were on disk, and untracked ones git does not ignore.
 * The source repository keeps that commit under
 * `refs/eesha/evals/<name>`, so a variant added later starts from the
 * same files. For a folder not in git the copy is a plain file copy.
 */

/** One variant: a runtime and a model, working in its own copy. */
export interface EvalVariant {

    /** Unique in the evaluation. Also the name of its copy's folder. */
    name: string;

    /** The variant's session. Never listed with the normal sessions. */
    chatId: string;

    /** The runtime it runs on. */
    provider: string;

    /** The model, when one was picked. Absent: the runtime's own default. */
    model?: string;

    /** The agent's own mode, when one was picked. */
    mode?: string;

    /** How hard the model thinks, when it was picked. */
    effort?: string;

    /** Text sent to this variant only, under the message to all. */
    extra?: string;

    /** Written when its one message was sent: when, and the runtime's version then, when it said. */
    ran?: { at: number; version?: string };

    /** The folder the agent works in: inside the variant's copy. */
    folder: string;

    addedAt: number;
}

/** What is saved for one evaluation. */
export interface SavedEval {

    name: string;

    /** The folder the person picked. Every variant starts from a copy of it. */
    folder: string;

    createdAt: number;

    /** Set for a folder in git: the commit every copy starts from, kept in the source repository under `ref`. */
    start?: { commit: string; ref: string; root: string };

    variants: EvalVariant[];

    /**
     * The message to all, as typed when the evaluation was made, the
     * saved task it came from, and that task's closing lines as they were
     * then ("" for a task with no kind). Every variant gets exactly this -
     * one added later too, whatever became of the task file since.
     * Evaluations made before it was typed there have it from their first
     * send, or not at all. Older ones have no `closing`: their task's
     * lines are read from the task when they send.
     */
    sent?: { text: string; task?: string; closing?: string; at: number };

    /** The person's own pick and note. The Evaluator never picks. */
    pick?: EvalPick;
}

/** Whether a value is an evaluation's or a variant's name - see `EVAL_NAME`. The page sends it, so it is checked. */
export function isEvalName(value: unknown): value is string {

    return typeof value === "string" && EVAL_NAME.test(value);
}

/** `~/.eesha/evals/<name>`. */
export function evalDir(name: string): string {

    return eeshaPath("evals", name);
}

function evalFile(name: string): string {

    return path.join(evalDir(name), "eval.json");
}

/** Where an evaluation keeps its variants' saved picks. */
export function evalStateFile(name: string): string {

    return path.join(evalDir(name), "state.json");
}

/** One variant's own copy of the folder's repository (or of the folder, outside git). */
export function evalCopyDir(name: string, variant: string): string {

    return path.join(evalDir(name), "copies", variant);
}

/** One variant's scratch folder: uploads and handover notes. */
export function evalScratchDir(name: string, variant: string): string {

    return path.join(evalDir(name), "scratch", variant);
}

function variantOf(value: unknown): EvalVariant | undefined {

    // `own`: a text older evaluations sent in place of the message to all. It is read as the variant's own text now, under the message to all.
    const one = value as (Partial<EvalVariant> & { own?: unknown }) | null | undefined;

    if (!one || !isEvalName(one.name) || typeof one.chatId !== "string" || !one.chatId
        || typeof one.provider !== "string" || !one.provider
        || typeof one.folder !== "string" || !path.isAbsolute(one.folder))
        return undefined;

    const extra = [one.own, one.extra].filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n\n");

    return {
        name: one.name,
        chatId: one.chatId,
        provider: one.provider,
        ...(typeof one.model === "string" && one.model ? { model: one.model } : {}),
        ...(typeof one.mode === "string" && one.mode ? { mode: one.mode } : {}),
        ...(typeof one.effort === "string" && one.effort ? { effort: one.effort } : {}),
        ...(extra ? { extra: extra.slice(0, EVAL_TEXT_MAX) } : {}),
        ...(one.ran && typeof one.ran.at === "number"
            ? { ran: { at: one.ran.at, ...(typeof one.ran.version === "string" && one.ran.version ? { version: one.ran.version.slice(0, 80) } : {}) } }
            : {}),
        folder: one.folder,
        addedAt: typeof one.addedAt === "number" ? one.addedAt : 0
    };
}

/** One evaluation as saved. Nothing when it has no file, or one that is not an evaluation's. */
export function readEval(name: string): SavedEval | undefined {

    if (!isEvalName(name))
        return undefined;

    const saved = readJson(evalFile(name)) as Partial<SavedEval> | undefined;

    if (!saved || saved.name !== name || typeof saved.folder !== "string" || !path.isAbsolute(saved.folder) || !Array.isArray(saved.variants))
        return undefined;

    const start = saved.start as SavedEval["start"] | undefined;
    const variants = saved.variants.map(variantOf).filter((one): one is EvalVariant => one !== undefined);
    const pick = saved.pick as Partial<EvalPick> | undefined;
    const sent = saved.sent as Partial<NonNullable<SavedEval["sent"]>> | undefined;

    return {
        name,
        folder: saved.folder,
        createdAt: typeof saved.createdAt === "number" ? saved.createdAt : 0,
        ...(start && typeof start.commit === "string" && typeof start.ref === "string" && typeof start.root === "string" ? { start } : {}),
        variants,
        ...(sent && typeof sent.text === "string"
            ? {
                sent: {
                    text: sent.text,
                    ...(typeof sent.task === "string" && sent.task ? { task: sent.task } : {}),
                    ...(typeof sent.closing === "string" ? { closing: sent.closing } : {}),
                    at: typeof sent.at === "number" ? sent.at : 0
                }
            }
            : {}),

        // A pick of a variant that is not there any more is kept as a note alone.
        ...(pick && typeof pick.note === "string"
            ? {
                pick: {
                    ...(typeof pick.variant === "string" && variants.some(one => one.name === pick.variant) ? { variant: pick.variant } : {}),
                    note: pick.note.slice(0, EVAL_TEXT_MAX),
                    at: typeof pick.at === "number" ? pick.at : 0
                }
            }
            : {})
    };
}

export function writeEval(saved: SavedEval): void {

    if (!isEvalName(saved.name))
        throw new Error(`Not an evaluation's name: ${saved.name}`);

    writeAtomic(evalFile(saved.name), JSON.stringify(saved, undefined, 2) + "\n");
}

/** Every evaluation's name, newest first. */
export function evalNames(): string[] {

    let names: string[];

    try {

        names = fs.readdirSync(eeshaPath("evals"));

    } catch {

        return [];
    }

    return names
        .map(name => readEval(name))
        .filter((one): one is SavedEval => one !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(one => one.name);
}

/** The evaluation and variant a session id belongs to. Nothing: not a variant's session. */
export function evalOfChat(chatId: string): { saved: SavedEval; variant: EvalVariant } | undefined {

    for (const name of evalNames()) {

        const saved = readEval(name);
        const variant = saved?.variants.find(one => one.chatId === chatId);

        if (saved && variant)
            return { saved, variant };
    }

    return undefined;
}

/**
 * What a variant's message is: the common message, then a blank line,
 * then the variant's own text (`extra`). Either can be empty; empty
 * both, nothing.
 */
export function variantMessage(common: string, variant: Pick<EvalVariant, "extra">): string {

    return [common.trim(), variant.extra?.trim() ?? ""].filter(part => part).join("\n\n");
}

/** The git settings that decide how a checkout writes files - copied from the source repository into each copy. */
const CHECKOUT_SETTINGS = ["core.autocrlf", "core.eol", "core.longpaths"];

/** Git's own questions are never asked: a command that would wait for a password fails instead. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

/** Who the starting commit is by. It is ours, never pushed, so it does not need the person's own name. */
const AUTHOR_ENV = {
    GIT_AUTHOR_NAME: "Eesha Code",
    GIT_AUTHOR_EMAIL: "evaluator@eesha.invalid",
    GIT_COMMITTER_NAME: "Eesha Code",
    GIT_COMMITTER_EMAIL: "evaluator@eesha.invalid"
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {

    return new Promise((resolve, reject) => {

        execFile("git", args, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {

            if (error)
                reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`));
            else
                resolve(stdout);
        });
    });
}

/**
 * Saves the folder's repository as it is now as a commit, kept in that
 * repository under `refs/eesha/evals/<name>`. The branch, the index and
 * the working files are not touched. Nothing when the folder is not in
 * a git repository.
 */
export async function saveStart(name: string, folder: string): Promise<SavedEval["start"] | undefined> {

    const root = await repoRoot(folder);

    if (!root)
        return undefined;

    const tree = await snapshot(root);

    // A repository with no commit yet has no parent to name.
    const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(text => text.trim(), () => "");

    const commit = (await git(
        root,
        ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `Evaluation ${name}: where its variants start`],
        AUTHOR_ENV)).trim();

    const ref = `refs/eesha/evals/${name}`;

    await git(root, ["update-ref", ref, commit]);

    return { commit, ref, root };
}

/**
 * Copies a folder not in git, every file. On Windows robocopy does it,
 * several files at a time - more than twice as fast as Node's copy on a
 * folder of a few hundred files. Links stay links, as Node's copy keeps them.
 */
function copyFolder(from: string, to: string): Promise<void> {

    if (process.platform !== "win32")
        return fs.promises.cp(from, to, { recursive: true });

    return new Promise((resolve, reject) => {

        execFile("robocopy", [from, to, "/E", "/MT:16", "/SL", "/SJ", "/R:0", "/W:0", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {

            // Robocopy's codes 0 to 7 all mean the copy is done; 8 and up mean some files were not copied.
            const code = error && typeof error.code === "number" ? error.code : error ? 16 : 0;

            if (code >= 8)
                reject(new Error(`robocopy could not copy the folder (code ${code}). ${String(stdout).trim().slice(0, 600)}`));
            else
                resolve();
        });
    });
}

/**
 * Makes one variant's copy and says which folder in it the agent works
 * in. In git: a new repository at `target` holding the starting commit
 * alone - no older history, so it is quick to make - checked out on a
 * branch named `evaluation`, with no remote - so the variant can neither
 * push nor touch the source repository's branches. The agent works in
 * the same folder of the copy as the one picked in the source. Outside
 * git: a plain copy of the folder.
 */
export async function makeCopy(saved: Pick<SavedEval, "folder" | "start">, target: string): Promise<string> {

    if (fs.existsSync(target))
        throw new Error(`${target} is there already.`);

    fs.mkdirSync(path.dirname(target), { recursive: true });

    const start = saved.start;

    if (!start) {

        await copyFolder(saved.folder, target);

        return target;
    }

    fs.mkdirSync(target);

    await git(target, ["init", "--quiet"]);

    // The source repository's own settings for how files are written to
    // disk: without them the copy would use this machine's defaults, and
    // every file could come out with other line endings than the source has.
    for (const key of CHECKOUT_SETTINGS) {

        const value = await git(start.root, ["config", "--get", key]).then(text => text.trim(), () => "");

        if (value)
            await git(target, ["config", key, value]);
    }

    // By path, so no remote is ever written into the copy. The starting
    // commit alone, without the history before it.
    await git(target, ["fetch", "--quiet", "--no-tags", "--depth", "1", start.root, start.ref]);
    await git(target, ["checkout", "--quiet", "-b", "evaluation", "FETCH_HEAD"]);

    return path.join(target, path.relative(start.root, path.resolve(saved.folder)));
}

/** Takes the starting commit's name out of the source repository - its evaluation could not be made. */
export async function dropStart(start: SavedEval["start"]): Promise<void> {

    if (start)
        await git(start.root, ["update-ref", "-d", start.ref]).catch(() => undefined);
}
