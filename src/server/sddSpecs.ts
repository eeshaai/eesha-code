import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { specEventsPath } from "../core/events/eventFile";
import { parseEvents, sessionRuns } from "../core/events/runEvents";
import { profileDirectory } from "../core/loader/profilePaths";
import { logger } from "../core/logging/logger";
import { Sources } from "../sdd/config/sddConfig";
import { SddController } from "../sdd/panel/SddController";
import { ejectedText, ejectPreview, ejectStyle, styleIds, type StylesFolders } from "../sdd/panel/ejectStyle";
import { createNativeFolder, createSpec, nativeOffers, pointerFor, sourceLabel, specNameProblem, specTypeOffers, takenSpecNames, type Pointer } from "../sdd/panel/newSpec";
import { clearHistory } from "../sdd/panel/reviewStore";
import { listSpecs, specRow } from "../sdd/panel/specList";
import { STYLES_DIR } from "../sdd/registry/NodeStyleFiles";
import { IDEA, IMPLEMENT } from "../sdd/model/style";
import { SddCore, WORKFLOWS_DIR } from "../sdd/SddCore";
import type { ToPanel, ToSddView } from "../shared/sddMessages";
import { readShown } from "./ServerChatHost";
import { serverSddHost, type SddHostServer, type SddPlace, sddStorePrefix, stopPlanCommands } from "./ServerSddHost";
import { isInside } from "./folders";
import type { SessionPlace } from "./memory/Memory";
import type { ChatStore } from "../chat/chatStore";
import type { PhaseOwner } from "../chat/chatHost";
import type { ChatSpecLink } from "../shared/chatMessages";
import { type CopyStyleAsk, type CopyStyleOffers, folderKey, type NewSpecAnswer, type NewSpecAsk, type NewSpecOffers, type PromptRequest, mainFolderOf, type RecentSpecsView, type RecentSpecView, type SpecExplorerView, type SpecFolderView, type SpecListView, type SpecRowView, type SpecSessionView, type SpecSort, type SpecTreeRow, type ToPage, type Workspace, workspaceKey } from "./protocol";
import { readWorkspaces } from "./workspaces";

/*
 * The SDD module on the server. One `SddController` per open spec. A spec is shown in one browser tab at a
 * time, like a chat; its messages go to that tab as `eesha.sdd` events.
 *
 * SDD always runs in a workspace: a spec is found by the
 * workspace's key and its name, in the workspace's main folder.
 * Its phase sessions are never chats: they are not in the chat list, and
 * SDD's saved values sit under their own keys (4.4).
 */

/** What the specs need from the server: the tabs. */
export interface SddServer extends SddHostServer {

    /** One message to the tab with this view id. Dropped when it is gone. */
    toTab(view: string, message: ToPage): void;

    toAll(message: ToPage): void;

    /** Asks the tab with this view id. Nothing when it is gone, or the person backs out. */
    askTab(view: string, prompt: PromptRequest): Promise<string | undefined>;
}

/** One spec the server holds. */
interface SpecEntry {

    place: SddPlace;

    spec: string;

    /** The spec's folder when it is not the workspace's main one - as a page's address names it. */
    folder?: string;

    /**
     * What the spec is called to the connector tools' server - `eesha
     * mcp --chat <id>`. Not a chat id: unique among the specs this server
     * holds, so a write question finds this spec's tab.
     */
    id: string;

    controller: SddController;

    /** The tab showing it. */
    view?: string;

    /** A phase or a wave runs - from the `busy` messages it posts. */
    working: boolean;

    /** The agent asked something and nobody answered yet. */
    waiting: boolean;

    /** The controller let go of itself. */
    released: boolean;

    /** The spec's list row as last read - see `SddSpecs.rowMayHaveMoved`. */
    row?: string;

    /** Waits for a burst of redraws to settle before the row is read. */
    rowTimer?: ReturnType<typeof setTimeout>;

    /** What each phase is called on screen, by id - from the spec as last drawn. */
    phaseNames?: Map<string, string>;
}

/**
 * Which workspace each spec was made in, kept in Eesha Code's own store
 * (nothing is written into the spec folder): `<main folder key>|<spec
 * name>` → the workspace's key. Several workspaces can share a main
 * folder, one per work item, and so share its specs; the list shows a
 * workspace's own specs first.
 */
export const SPEC_WORKSPACES_KEY = "eesha.specWorkspaces";

