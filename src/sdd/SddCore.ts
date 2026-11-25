import * as fs from "fs";
import * as path from "path";
import { loadEngineSettings } from "../core/settings/engineSettings";
import { ConfigTemplating } from "../core/templating/configScope";
import { AiPick, configFromSettings, SddConfig } from "./config/sddConfig";
import { SPEC_FILE } from "./config/specJson";
import { discover, DiscoveredSpec } from "./discovery/discover";
import { NodeSpecFiles } from "./discovery/NodeSpecFiles";
import { IdeaInput, renderIdea } from "./documents/ideaDocument";
import { ideaOf, quoted, Style } from "./model/style";
import { assemble, HandedTask, PhaseRequest } from "./phase/assemble";
import { NodeStyleFiles, STYLES_DIR } from "./registry/NodeStyleFiles";
import { StyleRegistry, StyleSummary } from "./registry/StyleRegistry";

/**
 * SDD core, composed for a workspace.
 *
 * Wires discovery, the registry, and settings together in one place,
 * so no surface needs to know how they depend on each other. Holds no
 * page type, so the same object serves the server and tests.
 *
 * Not a cache. The documents this reasons about are edited by hand, by
 * agents, and by git, so everything is read on demand. Callers that
 * need to throttle can; correctness comes first.
 */

export const WORKFLOWS_DIR = ".eesha";

/** What a surface listing specs needs: the specs, and what is broken. */
export interface SpecsView {

    specs: DiscoveredSpec[];

    /**
     * Why a style would not load, keyed by id. Empty when every style
     * parses - which is the normal state, and why a caller may ignore
     * it entirely.
     */
    problems: Map<string, string>;

    /**
     * Every spec name found in more than one spec root, with a sentence
     * naming both folders. A spec is known by its folder name, so only
     * the first is listed. Empty in the normal case.
     */
    clashes: { name: string; message: string }[];
}

/** A folder spec folders live in - the shared one, or a style's own. */
export interface SpecRoot {

    /** As written in `sdd.specsDir` or a style's `specsDir` - what a spec's label starts with. */
    label: string;

    /** Absolute. */
    folder: string;

    /** The one style whose own `specsDir` this is. See `DiscoveryInput.owner`. */
    owner?: string;
}

export interface SddPaths {

    /** The repository. */
    workspace: string;

    /** The program's own `resources` directory - where built-in styles ship. */
    resources: string;

    /** The user's home, for profile-scope styles. Omit to disable that scope. */
    home?: string;

    /**
     * The profile folder - its settings.json and styles. Leave it out
     * and it is `<home>/.eesha`. Eesha Code passes
     * `~/.eesha`, the same folder its chat settings come from.
     */
    profile?: string;
}

export class SddCore {

    private constructor(
        readonly paths: SddPaths,
        readonly config: SddConfig,
        readonly registry: StyleRegistry
    ) { }

    /**
     * Reads the settings and prepares style resolution.
     *
     * A workspace with no `settings.json` is the normal case, not a
     * special one: {@link configFromSettings} answers it with defaults
     * that make the built-in custom style run on Copilot's own model
     * choice. Settings arrive merged across both scopes, workspace then
     * profile winning - the same view every other consumer gets.
     *
     * @param options.aiPick the runtime and model the person picked in
     * the panel, over every file - see {@link AiPick}. The app holds
     * it, so the surface that has it hands it in.
     */
    static async create(
        paths: SddPaths,
        options: { aiPick?: AiPick } = {}
    ): Promise<SddCore> {

        const profile = paths.profile ?? (paths.home ? path.join(paths.home, WORKFLOWS_DIR) : undefined);

        const settings = await loadEngineSettings(paths.workspace, { profileDir: profile });

        /*
         * What ${{ }} in a `style.yml` resolves against.
         *
         * Built here because this is the only place holding all three:
         * the repository a `template:` is measured against, the home
         * the profile scope sits under, and the deny list the settings
         * just declared.
         */
        const templating: ConfigTemplating = {
            workspaceFolder: paths.workspace,
            home: paths.home,
            denied: settings.env.denied
        };

        const registry = new StyleRegistry(new NodeStyleFiles({
            builtin: path.join(paths.resources, STYLES_DIR),
            profile: profile ? path.join(profile, STYLES_DIR) : undefined,
            workspace: path.join(paths.workspace, WORKFLOWS_DIR, STYLES_DIR)
        }, paths.workspace), templating);

        const config = configFromSettings({
            sdd: settings.sdd,
            aiDefaults: settings.ai.defaults,
            acpAgents: settings.ai.acpAgents,
            providers: settings.ai.providers,
            aiScopedDefaults: settings.ai.scopedDefaults,
            variables: settings.variables,
            fakeRuntime: settings.features?.fakeRuntime
        }, options.aiPick);

        return new SddCore(paths, config, registry);
    }

