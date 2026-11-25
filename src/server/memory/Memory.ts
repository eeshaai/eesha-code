import * as fs from "fs";
import * as path from "path";

import type { PathMatch } from "../../shared/composeFiles";
import { capped, schema, text, ToolError, whole } from "../connectors/tools";
import { folderKey, type MemoryChoices, type MemoryEdit, type MemoryGroup, type MemoryLevel, type MemoryRow, type MemoryView, type Workspace, workspaceKey } from "../protocol";
import { readMemoryChoices } from "./config";
import { MEMORY_LEVELS, type MemoryScope, MemoryStore, textProblem, titleProblem } from "./memoryStore";

/*
 * Memory as one service for the server: the tools the AI calls through
 * `eesha mcp`, the lines a new session is told, the compose box's
 * `>memory` rows, and the Memory page.
 *
 * It is ours, not a runtime's: the same memories reach Kiro, Claude and
 * Copilot sessions, through tools on Eesha Code's own MCP server.
 *
 * The choices (off, read, read and write; ask before a save) are read
 * from settings.json on every use, so a change counts at once.
 */

/** The first level of a memory's `>` path: `>memory>global>12`. */
export const MEMORY_PATH = "memory";

/** Every memory tool's name starts with this - how a call is told from a connector's. */
export const MEMORY_TOOL_PREFIX = "memory_";

/** How many titles a new session is told. The rest are found with memory_search. */
const TITLES_TOLD = 60;

/** The most a `>memory` path puts of one memory's text into a message, in characters. */
const REFERENCE_TEXT = 4000;

/** What a session can reach: its workspace, when it is in one, and its folders. */
export interface SessionPlace {

    workspace?: { key: string; name: string };

    /** Full paths. Never the scratch folder. */
    folders: readonly string[];
}

/** A save, change or delete the person is asked about first - the same shape a connector's write has. */
export interface MemoryQuestion {

    connector: "memory";

    tool: string;

    text: string;
}

/** What a tool call needs from the session it came from. */
export interface MemoryCallHooks {

    /** Asks the person in the session's tab. False: no, or nobody to ask. */
    ask(question: MemoryQuestion): Promise<boolean>;

    /** A short notice in the session's tab: what was saved, changed or deleted. */
    note(text: string): void;
}

export interface MemoryDeps {

    store: MemoryStore;

    /** For tests: the choices, in place of settings.json. */
    readChoices?(): MemoryChoices;
}

interface MemoryTool {

    name: string;

    description: string;

    inputSchema: Record<string, unknown>;

    write: boolean;
}

const LEVEL_HELP = "'global' for a fact about the person and how they like to work, true in every project; "
    + "'workspace' for a fact about the work item this workspace is for; "
    + "'folder' for a fact about the code in one folder, true for any work done there";

const TOOLS: readonly MemoryTool[] = [
    {
        name: "memory_list",
        description: "Lists the memories this session can use: id, level and title of each. Memories are short facts saved in earlier sessions, "
            + "by the person or by an agent, to be used again. Read one with memory_read before you rely on it.",
        inputSchema: schema({ level: { type: "string", enum: [...MEMORY_LEVELS], description: "Only this level. Leave out for all." } }),
        write: false
    },
    {
        name: "memory_search",
        description: "Finds the memories this session can use whose title or text has every word of the query. Case does not matter.",
        inputSchema: schema({ query: { type: "string", description: "The words to look for." } }, ["query"]),
        write: false
    },
    {
        name: "memory_read",
        description: "Reads one memory in full, by its id.",
        inputSchema: schema({ id: { type: "integer", description: "The memory's id, from memory_list or memory_search." } }, ["id"]),
        write: false
    },
    {
        name: "memory_save",
        description: "Saves a fact that will still be true and useful in a later session: a preference of the person, a decision and its reason, "
            + "or a fact about this code that the code itself does not say. One fact per memory. "
            + `Pick the level: ${LEVEL_HELP}. `
            + "Give id to change a memory that is already there, instead of adding a second one about the same thing - its level stays as it is. "
            + "Do not save secrets, passwords or keys. Do not save what the code or git history already records, or what only matters in this session.",
        inputSchema: schema({
            level: { type: "string", enum: [...MEMORY_LEVELS], description: `Who gets it: ${LEVEL_HELP}. Needed for a new memory.` },
            title: { type: "string", description: "One short line that says what the fact is about." },
            text: { type: "string", description: "The fact itself, in plain sentences. Say why it holds when that is not obvious." },
            folder: { type: "string", description: "For level 'folder' when this session has more than one folder: the folder's full path." },
            id: { type: "integer", description: "Change this memory instead of adding a new one." }
        }, ["title", "text"]),
        write: true
    },
    {
        name: "memory_delete",
        description: "Deletes one memory that is wrong or no longer true, by its id. It cannot be brought back.",
        inputSchema: schema({ id: { type: "integer", description: "The memory's id." } }, ["id"]),
        write: true
    }
];