/** One spec in one workspace, as `SddSpecs.pendingStarts` keys it. */
function pendingKey(place: Pick<SddPlace, "key" | "mainFolder">, spec: string): string {

    return `${place.key}|${folderKey(place.mainFolder)}|${spec}`;
}

function specTag(mainFolder: string, spec: string): string {

    return `${folderKey(mainFolder)}|${spec}`;
}

/** Notes that this spec was made in this workspace. */
export async function tagSpec(store: ChatStore, place: Pick<SddPlace, "key" | "mainFolder">, spec: string): Promise<void> {

    const saved = store.get<Record<string, string>>(SPEC_WORKSPACES_KEY);

    await store.update(SPEC_WORKSPACES_KEY, { ...(saved && typeof saved === "object" ? saved : {}), [specTag(place.mainFolder, spec)]: place.key });
}

/**
 * Whether a spec belongs to this workspace: the one it was made in, while
 * that workspace is still in the list. A spec with no such workspace -
 * made by someone else, or in a workspace since removed - belongs to the
 * folder's first workspace, the one keyed by the folder itself.
 */
export function specIsHere(store: ChatStore, place: Pick<SddPlace, "key" | "mainFolder">, spec: string, keys: ReadonlySet<string>): boolean {

    const saved = store.get<Record<string, unknown>>(SPEC_WORKSPACES_KEY);
    const tag = saved && typeof saved === "object" ? saved[specTag(place.mainFolder, spec)] : undefined;

    return typeof tag === "string" && keys.has(tag)
        ? tag === place.key
        : place.key === folderKey(place.mainFolder);
}

/** The saved spec order of a workspace - the key the Specs view uses. */
const SORT_KEY = "specSort";

/** How long a burst of redraws has to be quiet before the spec's row is read again. */
const ROW_SETTLE_MS = 300;

/**
 * Where SDD keeps a workspace's specs, and its folders. The specs sit in
 * the main folder, as in any repository: there is no separate SDD
 * folder.
 */
export function placeOf(workspace: Workspace): SddPlace {

    return {
        key: workspaceKey(workspace),
        mainFolder: mainFolderOf(workspace),
        folders: [...workspace.folders]
    };
}

/** Why a request names no place: the workspace is gone, or the folder is not one of its folders. */
export function placeProblem(folder: unknown): string {

    return folder
        ? "That folder is not in this workspace any more. Reload the page."
        : "That workspace is not here any more. Reload the page.";
}

/**
 * The same workspace with `folder` standing in for its main folder - for
 * a spec kept in another of its folders. That folder goes first, as the
 * main one does.
 */
export function inFolder(place: SddPlace, folder: string): SddPlace {

    return {
        key: place.key,
        mainFolder: folder,
        folders: [folder, ...place.folders.filter(one => folderKey(one) !== folderKey(folder))]
    };
}

/** The workspace's folders - where a spec's files may be shown from. */
export function placeRoots(place: SddPlace): string[] {

    return [...place.folders];
}

/** Core over one workspace for New Spec and the Specs view. */
function coreOf(server: SddHostServer, place: SddPlace): Promise<SddCore> {

    return SddCore.create({
        workspace: place.mainFolder,
        resources: server.resources,
        home: os.homedir(),
        profile: profileDirectory()
    });
}

/**
 * The three styles folders for a workspace: the shipped styles, the
 * profile's (Eesha Code's own profile, `~/.eesha/styles`) and the main
 * folder's - the same folders `SddCore` reads styles from.
 */
export function stylesFoldersOf(server: SddHostServer, place: SddPlace): StylesFolders {

    return {
        builtin: path.join(server.resources, STYLES_DIR),
        profile: path.join(profileDirectory(), STYLES_DIR),
        workspace: path.join(place.mainFolder, WORKFLOWS_DIR, STYLES_DIR)
    };
}

export class SddSpecs {

    private readonly entries = new Set<SpecEntry>();

    /** Counts the specs made, for each one's `id`. */
    private made = 0;

    /**
     * A Kiro spec New spec just made, and the first phase to start with
     * the description typed there - started when the spec's page opens,
     * so its permission cards have a tab to show in. Kept in memory: a
     * restart in between leaves an empty spec, and Run starts it.
     */
    private readonly pendingStarts = new Map<string, { stageId: string; note: string }>();

    constructor(private readonly server: SddServer) {}