    /**
     * Absolute path of the shared spec root - `sdd.specsDir`, where
     * every style's specs go unless its `style.yml` names its own.
     *
     * `sdd.specsDir` may be absolute - a root outside the workspace,
     * shared between repositories - and is taken as-is: splitting it on
     * separators and re-joining under the workspace would silently
     * fold it back inside. A relative one anchors to the workspace.
     */
    get specRoot(): string {

        return this.absolute(this.config.specRoot);
    }

    /**
     * What to call a spec folder, both to a person and to an agent.
     *
     * Repository-relative for the default root, which is the readable
     * answer for a person and resolves correctly for an agent working
     * in the repository. An absolute `specsDir` names it absolutely -
     * the only address that means anything for a root outside the
     * repository.
     *
     * @param style The style the spec follows. Its own `specsDir` wins
     * over `sdd.specsDir` when it has one.
     */
    specDirOf(specName: string, style?: Style): string {

        return `${style?.specsDir ?? this.config.specRoot}/${specName}`;
    }

    /**
     * Absolute path of a spec folder, wherever the root is.
     *
     * The one way to turn a spec name into a place on disk. A caller
     * re-deriving it from {@link specDirOf} has to know whether that
     * string is relative, and splitting an absolute Windows path on
     * separators drops the drive's root - so the answer is given here
     * rather than reconstructed.
     *
     * @param style As for {@link specDirOf}.
     */
    specPathOf(specName: string, style?: Style): string {

        return path.join(this.specRootOf(style), specName);
    }

    /** Absolute path of the root a style's new specs are created under - its own `specsDir`, or the shared one. */
    specRootOf(style?: Style): string {

        return this.absolute(style?.specsDir ?? this.config.specRoot);
    }

    /**
     * Every folder specs are looked for in: the shared root first, then
     * each style's own `specsDir`, once each however many styles name it.
     */
    async specRoots(): Promise<SpecRoot[]> {

        return this.rootsOf((await this.styles()).loaded);
    }

    /** Every style on offer, including any that failed to load - those carry their error. */
    listStyles(): Promise<StyleSummary[]> {

        return this.registry.list();
    }

    /**
     * Every spec under the root, placed against every style that loads.
     *
     * Matched against all of them rather than only the configured one,
     * because a repository that switched styles, or that holds specs a
     * teammate wrote with another, is a real repository - and reading
     * such a folder by the wrong rules draws a pipeline for a process
     * nobody is following.
     */
    async specs(): Promise<DiscoveredSpec[]> {

        return (await this.view()).specs;
    }

