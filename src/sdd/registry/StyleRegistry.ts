import * as path from "path";

import { ConfigTemplating } from "../../core/templating/configScope";
import { NativeTool, Preset, Style } from "../model/style";
import { parseStyle } from "../parser/parseStyle";
import { GRAMMAR_FILE } from "../phase/grammar";
import { Scope, Scopes, StyleFiles } from "./styleFiles";

/**
 * Which style a spec runs, and which prompt text each of its phases
 * gets, across the three scopes.
 *
 * A style lives in exactly one place - built-in, workspace or profile -
 * and every file of it comes from that one folder. An id found in two
 * places is an error, and neither copy runs until one is renamed or
 * removed.
 *
 * There is no shadowing, neither whole for `style.yml` nor per file for
 * the prompts. It would let a phase's text come from two owners, and
 * which copy ran would depend on folders nobody was looking at. A
 * built-in style is a sample to copy under a name of your own (Eject
 * Style does that), not something to override in place.
 */
export const STYLE_FILE = "style.yml";

export interface StyleSummary {

    id: string;

    /** Absent when the folders under this id hold no `style.yml` in any scope. */
    name?: string;

    desc?: string;

    /** Where the winning `style.yml` came from. */
    scope?: Scope;

    /** Where the style's folder was found - one scope, or every scope that holds the id when they clash. */
    prompts: Scope[];

    /** The tool whose own process the style runs - see `Style.native`. Absent for an Eesha style. */
    native?: NativeTool;

    /**
     * Whether an unanswered `## Open Questions` item stops the phase
     * after it - the style's own `blockOnOpenQuestions:`, which
     * defaults to true.
     *
     * Here rather than only on the parsed {@link Style} because the
     * panel already reads this list to name the style, and reading the
     * whole style again to learn one boolean would be a second parse
     * per refresh. Absent when the style did not load.
     */
    blockOnOpenQuestions?: boolean;

    /**
     * The style's own `presets:` - the starting sentences every
     * drafting phase's revise box offers, ahead of each stage's own.
     * Here for the same reason as `blockOnOpenQuestions`: the panel
     * already reads this list, and a stage's own list travels on the
     * stage, so this is the one piece the panel would otherwise need
     * a second parse for. Absent when the style declares none, or did
     * not load.
     */
    presets?: Preset[];

    /**
     * The style's own top-level `ai:` - what every stage of it starts
     * from. Here for the same reason as `presets`: the panel's picker
     * has to say where the runtime in effect came from, and a stage's
     * own `ai:` already travels on the stage. Absent when the style
     * declares none, or did not load.
     */
    ai?: Record<string, unknown>;

    /**
     * Why this style cannot be loaded, if it cannot.
     *
     * Carried rather than thrown so one unparseable folder does not
     * empty the picker - a broken style should be visible and named,
     * not missing.
     */
    error?: string;
}

/**
 * Where a resolved piece of text came from.
 *
 * `repo` is not a scope and never competes with one: it is a file the
 * repository owns, named by a stage's `instructions:`, and it replaces the
 * style's own `instructions/<id>.md` outright rather than shadowing it.
 */
export type PromptScope = Scope | "repo";

export interface ResolvedFile {

    text: string;

    /** Which scope's copy of the file this is. */
    scope: PromptScope;
}

export class StyleRegistry {

    /**
     * @param templating What `${{ }}` in a `style.yml` resolves against.
     * Omitted by a caller with no workspace - an in-memory registry in a
     * test - and then a style writing an expression is refused rather
     * than parsed with literal text in it.
     */
    constructor(
        private readonly files: StyleFiles,
        private readonly templating?: ConfigTemplating
    ) { }

    /**
     * The repository a style's paths are relative to, when there is one.
     *
     * Read by `assemble`, which finishes the `${{ spec.… }}` expressions
     * a style is parsed with left in place - those paths need the same
     * "inside the repository" rule the parser applies to the ones it
     * can settle. Exposed here because this is already the object that
     * knows, rather than threading a second copy of the workspace root
     * through `PhaseInput`.
     */
    get workspaceFolder(): string | undefined {

        return this.templating?.workspaceFolder;
    }

    /**
     * Every style on offer, across scopes and ordered by id.
     *
     * An id in two scopes is listed once, carrying the clash as its
     * error - named rather than dropped, so the picker says what is
     * wrong. Not logged here: this is read on every save, and the spec
     * list already reports a style's error once per message.
     */
    async list(): Promise<StyleSummary[]> {

        const found = new Map<string, Scope[]>();

        for (const scope of Scopes)
            for (const id of await this.files.styles(scope))
                found.set(id, [...(found.get(id) ?? []), scope]);

        const summaries = await Promise.all(
            [...found.entries()].map(([id, scopes]) => {

                if (scopes.length < 2)
                    return this.summarize(id, scopes);

                return Promise.resolve<StyleSummary>({ id, prompts: scopes, error: this.clash(id, scopes) });
            }));

        return summaries.sort((left, right) => left.id.localeCompare(right.id));
    }