    /**
     * The workspace with this key. With `folder`, one of its other
     * folders stands in for the main one: that folder's specs are meant,
     * and their phases run there. A folder that is not the workspace's
     * is no place.
     */
    placeAt(key: unknown, folder?: unknown): SddPlace | undefined {

        if (typeof key !== "string")
            return undefined;

        const workspace = readWorkspaces(this.server.store).find(one => workspaceKey(one) === key);

        if (!workspace)
            return undefined;

        const place = placeOf(workspace);

        if (folder === undefined || folder === null || folder === "")
            return place;

        const picked = typeof folder === "string" ? place.folders.find(one => folderKey(one) === folderKey(folder)) : undefined;

        return picked ? inFolder(place, picked) : undefined;
    }

    /** The spec the tab with this view id shows. */
    shownIn(view: string): { place: SddPlace; spec: string } | undefined {

        const entry = [...this.entries].find(one => one.view === view);

        return entry ? { place: entry.place, spec: entry.spec } : undefined;
    }

    /**
     * The tab showing the spec the connector tools know by this id - where
     * a write is asked. Nothing: not a spec's id, or no tab shows it.
     */
    viewOf(id: string): string | undefined {

        return [...this.entries].find(one => one.id === id && !one.released)?.view;
    }

    /**
     * What the memory tools reach for the spec known by this id: its
     * workspace and that workspace's folders. Nothing: not a spec's id.
     */
    memoryPlaceOf(id: string): SessionPlace | undefined {

        const place = [...this.entries].find(one => one.id === id && !one.released)?.place;

        if (!place)
            return undefined;

        const workspace = readWorkspaces(this.server.store).find(one => workspaceKey(one) === place.key);

        return { workspace: { key: place.key, name: workspace?.name ?? place.key }, folders: [...place.folders] };
    }

    /** The connector tools' id of a spec held now. For tests. */
    idOf(place: SddPlace, spec: string): string | undefined {

        return this.find(place, spec)?.id;
    }

    /** A saved permission answer was added or removed: every spec on screen sends its compose row's count again. */
    savedAnswersChanged(): void {

        for (const entry of this.entries)
            if (entry.view && !entry.released)
                void entry.controller.savedAnswersChanged();
    }

    /** How many specs have a phase or wave running now - shown with the chats' count. */
    get working(): number {

        return [...this.entries].filter(entry => entry.working || (!entry.view && !entry.released)).length;
    }

    /**
     * The specs of a workspace, as the panel lists them: its own first,
     * then the ones made in other workspaces on its main folder. Each
     * group in the workspace's order - A to Z, or most recently changed.
     */
    async list(place: SddPlace): Promise<SpecListView> {

        const sort = this.sortOf(place);
        const core = await coreOf(this.server, place);
        const { notes, specs } = await listSpecs(core, sort);
        const keys = new Set(readWorkspaces(this.server.store).map(workspaceKey));

        const rows = specs.map((spec): SpecRowView => {

            const facts = specRow(spec);
            const live = this.find(place, spec.name);

            return {
                name: spec.name,
                ...(spec.detection.style ? { style: spec.detection.style } : {}),
                ...(facts.phase ? { phase: facts.phase } : {}),
                ...(facts.progress ? { done: facts.progress.done, total: facts.progress.total } : {}),
                working: live !== undefined && (live.working || (!live.view && !live.released)),
                waiting: live?.waiting === true,
                modified: spec.modified,
                ...(specIsHere(this.server.store, place, spec.name, keys) ? {} : { elsewhere: true as const })
            };
        });

        // This workspace's own first; the sort keeps the order inside each.
        rows.sort((left, right) => Number(left.elsewhere === true) - Number(right.elsewhere === true));

        // An empty folder is the panel's own empty line, not a note.
        return { specs: rows, notes: notes.filter(note => note.kind !== "empty").map(note => note.text), sort };
    }

    /**
     * The Spec explorer: every folder of the workspace, the main one
     * first, each with its specs (Eesha, Kiro and Spec Kit) and their
     * phases. A folder that cannot be read says why and the rest still
     * show.
     */
    async explorer(place: SddPlace): Promise<SpecExplorerView> {

        const sort = this.sortOf(place);
        const keys = new Set(readWorkspaces(this.server.store).map(workspaceKey));

        const folders = await Promise.all(place.folders.map(async (folder): Promise<SpecFolderView> => {

            const main = folderKey(folder) === folderKey(place.mainFolder);

            try {

                return { folder, main, ...await this.tree(main ? place : inFolder(place, folder), sort, keys) };

            } catch (error) {

                return { folder, main, specs: [], notes: [], problem: (error as Error).message };
            }
        }));

        return { folders, sort };
    }