    /**
     * The specs, and why any style would not load - in one read.
     *
     * Both come out of the same pass over the style folders. Asking
     * twice would read every `style.yml` twice per refresh, and this
     * is deliberately not a cache.
     */
    async view(): Promise<SpecsView> {

        const { loaded, failures } = await this.styles();

        const specs: DiscoveredSpec[] = [];
        const clashes: SpecsView["clashes"] = [];

        // Root by root, shared root first. A spec is known by its folder
        // name everywhere else - the panel, the run records - so the
        // first of two same-named folders is the one listed.
        for (const root of this.rootsOf(loaded)) {

            const found = await discover(
                { config: this.config, styles: loaded, failures, root: root.folder, label: root.label, owner: root.owner },
                new NodeSpecFiles(root.folder));

            for (const spec of found) {

                const first = specs.find(one => one.name === spec.name);

                if (first)
                    clashes.push({
                        name: spec.name,
                        message: `Spec '${spec.name}' is in both ${first.folder} and ${spec.folder}. A spec is `
                            + "known by its folder name, so only the first is listed - rename one."
                    });
                else
                    specs.push(spec);
            }
        }

        return { specs, problems: failures, clashes };
    }

    /**
     * What a phase would be handed, assembled but not run.
     *
     * Split from running so the panel can show a user exactly what a
     * phase will be told, before it is told.
     *
     * @param revise Absent for a first pass. Present to run the stage
     * again over the document it already wrote, carrying `note` - what
     * the person typed when they pressed Revise. Using presence rather
     * than a flag means a note on a first pass cannot be spelled.
     *
     * This selects no second prompt: a style declares one instruction
     * file per stage, and the `## Revising` section in it is what a
     * second pass runs on. The flag only decides whether a note is
     * allowed; whether the frame treats this as a revise depends on
     * whether the document already exists.
     *
     * @param tasks The rows an implement run was handed. Only the output
     * gate takes any; they become `${{ phase.tasks }}` in its prompt.
     */
    async phase(
        spec: DiscoveredSpec,
        stageId: string,
        revise?: { note?: string; first?: boolean },
        tasks?: HandedTask[]
    ): Promise<PhaseRequest> {

        if (!spec.detection.style || !spec.specType)
            throw new Error(`Spec '${spec.name}' has not been placed against a style, so no phase can be assembled for it.`);

        const style = await this.registry.load(spec.detection.style);

        // Spec Kit's own scripts pick the spec from the git branch. On
        // another branch, /speckit.plan would work on a different spec,
        // or stop with an error of its own.
        if (style.native === "speckit") {

            const branch = checkedOutBranch(this.paths.workspace);

            if (branch && branch !== spec.name)
                throw new Error(
                    `Spec Kit picks the spec from the git branch, and '${branch}' is checked out. Switch to `
                    + `the branch '${spec.name}' first, then run this phase again.`);
        }

        // The root this spec was found in - the shared one, or its
        // style's own.
        const files = new NodeSpecFiles(path.dirname(spec.folder));

        const contents = await files.contents(spec.name);

        // Read here rather than in `assemble`, which has no disk of its
        // own. Absent for the ordinary spec that declared nothing.
        const specJson = contents.includes(SPEC_FILE)
            ? await files.read(spec.name, SPEC_FILE)
            : undefined;

        return assemble({
            style,
            config: this.config,
            // The place, not the label: an agent told to write to
            // `.eesha/specs/x` resolves it against its own
            // working directory, which is the workspace - not the spec
            // root, when the two are different.
            specDir: spec.path,

            // The same folder as a place rather than as an address. An
            // attachment is opened by the provider, not resolved by the
            // agent, so a file the spec declared needs the one and
            // `specDir` is the other.
            specPath: spec.folder,

            specType: spec.specType,
            stageId,
            // `first`: a native phase's first pass with typed text - not a
            // revise, but it carries a note. See `assemble`.
            revise: revise !== undefined && !revise.first,
            note: revise?.note,
            contents,
            specJson,
            tasks
        }, this.registry);
    }