    /**
     * The style of this id, parsed.
     *
     * Every style reaches this through the same parser, built-in
     * included - which is what makes a shipped style and a hand-written
     * one run identical code by construction, and what lets ejecting be
     * a file copy rather than a code generator.
     */
    async load(id: string): Promise<Style> {

        const source = await this.winner(id, STYLE_FILE);

        if (!source)
            throw new Error(
                `No style '${id}' found. A style is a folder holding ${STYLE_FILE}, in the workspace, your profile, or shipped with Eesha Code.`);

        return { ...parseStyle(source.text, id, this.templating), from: source.scope };
    }

    /**
     * A prompt's text - the highest scope holding the file, whole.
     *
     * @param relative Style-folder-relative, e.g. `instructions/design.md`.
     */
    async file(id: string, relative: string): Promise<ResolvedFile | undefined> {

        return this.winner(id, relative);
    }

    /**
     * A stage template - the phase's instructions, owned by the
     * repository rather than by the style.
     *
     * No precedence: there is one copy of it, in the repository, and a
     * stage naming one has said that this file wins outright. Layering
     * the style's own prompt underneath would hand the phase two sets
     * of instructions for one document.
     *
     * @param relative Workspace-relative, as the stage declares it.
     */
    async template(relative: string): Promise<ResolvedFile | undefined> {

        const text = await this.files.readWorkspace?.(relative);

        return text === undefined ? undefined : { text, scope: "repo" };
    }

    /** Where a stage template sits on disk, for attaching rather than reading. */
    templatePath(relative: string): string | undefined {

        return this.files.pathOfWorkspace?.(relative);
    }

    /**
     * Where a style file resolved to, for handing to something that
     * opens files rather than reads them.
     *
     * The same precedence `prompt` uses, so the file attached to a
     * session is the file that would have been read - a workspace
     * override cannot win the text and lose the path.
     *
     * Undefined when no scope has it, or when this registry's file
     * access has no paths to give.
     */
    async pathOf(id: string, relative: string): Promise<string | undefined> {

        if (!this.files.pathOf)
            return undefined;

        const base = await this.winner(id, relative);

        return base ? this.files.pathOf(base.scope, id, relative) : undefined;
    }

    /**
     * Where the shared grammar is - `grammar.md` in the styles folder,
     * the workspace's copy over the profile's over the built-in. One
     * file for every style: no style has its own.
     *
     * Undefined when no scope has one, or when this registry's file
     * access has no paths to give.
     */
    grammarPath(): string | undefined {

        for (const scope of [...Scopes].reverse()) {

            const file = this.files.sharedPath?.(scope, GRAMMAR_FILE);

            if (file)
                return file;
        }

        return undefined;
    }

    /**
     * A file of this style, from the one scope that holds the style.
     * Throws when the id is in two scopes - see the note at the top.
     */
    private async winner(id: string, relative: string): Promise<{ scope: Scope; text: string } | undefined> {

        const scope = await this.scopeOf(id);

        if (!scope)
            return undefined;

        const text = await this.files.read(scope, id, relative);

        return text === undefined ? undefined : { scope, text };
    }

    /** The one scope holding a style folder of this id, or nothing. Throws on a clash. */
    private async scopeOf(id: string): Promise<Scope | undefined> {

        const holding: Scope[] = [];

        for (const scope of Scopes)
            if ((await this.files.styles(scope)).includes(id))
                holding.push(scope);

        if (holding.length > 1)
            throw new Error(this.clash(id, holding));

        return holding[0];
    }

    /** The error for a style id found in more than one place, naming each folder. */
    private clash(id: string, scopes: Scope[]): string {

        const where = scopes.map(scope => {

            const file = this.files.pathOf?.(scope, id, STYLE_FILE);

            return file ? `${scope} (${path.dirname(file)})` : scope;
        });

        return `Style '${id}' is in more than one place: ${where.join(", ")}. A style may live in only one `
            + "place, so neither copy runs. Rename one - its folder and the 'id:' in its style.yml - or remove it."
            + (scopes.includes("builtin")
                ? ` '${id}' is a built-in sample: copy it under a name of your own with Eject Style instead.`
                : "");
    }

    private async summarize(id: string, prompts: Scope[]): Promise<StyleSummary> {

        const source = await this.winner(id, STYLE_FILE);

        if (!source)
            return {
                id,
                prompts,
                error: `No ${STYLE_FILE} in any scope - this folder only overrides prompts of a style that does not exist.`
            };

        try {

            const style = parseStyle(source.text, id, this.templating);

            return {
                id,
                name: style.name,
                desc: style.desc,
                scope: source.scope,
                prompts,
                blockOnOpenQuestions: style.blockOnOpenQuestions,
                presets: style.presets,
                ai: style.ai,
                ...(style.native ? { native: style.native } : {})
            };

        } catch (error) {

            return { id, scope: source.scope, prompts, error: (error as Error).message };
        }
    }
}