    /**
     * The start page's "Recent specs": the `count` specs most recently
     * changed, from every workspace that is not archived. Each spec is
     * listed once, under the workspace that made it - the same one whose
     * own page lists it. Many workspaces share folders (one per work
     * item), so each folder is read once. A folder that cannot be read is
     * left out: its workspace's own page says why.
     */
    async recent(count: number): Promise<RecentSpecsView> {

        const all = readWorkspaces(this.server.store);
        const keys = new Set(all.map(workspaceKey));

        // Each folder, with the open workspaces that have it.
        const byFolder = new Map<string, { folder: string; owners: Workspace[] }>();

        for (const workspace of all.filter(one => !one.archived))
            for (const folder of workspace.folders) {

                const known = byFolder.get(folderKey(folder));

                if (known)
                    known.owners.push(workspace);
                else
                    byFolder.set(folderKey(folder), { folder, owners: [workspace] });
            }

        const lists = await Promise.all([...byFolder.values()].map(async ({ folder, owners }): Promise<RecentSpecView[]> => {

            try {

                const core = await coreOf(this.server, { key: "", mainFolder: folder, folders: [folder] });
                const { specs } = await listSpecs(core, "alpha");

                return specs.flatMap((spec): RecentSpecView[] => {

                    const owner = owners.find(one => specIsHere(this.server.store, { key: workspaceKey(one), mainFolder: folder }, spec.name, keys));

                    if (!owner)
                        return [];

                    // The owner's own spelling, so a running phase is found.
                    const own = owner.folders.find(one => folderKey(one) === folderKey(folder)) ?? folder;
                    const main = folderKey(own) === folderKey(mainFolderOf(owner));
                    const place = main ? placeOf(owner) : inFolder(placeOf(owner), own);
                    const facts = specRow(spec);
                    const live = this.find(place, spec.name);

                    return [{
                        name: spec.name,
                        ...(spec.detection.style ? { style: spec.detection.style } : {}),
                        ...(facts.phase ? { phase: facts.phase } : {}),
                        ...(facts.progress ? { done: facts.progress.done, total: facts.progress.total } : {}),
                        working: live !== undefined && (live.working || (!live.view && !live.released)),
                        waiting: live?.waiting === true,
                        modified: spec.modified,
                        workspace: workspaceKey(owner),
                        ...(main ? {} : { folder: own })
                    }];
                });

            } catch (error) {

                logger.warning(`Eesha Code: could not read the specs in ${folder} for the start page. ${(error as Error).message}`);

                return [];
            }
        }));

        const specs = lists.flat();

        specs.sort((left, right) => (right.modified ?? 0) - (left.modified ?? 0) || left.name.localeCompare(right.name));

        return { specs: specs.slice(0, count) };
    }

    /** One folder's specs for the Spec explorer, this workspace's own first. */
    private async tree(place: SddPlace, sort: SpecSort, keys: ReadonlySet<string>): Promise<Pick<SpecFolderView, "specs" | "notes">> {

        const core = await coreOf(this.server, place);
        const { notes, specs } = await listSpecs(core, sort);
        const native = new Map((await core.listStyles()).map(style => [style.id, style.native]));

        const rows = specs.map((spec): SpecTreeRow => {

            const facts = specRow(spec);
            const live = this.find(place, spec.name);
            const kind = spec.detection.style ? native.get(spec.detection.style) : undefined;

            return {
                name: spec.name,
                ...(spec.detection.style ? { style: spec.detection.style } : {}),
                ...(facts.phase ? { phase: facts.phase } : {}),
                ...(facts.progress ? { done: facts.progress.done, total: facts.progress.total } : {}),
                working: live !== undefined && (live.working || (!live.view && !live.released)),
                waiting: live?.waiting === true,
                modified: spec.modified,
                ...(specIsHere(this.server.store, place, spec.name, keys) ? {} : { elsewhere: true as const }),
                ...(kind ? { native: kind } : {}),
                root: path.relative(place.mainFolder, path.dirname(spec.folder)).split(path.sep).join("/") || ".",
                phases: (spec.state?.stages ?? []).map(state => ({
                    id: state.stage.id,
                    label: state.stage.label,
                    status: state.status,
                    ...(state.stage.id === IDEA ? { chatless: true as const } : {})
                }))
            };
        });

        rows.sort((left, right) => Number(left.elsewhere === true) - Number(right.elsewhere === true));

        return { specs: rows, notes: notes.filter(note => note.kind !== "empty").map(note => note.text) };
    }