/** The scopes a session reads: global, its workspace, each of its folders. */
export function scopesOf(place: SessionPlace): MemoryScope[] {

    return [
        { level: "global", owner: "" },
        ...(place.workspace ? [{ level: "workspace" as const, owner: place.workspace.key }] : []),
        ...place.folders.map(folder => ({ level: "folder" as const, owner: folderKey(folder) }))
    ];
}

/** Where a memory belongs, in words: "global", "workspace Login bug", "folder C:\src\api". */
function whereOf(row: Pick<MemoryRow, "level" | "owner" | "place">, place?: SessionPlace): string {

    if (row.level === "global")
        return "global";

    if (row.level === "workspace")
        return place?.workspace && place.workspace.key === row.owner ? `workspace ${place.workspace.name}` : "workspace";

    return `folder ${row.place || row.owner}`;
}

/** A memory as a tool answers with it, without its text. */
function brief(row: MemoryRow, place: SessionPlace) {

    return { id: row.id, level: row.level, ...(row.level === "global" ? {} : { where: whereOf(row, place) }), title: row.title };
}

export class Memory {

    readonly store: MemoryStore;

    constructor(private readonly deps: MemoryDeps) {

        this.store = deps.store;
    }

    choices(): MemoryChoices {

        return this.deps.readChoices ? this.deps.readChoices() : readMemoryChoices();
    }

    /** Whether sessions get the memory at all. */
    on(): boolean {

        return this.choices().access !== "off";
    }

    // ---------------------------------------------------------------
    // The AI's tools
    // ---------------------------------------------------------------

    /** The tools the choices allow now. */
    private allowed(): readonly MemoryTool[] {

        const { access } = this.choices();

        return access === "off" ? [] : TOOLS.filter(tool => !tool.write || access === "write");
    }

    /** The MCP tool list. */
    tools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {

        return this.allowed().map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    }

    /** Whether a tool saves, changes or deletes a memory. A name that is no memory tool counts as one that does. */
    writes(name: string): boolean {

        return TOOLS.find(tool => tool.name === name)?.write !== false;
    }

    /** One memory the session can reach, or an error the AI is told. */
    private reachable(id: number, place: SessionPlace): MemoryRow {

        const row = this.store.get(id);

        if (!row || !scopesOf(place).some(scope => scope.level === row.level && scope.owner === row.owner))
            throw new ToolError(`There is no memory ${id} this session can use. List them with memory_list.`);

        return row;
    }

    /** The owner and shown place of a new memory at `level`. */
    private target(level: MemoryLevel, folder: string | undefined, place: SessionPlace): { owner: string; place: string } {

        if (level === "global")
            return { owner: "", place: "" };

        if (level === "workspace") {

            if (!place.workspace)
                throw new ToolError("This session is in no workspace. Save it as 'global' or 'folder'.");

            return { owner: place.workspace.key, place: "" };
        }

        if (!place.folders.length)
            throw new ToolError("This session has no folder. Save it as 'global'.");

        if (folder === undefined) {

            if (place.folders.length > 1)
                throw new ToolError(`This session has several folders. Give folder as one of: ${place.folders.join(", ")}.`);

            return { owner: folderKey(place.folders[0]!), place: place.folders[0]! };
        }

        const found = place.folders.find(one => folderKey(one) === folderKey(folder));

        if (!found)
            throw new ToolError(`${folder} is not one of this session's folders: ${place.folders.join(", ")}.`);

        return { owner: folderKey(found), place: found };
    }