    /**
     * The spec's first document, ready to be written.
     *
     * Nothing runs here. Idea is the input gate, and its content is
     * what ＋ New Spec collected - the type, the source, the pointer to
     * the work item or the files copied in. Formatting that is not a
     * job for a model; a model in the middle would only paraphrase
     * material the next phase reads for itself.
     *
     * Returns the text and where it goes rather than writing it, so the
     * decision about the document stays here and the filesystem stays
     * with the surface that already made the folder.
     *
     * @param input.style Which of `sdd.styles` the picker chose. Named
     * here rather than defaulted, because once more than one style is
     * enabled there is no single configured style to fall back to.
     * @param files Spec-relative names of files already copied into the
     * spec folder, so the ask travels with the spec.
     */
    async idea(input: Omit<IdeaInput, "specName"> & { specName: string }): Promise<{ artifact: string; text: string }> {

        const style = await this.registry.load(input.style);
        const idea = ideaOf(style);

        // Kiro and Spec Kit take the ask in with their own first command.
        if (!idea)
            throw new Error(
                `Style '${style.id}' runs ${style.native === "kiro" ? "Kiro's" : "Spec Kit's"} own process, which `
                + "has no Idea document. Its first phase takes the description instead.");

        if (!style.specTypes.some(specType => specType.id === input.specType))
            throw new Error(
                `Style '${style.id}' has no spec type '${input.specType}' - it offers `
                + `${quoted(style.specTypes.map(specType => specType.id))}.`);

        // The style names the artifact, so a style that calls its first
        // document something else still works. Its `produces` is
        // required by the parser, so there is always one.
        return { artifact: idea.produces[0], text: renderIdea(input) };
    }

    /** A `specsDir` as written, made absolute - relative ones anchor to the workspace. */
    private absolute(written: string): string {

        return path.isAbsolute(written)
            ? path.normalize(written)
            : path.join(this.paths.workspace, ...written.split(/[\\/]/));
    }

    /** See {@link specRoots}. Folders compare case-blind on Windows, where the disk does. */
    private rootsOf(styles: Style[]): SpecRoot[] {

        const key = (folder: string) => process.platform === "win32" ? folder.toLowerCase() : folder;

        const roots: (SpecRoot & { owners: string[] })[] =
            [{ label: this.config.specRoot, folder: this.specRoot, owners: [] }];

        for (const style of styles) {

            if (!style.specsDir)
                continue;

            const folder = this.absolute(style.specsDir);
            const same = roots.find(root => key(root.folder) === key(folder));

            if (same)
                same.owners.push(style.id);
            else
                roots.push({ label: style.specsDir, folder, owners: [style.id] });
        }

        // The shared root has no owner even when a style names it too:
        // every other style's untagged specs sit there as well.
        return roots.map(({ owners, ...root }, index) =>
            index > 0 && owners.length === 1 ? { ...root, owner: owners[0] } : root);
    }

    /**
     * The styles that parse, and why each of the others does not.
     *
     * A style that fails to parse cannot be matched against a folder,
     * but dropping it silently confuses two different problems:
     * `sdd.style` naming a folder nobody has, and a folder that exists
     * but whose `style.yml` has a mistake. The second is common once
     * someone ejects a style and edits it.
     */
    private async styles(): Promise<{ loaded: Style[]; failures: Map<string, string> }> {

        const summaries = await this.registry.list();
        const failures = new Map<string, string>();

        const loaded = await Promise.all(summaries.map(async summary => {

            if (summary.error) {

                failures.set(summary.id, summary.error);

                return undefined;
            }

            try {

                return await this.registry.load(summary.id);

            } catch (error) {

                // `list` parses too, so reaching here means the file
                // changed between the two reads. Rare, and still not a
                // reason to lose the message.
                failures.set(summary.id, (error as Error).message);

                return undefined;
            }
        }));

        return { loaded: loaded.filter((style): style is Style => Boolean(style)), failures };
    }
}

/**
 * The branch checked out in a folder, read from `.git/HEAD` - or
 * nothing when it is not a git folder, is on no branch, or cannot be
 * read. A worktree's `.git` is a file naming its real folder.
 *
 * Exported for tests.
 */
export function checkedOutBranch(workspace: string): string | undefined {

    try {

        let gitDir = path.join(workspace, ".git");

        if (fs.statSync(gitDir).isFile()) {

            const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));

            if (!pointer)
                return undefined;

            gitDir = path.resolve(workspace, pointer[1].trim());
        }

        const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();

        return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];

    } catch {

        return undefined;
    }
}