    /**
     * Every session a spec's phases have had, oldest first, read from
     * the spec's history file - the same list the spec's page offers.
     * The execution phase's own name holds only the page's notes, so
     * only its chats (`implement@...`) are listed.
     */
    sessions(place: SddPlace, spec: string): SpecSessionView[] {

        let text = "";

        try {

            text = fs.readFileSync(specEventsPath(place.mainFolder, spec), "utf8");

        } catch {

            // No history yet: no sessions.
        }

        return sessionRuns(parseEvents(text))
            .filter(run => run.ownerId !== IMPLEMENT)
            .map(run => ({
                ownerId: run.ownerId,
                iteration: run.iteration,
                current: run.current,
                at: run.at,
                ...(run.model ? { model: run.model } : {}),
                ...(run.status ? { status: run.status } : {}),
                ...(run.note ? { note: run.note } : {}),
                ...(run.chatId ? { chatId: run.chatId } : {})
            }));
    }

    /** The workspace's spec order. Kept under the key `specSort`. */
    sortOf(place: SddPlace): SpecSort {

        return this.server.store.get<SpecSort>(sddStorePrefix(place.key) + SORT_KEY) === "recent" ? "recent" : "alpha";
    }

    /** Keeps the workspace's spec order, and every tab reads its list again. */
    async setSort(place: SddPlace, sort: SpecSort): Promise<void> {

        await this.server.store.update(sddStorePrefix(place.key) + SORT_KEY, sort);

        this.server.toAll({ type: "eesha.specsChanged" });
    }

    /**
     * Throws away the old copies of spec documents that "What changed"
     * compares against, for every spec on the workspace's main folder -
     * Clear Spec History. Answers how many files went.
     */
    clearHistory(place: SddPlace): number {

        return clearHistory(place.mainFolder);
    }

    /** What the New spec window offers in this workspace. */
    async offers(place: SddPlace): Promise<NewSpecOffers> {

        const core = await coreOf(this.server, place);
        const { styles, offers, broken } = await specTypeOffers(core);

        return {
            types: offers.map(one => ({ label: one.label, ...one.id })),
            broken,
            sources: Sources.map(id => ({ id, label: sourceLabel(id) })),
            ...(core.config.source ? { source: core.config.source } : {}),
            roots: Object.fromEntries(styles.map(style => [style.id, core.specRootOf(style)])),
            taken: [...await takenSpecNames(core)],
            native: (await nativeOffers(core)).map(({ style, problem }) => ({
                id: style.id,
                label: style.name,
                detail: style.native === "kiro"
                    ? "Makes the spec folder and starts Requirements in Kiro's Spec mode with your description. A new Kiro chat for each phase after."
                    : "Opens a chat with /speckit.specify and your description in the box. Press Send there - Spec Kit names the folder and the branch.",
                root: core.specRootOf(style),
                ...(problem ? { problem } : {})
            }))
        };
    }

    /**
     * Writes a new spec's folder and idea.md, with no AI - New Spec.
     * Answers its name, or why not.
     */
    async create(ask: Partial<NewSpecAsk>): Promise<NewSpecAnswer> {

        const place = this.placeAt(ask.workspace, ask.folder);

        if (!place)
            return { problem: placeProblem(ask.folder) };

        const core = await coreOf(this.server, place);

        const native = (await nativeOffers(core)).find(one => one.style.id === ask.styleId);

        if (native)
            return this.createNative(place, core, native, ask);

        const { styles } = await specTypeOffers(core);

        const style = styles.find(one => one.id === ask.styleId);
        const specType = style?.specTypes.find(one => one.id === ask.specTypeId);

        if (!style || !specType)
            return { problem: "Pick what kind of spec this is." };

        const source = core.config.source ?? ask.source;

        if (typeof source !== "string" || !(Sources as readonly string[]).includes(source))
            return { problem: "Pick where the spec starts from." };

        const name = typeof ask.name === "string" ? ask.name.trim() : "";
        const problem = specNameProblem(name, await takenSpecNames(core));

        if (problem)
            return { problem };

        const pointer = pointerOf(source, ask);

        if ("problem" in pointer)
            return pointer;

        await createSpec(core, style, { name, specTypeId: specType.id, source, pointer });
        await tagSpec(this.server.store, place, name);

        this.server.toAll({ type: "eesha.specsChanged" });

        return { name };
    }