    /**
     * Runs one tool call. A tool the choices do not allow is refused even
     * when a runtime calls it. A save, change or delete asks the person
     * first when they chose that; else it runs and a notice says what it did.
     */
    async call(name: string, args: unknown, place: SessionPlace, hooks: MemoryCallHooks): Promise<{ text: string; isError?: boolean }> {

        const tool = this.allowed().find(one => one.name === name);

        if (!tool)
            return { text: `${name} is not allowed. The person chooses what the memory allows in Settings, under Connectors.`, isError: true };

        const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};

        try {

            return { text: JSON.stringify(await this.run(tool.name, input, place, hooks), undefined, 1) };

        } catch (error) {

            if (error instanceof ToolError)
                return { text: error.message, isError: true };

            return { text: `${name} failed: ${(error as Error).message}`, isError: true };
        }
    }

    private async run(name: string, input: Record<string, unknown>, place: SessionPlace, hooks: MemoryCallHooks): Promise<unknown> {

        const scopes = scopesOf(place);
        const asking = this.choices().askOnSave;

        const confirm = async (question: string): Promise<void> => {

            if (asking && !await hooks.ask({ connector: "memory", tool: name, text: question }))
                throw new ToolError("The person said no. Nothing was changed.");
        };

        switch (name) {

            case "memory_list": {

                const level = text(input, "level");

                if (level !== undefined && !MEMORY_LEVELS.includes(level as MemoryLevel))
                    throw new ToolError("level must be global, workspace or folder.");

                return this.store.list(scopes).filter(row => level === undefined || row.level === level).map(row => brief(row, place));
            }

            case "memory_search":
                return this.store.search(scopes, text(input, "query", true)).map(row => brief(row, place));

            case "memory_read": {

                const row = this.reachable(whole(input, "id", true), place);

                return { ...brief(row, place), text: row.text, savedBy: row.author === "ai" ? "an agent" : "the person" };
            }

            case "memory_save": {

                const title = text(input, "title", true);
                const body = text(input, "text", true);
                const problem = titleProblem(title) ?? textProblem(body);

                if (problem)
                    throw new ToolError(problem);

                const id = whole(input, "id");

                if (id !== undefined) {

                    const before = this.reachable(id, place);

                    await confirm(`Change the ${whereOf(before, place)} memory "${before.title}" to:\n${title.trim()}\n${body.trim()}`);

                    const row = this.store.update(id, { title, text: body })!;

                    if (!asking)
                        hooks.note(`Memory changed (${whereOf(row, place)}): ${row.title}`);

                    return { saved: brief(row, place) };
                }

                const level = text(input, "level");

                if (!MEMORY_LEVELS.includes(level as MemoryLevel))
                    throw new ToolError("Give level for a new memory: global, workspace or folder.");

                const target = this.target(level as MemoryLevel, text(input, "folder"), place);

                await confirm(`Save a ${whereOf({ level: level as MemoryLevel, ...target }, place)} memory:\n${title.trim()}\n${body.trim()}`);

                const row = this.store.add({ level: level as MemoryLevel, ...target, title, text: body, author: "ai" });

                if (!asking)
                    hooks.note(`Memory saved (${whereOf(row, place)}): ${row.title}`);

                return { saved: brief(row, place) };
            }

            case "memory_delete": {

                const row = this.reachable(whole(input, "id", true), place);

                await confirm(`Delete the ${whereOf(row, place)} memory "${row.title}"? It cannot be brought back.`);

                this.store.remove(row.id);

                if (!asking)
                    hooks.note(`Memory deleted (${whereOf(row, place)}): ${row.title}`);

                return { deleted: row.id };
            }
        }

        throw new ToolError(`${name} is not a memory tool.`);
    }

    // ---------------------------------------------------------------
    // What a new session is told
    // ---------------------------------------------------------------

    /**
     * The lines about memory in a session's standing instructions: how to
     * use it, and the titles saved now. Nothing when memory is off.
     */
    instructions(place: SessionPlace): string | undefined {

        const { access } = this.choices();

        if (access === "off")
            return undefined;

        const rows = this.store.list(scopesOf(place));
        const told = rows.slice(0, TITLES_TOLD);

        const lines = [
            "Eesha Code keeps a memory: short facts saved in earlier sessions, by the person or by an agent. "
                + `Its tools are ${this.allowed().map(tool => tool.name).join(", ")}.`,
            "- Before you start a task, look at the titles below and read the ones that could matter with memory_read.",
            ...(access === "write"
                ? [
                    "- When you learn something that will still be true and useful in a later session, save it with memory_save: "
                        + "a preference of the person, a decision and its reason, a fact about this code that the code does not say. "
                        + `Levels: ${LEVEL_HELP}.`,
                    "- When a memory turns out to be wrong, change it (memory_save with its id) or delete it (memory_delete).",
                    "- Do not save secrets, or what only matters in this session."
                ]
                : ["- You may read the memory. You may not change it."]),
            told.length ? "Saved now, as id (where) title:" : "Nothing is saved yet.",
            ...told.map(row => `- ${row.id} (${whereOf(row, place)}) ${row.title}`),
            ...(rows.length > told.length ? [`- and ${rows.length - told.length} more - find them with memory_search.`] : [])
        ];

        return lines.join("\n");
    }

    // ---------------------------------------------------------------
    // The compose box
    // ---------------------------------------------------------------

    /** The row that opens memory in the `>` list's first level, when it is on and matches what was typed. */
    rootRow(query: string): PathMatch[] {

        return this.on() && MEMORY_PATH.includes(query.toLowerCase()) ? [{ name: MEMORY_PATH, detail: "Saved memories" }] : [];
    }

    /**
     * The rows for a `>memory` path being typed. `below`: the levels after
     * `memory`. First the three levels, then that level's memories by id.
     */
    search(below: readonly string[], query: string, place: SessionPlace): PathMatch[] {

        if (!this.on())
            return [{ name: "off", detail: "Memory is off - turn it on in Settings, under Connectors.", disabled: true }];

        const scopes = scopesOf(place);
        const words = query.toLowerCase();

        if (!below.length) {

            const has = (level: MemoryLevel) => scopes.some(scope => scope.level === level);
            const count = (level: MemoryLevel) => this.store.list(scopes.filter(scope => scope.level === level)).length;

            const levels: PathMatch[] = [
                { name: "global", detail: `Every session - ${count("global")} saved` },
                has("workspace")
                    ? { name: "workspace", detail: `${place.workspace!.name} - ${count("workspace")} saved` }
                    : { name: "workspace", detail: "This session is in no workspace.", disabled: true },
                has("folder")
                    ? { name: "folder", detail: `This session's folders - ${count("folder")} saved` }
                    : { name: "folder", detail: "This session has no folder.", disabled: true }
            ];

            return levels.filter(row => row.name.includes(words));
        }

        const level = below[0]!.toLowerCase() as MemoryLevel;

        if (below.length > 1 || !MEMORY_LEVELS.includes(level))
            return [];

        const rows = this.store.list(scopes.filter(scope => scope.level === level))
            .filter(row => String(row.id).includes(words) || row.title.toLowerCase().includes(words));

        if (!rows.length)
            return [{ name: "none", detail: query ? "No memory matches." : "Nothing saved here yet.", disabled: true }];

        const severalFolders = level === "folder" && place.folders.length > 1;

        return rows.map(row => ({
            name: String(row.id),
            detail: severalFolders ? `${path.basename(row.place || row.owner)} - ${row.title}` : row.title,
            leaf: true
        }));
    }

    /**
     * What one `>memory>level>id` path points at: the memory, as lines for
     * the AI. `below`: the levels after `memory`.
     */
    reference(below: readonly string[], place: SessionPlace): { line?: string; problem?: string } {

        if (!this.on())
            return { problem: "memory is off" };

        const [level = "", id = ""] = below;

        if (below.length !== 2 || !MEMORY_LEVELS.includes(level.toLowerCase() as MemoryLevel) || !/^\d+$/.test(id))
            return { problem: "write it as >memory>global>12" };

        const row = this.store.get(Number(id));

        if (!row || row.level !== level.toLowerCase() || !scopesOf(place).some(scope => scope.level === row.level && scope.owner === row.owner))
            return { problem: `no ${level.toLowerCase()} memory ${id} for this session` };

        return { line: `Memory ${row.id} (${whereOf(row, place)}) - ${row.title}:\n${capped(row.text, REFERENCE_TEXT)}` };
    }

    // ---------------------------------------------------------------
    // The Memory page
    // ---------------------------------------------------------------

    /** Every memory in groups: Global first, then each workspace's, then each folder's. */
    view(workspaces: readonly Workspace[], folders: readonly string[]): MemoryView {

        const all = this.store.all();
        const groups: MemoryGroup[] = [{ level: "global", owner: "", label: "Global", memories: all.filter(row => row.level === "global") }];

        for (const owner of [...new Set(all.filter(row => row.level === "workspace").map(row => row.owner))]) {

            const workspace = workspaces.find(one => workspaceKey(one) === owner);

            groups.push({
                level: "workspace",
                owner,
                label: workspace?.name ?? owner,
                ...(!workspace ? { missing: "gone" as const } : workspace.archived ? { missing: "archived" as const } : {}),
                memories: all.filter(row => row.level === "workspace" && row.owner === owner)
            });
        }

        for (const owner of [...new Set(all.filter(row => row.level === "folder").map(row => row.owner))]) {

            const memories = all.filter(row => row.level === "folder" && row.owner === owner);
            const label = memories[0]?.place || owner;

            groups.push({ level: "folder", owner, label, ...(fs.existsSync(label) ? {} : { missing: "gone" as const }), memories });
        }

        const known: string[] = [];

        for (const folder of [...workspaces.flatMap(one => one.folders), ...folders])
            if (!known.some(one => folderKey(one) === folderKey(folder)))
                known.push(folder);

        return {
            choices: this.choices(),
            groups,
            workspaces: workspaces.filter(one => !one.archived).map(one => ({ key: workspaceKey(one), name: one.name })),
            folders: known
        };
    }

    /** Adds a memory the person wrote, or changes one - its text, or where it belongs. */
    save(edit: unknown, workspaces: readonly Workspace[]): { problem: string } | { ok: true } {

        const one = edit && typeof edit === "object" ? edit as Partial<MemoryEdit> : {};
        const problem = titleProblem(one.title) ?? textProblem(one.text);

        if (problem)
            return { problem };

        if (!MEMORY_LEVELS.includes(one.level as MemoryLevel))
            return { problem: "Pick where the memory belongs: global, a workspace or a folder." };

        const before = one.id === undefined ? undefined : this.store.get(one.id);

        if (one.id !== undefined && !before)
            return { problem: "That memory is gone - load the page again." };

        let owner = "";
        let place = "";

        if (one.level === "workspace") {

            // The workspace it is already in may be archived or gone: it can stay there.
            const stays = before?.level === "workspace" && before.owner === one.owner;

            if (typeof one.owner !== "string" || (!stays && !workspaces.some(workspace => workspaceKey(workspace) === one.owner)))
                return { problem: "Pick the workspace the memory belongs to." };

            owner = one.owner;
        }

        if (one.level === "folder") {

            if (typeof one.owner !== "string" || !path.isAbsolute(one.owner.trim()))
                return { problem: "Give the folder as a full path." };

            const stays = before?.level === "folder" && before.owner === folderKey(one.owner.trim());

            place = stays ? before.place : path.resolve(one.owner.trim());
            owner = folderKey(place);
        }

        if (before)
            this.store.update(before.id, { level: one.level!, owner, place, title: one.title!, text: one.text! });
        else
            this.store.add({ level: one.level!, owner, place, title: one.title!, text: one.text!, author: "person" });

        return { ok: true };
    }

    remove(id: unknown): { problem: string } | { ok: true } {

        if (typeof id !== "number" || !this.store.remove(id))
            return { problem: "That memory is gone - load the page again." };

        return { ok: true };
    }

    /** A folder was moved or renamed: its memories go to the folder it is now. */
    repoint(from: unknown, to: unknown): { problem: string } | { ok: true } {

        if (typeof from !== "string" || !from)
            return { problem: "Say which folder's memories to move." };

        if (typeof to !== "string" || !path.isAbsolute(to.trim()))
            return { problem: "Give the new folder as a full path." };

        const place = path.resolve(to.trim());

        if (!fs.existsSync(place))
            return { problem: `${place} is not on this machine.` };

        if (!this.store.repoint(from, folderKey(place), place))
            return { problem: "That folder has no memories - load the page again." };

        return { ok: true };
    }
}