    /**
     * New spec for Kiro or Spec Kit. Kiro: the folder, and Requirements
     * started with the description once the spec's page opens. Spec
     * Kit: a chat with `/speckit.specify` and the description in the
     * box - its script picks the folder name and makes the branch.
     */
    private async createNative(
        place: SddPlace,
        core: SddCore,
        native: Awaited<ReturnType<typeof nativeOffers>>[number],
        ask: Partial<NewSpecAsk>
    ): Promise<NewSpecAnswer> {

        if (native.problem)
            return { problem: native.problem };

        const description = typeof ask.text === "string" ? ask.text.trim() : "";

        if (!description)
            return { problem: "Say what the spec is about - it is sent with the first command." };

        if (native.style.native === "speckit")
            return { chat: { folder: place.mainFolder, workspace: place.key, text: `/speckit.specify ${description}` } };

        const name = typeof ask.name === "string" ? ask.name.trim() : "";
        const problem = specNameProblem(name, await takenSpecNames(core));

        if (problem)
            return { problem };

        await createNativeFolder(core, native.style, name);
        await tagSpec(this.server.store, place, name);

        const first = native.style.specTypes[0].stages[0];

        this.pendingStarts.set(pendingKey(place, name), { stageId: first, note: description });

        this.server.toAll({ type: "eesha.specsChanged" });

        return { name };
    }

    /** What the Copy a style window offers in this workspace. */
    async copyOffers(place: SddPlace): Promise<CopyStyleOffers> {

        const folders = stylesFoldersOf(this.server, place);

        const styles = await Promise.all((await styleIds(folders.builtin)).map(async id => ({ id, ...await ejectPreview(folders, id) })));

        return {
            styles,
            // The workspace first, so the copy goes into git with the
            // specs and the team gets it.
            places: [
                { id: "workspace", label: "This workspace", folder: folders.workspace!, detail: "Lives beside the specs, so it goes into git and the team gets it." },
                { id: "profile", label: "My profile", folder: folders.profile, detail: "On this machine only, for every workspace." }
            ]
        };
    }

    /** Copies a built-in style as a new style. Answers what was done, or why not. */
    async copyStyle(ask: Partial<CopyStyleAsk>): Promise<{ text: string } | { problem: string }> {

        const place = this.placeAt(ask.workspace);

        if (!place)
            return { problem: "That workspace is not here any more. Reload the page." };

        const folders = stylesFoldersOf(this.server, place);

        if (typeof ask.styleId !== "string" || !(await styleIds(folders.builtin)).includes(ask.styleId))
            return { problem: "Pick the built-in style to copy." };

        if (ask.place !== "workspace" && ask.place !== "profile")
            return { problem: "Pick where the copy goes." };

        try {

            const done = await ejectStyle(folders, ask.styleId, ask.place === "workspace" ? folders.workspace! : folders.profile, typeof ask.name === "string" ? ask.name : "");

            this.server.toAll({ type: "eesha.specsChanged" });

            return { text: ejectedText(done) };

        } catch (error) {

            return { problem: (error as Error).message };
        }
    }

    /**
     * The tab with this view id shows this spec from now on. A tab that
     * showed it before is told it moved. The controller draws it once the
     * page says it is ready.
     */
    async open(view: string, place: SddPlace, spec: string): Promise<{ ok: true } | { problem: string }> {

        const core = await coreOf(this.server, place);

        if (!(await core.specs()).some(one => one.name === spec))
            return { problem: `There is no spec '${spec}' in ${place.mainFolder}.` };

        // What this tab showed before is let go first.
        this.tabGone(view);

        let found = this.find(place, spec);

        if (found?.view) {

            const before = found.view;

            found.view = undefined;
            found.controller.detach();
            this.server.toTab(before, { type: "eesha.specMoved", workspace: found.place.key, spec: found.spec, ...(found.folder ? { folder: found.folder } : {}) });

            // An idle spec lets go of itself when its tab goes.
            if (found.released)
                found = undefined;
        }

        // A phase that was running when Eesha Code last stopped (closed,
        // or killed) never ended: say so once, so the spec does not just
        // look idle with a half-written phase. Read before the spec is
        // drawn: drawing posts "not busy", which clears it.
        const cutOff = found ? undefined : this.server.store.get<string>(cutOffKey(place, spec));

        const entry = found ?? this.make(place, spec);

        entry.view = view;

        entry.controller.attach({
            post: message => this.posted(entry, message),
            reveal: () => undefined
        });

        await entry.controller.refresh();

        // A Kiro spec New spec just made: its first phase starts now,
        // with the description, as Kiro's own `/spec new` would.
        const start = this.pendingStarts.get(pendingKey(place, spec));

        if (start) {

            this.pendingStarts.delete(pendingKey(place, spec));
            entry.controller.receive({ type: "run", stageId: start.stageId, note: start.note });
        }

        if (cutOff)
            this.server.toTab(view, { type: "eesha.note", text: `The phase '${entry.phaseNames?.get(cutOff) ?? cutOff}' was cut off when Eesha Code stopped while it ran. Its document may be half written - run it again.` });

        return { ok: true };
    }

    /** A message from the SDD editor of the tab with this view id. */
    receive(view: string, message: ToPanel): boolean {

        const entry = [...this.entries].find(one => one.view === view);

        if (!entry)
            return false;

        entry.controller.receive(message);

        return true;
    }

    /**
     * The tab is gone or shows something else now. A spec with a phase
     * running keeps it running and lets go when it ends - see
     * `SddController.detach`.
     */
    tabGone(view: string): void {

        for (const entry of [...this.entries]) {

            if (entry.view !== view)
                continue;

            entry.view = undefined;
            entry.controller.detach();

            if (entry.released)
                this.entries.delete(entry);
        }
    }

    /**
     * Stops listening to every spec, and ends the plan commands still
     * running. A phase still running is left to end with the process; the
     * next open of its spec says it was cut off (see `cutOffKey`).
     */
    close(): void {

        for (const view of new Set([...this.entries].flatMap(entry => entry.view ? [entry.view] : [])))
            this.tabGone(view);

        stopPlanCommands();
    }

    /**
     * SDD's side of a phase chat - see `PhaseOwner`. The spec's own
     * controller answers, made with no tab when no tab shows the spec.
     * Nothing when the spec's workspace or folder is gone.
     */
    ownerOf(chatId: string, workspace: string, link: ChatSpecLink): PhaseOwner | undefined {

        const place = this.placeAt(workspace, link.folder);

        if (!place)
            return undefined;

        const entry = this.find(place, link.spec) ?? this.make(place, link.spec);

        return entry.controller.phaseOwner(chatId, link.phase);
    }

    private find(place: SddPlace, spec: string): SpecEntry | undefined {

        return [...this.entries].find(one => !one.released && one.place.key === place.key && one.place.mainFolder === place.mainFolder && one.spec === spec);
    }

    private make(place: SddPlace, spec: string): SpecEntry {

        const id = `sdd-${++this.made}-${spec}`;

        // Made below, once its controller is. The host's calls below only
        // come later, from the controller, so they always find it.
        let entry: SpecEntry;

        // The folder a phase chat's link names: the spec's own, when it is
        // not the workspace's main folder - see `ChatSpecLink.folder`.
        const main = this.placeAt(place.key)?.mainFolder;
        const folder = main !== undefined && folderKey(main) !== folderKey(place.mainFolder) ? place.mainFolder : undefined;

        const host = serverSddHost(this.server, place, id, {

            note: text => entry.view
                ? this.server.toTab(entry.view, { type: "eesha.note", text })
                : this.server.toAll({ type: "eesha.sddNote", workspace: place.key, text }),

            ask: prompt => entry.view ? this.server.askTab(entry.view, prompt) : Promise.resolve(undefined),

            openFile: file => {

                if (!entry.view)
                    return;

                if (!placeRoots(place).some(folder => isInside(folder, file)))
                    return this.server.toTab(entry.view, { type: "eesha.file", path: file, problem: "Only files inside this workspace open here." });

                const read = readShown(file);

                this.server.toTab(entry.view, "text" in read ? { type: "eesha.file", path: file, text: read.text } : { type: "eesha.file", path: file, problem: read.problem });
            },

            asked: where => {

                this.set(entry, { waiting: true });
                this.server.toAll({ type: "eesha.sddNote", workspace: place.key, text: `The agent in ${where} is waiting for an answer.` });
            },

            redrawAll: async () => {

                for (const one of this.entries)
                    if (one.view && one.place.key === place.key)
                        await one.controller.refresh();
            },

            released: () => {

                entry.released = true;
                clearTimeout(entry.rowTimer);
                this.entries.delete(entry);

                // Let go only when nothing runs - a phase that ended with
                // no tab never told `posted` it ended.
                void this.server.store.update(cutOffKey(place, spec), undefined);
                this.server.toAll({ type: "eesha.specsChanged" });
            }
        }, { name: spec, ...(folder ? { folder } : {}) });

        entry = { place, spec, ...(folder ? { folder } : {}), id, controller: new SddController(host, place.mainFolder, spec), working: false, waiting: false, released: false };

        this.entries.add(entry);

        return entry;
    }

    /** A message from the controller to its tab, and what it says about working and waiting. */
    private posted(entry: SpecEntry, message: ToSddView): void {

        if (message.type === "busy") {

            this.set(entry, message.stageId ? { working: true } : { working: false, waiting: false });
            void this.server.store.update(cutOffKey(entry.place, entry.spec), message.stageId || undefined);
        }

        else if (message.type === "log" && message.meta?.kind === "ask")
            this.set(entry, { waiting: true });

        else if (message.type === "log" && message.meta?.kind === "answer")
            this.set(entry, { waiting: false });

        // The spec was drawn again - after any Markdown save in its
        // folder. Every tab's list is told only when the spec's row
        // (phase, done of total) really moved; see `rowMayHaveMoved`.
        else if (message.type === "spec") {

            entry.phaseNames = new Map(message.spec.stages.map(stage => [stage.name, stage.label ?? stage.name]));
            this.rowMayHaveMoved(entry);
        }

        if (entry.view)
            this.server.toTab(entry.view, { type: "eesha.sdd", workspace: entry.place.key, spec: entry.spec, ...(entry.folder ? { folder: entry.folder } : {}), message });
    }

    /**
     * Reads the spec's row again, once a burst of redraws settles, and
     * tells every tab when it differs from the last one read. During
     * implementation the agent saves many files; without this each save
     * made every open list read the whole workspace again.
     */
    private rowMayHaveMoved(entry: SpecEntry): void {

        clearTimeout(entry.rowTimer);

        entry.rowTimer = setTimeout(() => void this.readRow(entry), ROW_SETTLE_MS);
    }

    private async readRow(entry: SpecEntry): Promise<void> {

        try {

            const core = await coreOf(this.server, entry.place);
            const spec = (await core.specs()).find(one => one.name === entry.spec);
            const row = spec ? JSON.stringify(specRow(spec)) : "";

            if (row === entry.row)
                return;

            entry.row = row;

        } catch (error) {

            logger.warning(`Eesha Code: could not read the row of spec '${entry.spec}'. ${(error as Error).message}`);
        }

        this.server.toAll({ type: "eesha.specsChanged" });
    }

    private set(entry: SpecEntry, change: Partial<Pick<SpecEntry, "working" | "waiting">>): void {

        const before = `${entry.working}${entry.waiting}`;

        Object.assign(entry, change);

        if (`${entry.working}${entry.waiting}` !== before)
            this.server.toAll({ type: "eesha.specsChanged" });
    }
}

/** Where the store keeps the phase of a spec that is running now - read on the next start to say it was cut off. */
function cutOffKey(place: SddPlace, spec: string): string {

    return `${sddStorePrefix(place.key)}eesha.cutOff/${spec}`;
}

/** What the source needs pointing at, from the window's answers for New Spec. */
function pointerOf(source: string, ask: Partial<NewSpecAsk>): Pointer | { problem: string } {

    const text = typeof ask.text === "string" ? ask.text.trim() : "";

    if (source === "ado" || source === "gh") {

        if (!text)
            return { problem: source === "ado" ? "Type the work item id, or paste its link." : "Type the issue number, or paste its link." };

        return pointerFor(text);
    }

    if (source === "file") {

        const files = Array.isArray(ask.files) ? ask.files.filter((one): one is string => typeof one === "string" && one.trim() !== "").map(one => one.trim()) : [];

        if (!files.length)
            return { problem: "Name at least one file with the ask, as a full path." };

        for (const file of files) {

            if (!path.isAbsolute(file))
                return { problem: `Not a full path: ${file}` };

            try {

                if (!fs.statSync(file).isFile())
                    return { problem: `Not a file: ${file}` };

            } catch {

                return { problem: `No such file: ${file}` };
            }
        }

        return { files };
    }

    // An empty line is allowed: idea.md then says nothing was recorded.
    return { description: text || undefined };
}

/** For the log when a spec cannot be read. */
export function specProblem(error: unknown): { problem: string } {

    const text = (error as Error).message ?? String(error);

    logger.warning(`Eesha Code: SDD failed. ${text}`);

    return { problem: text };
}
