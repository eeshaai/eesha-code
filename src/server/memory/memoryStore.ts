import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

import type { MemoryAuthor, MemoryLevel, MemoryRow } from "../protocol";

/*
 * Where the memories are kept: one SQLite file, ~/.eesha/memory.db.
 *
 * A memory is a short fact with a title, saved to be used again in a
 * later session. It belongs to one level:
 *
 *   global     every session gets it. `owner` is empty.
 *   workspace  only sessions of one workspace. `owner` is the workspace's key.
 *   folder     any session that has one folder. `owner` is the folder's
 *              key (see `folderKey`), and `place` is the folder's path as
 *              it was written, for showing.
 *
 * Nothing is ever written inside a folder of the person's code, so git
 * never sees a memory.
 */

export const MEMORY_LEVELS: readonly MemoryLevel[] = ["global", "workspace", "folder"];

/** The longest title, in characters. One line. */
export const TITLE_LIMIT = 120;

/** The longest text, in characters. */
export const TEXT_LIMIT = 8000;

/** One level's owner: every memory of that level with that owner. */
export interface MemoryScope {

    level: MemoryLevel;

    owner: string;
}

export interface NewMemory {

    level: MemoryLevel;

    owner: string;

    place: string;

    title: string;

    text: string;

    author: MemoryAuthor;
}

interface StoredRow {
    id: number | bigint;
    level: string;
    owner: string;
    place: string;
    title: string;
    body: string;
    author: string;
    created: number | bigint;
    updated: number | bigint;
}

const COLUMNS = "id, level, owner, place, title, body, author, created, updated";

function rowOf(stored: StoredRow): MemoryRow {

    return {
        id: Number(stored.id),
        level: stored.level as MemoryLevel,
        owner: stored.owner,
        place: stored.place,
        title: stored.title,
        text: stored.body,
        author: stored.author as MemoryAuthor,
        created: Number(stored.created),
        updated: Number(stored.updated)
    };
}

/** Why a title cannot be saved, or nothing when it can. */
export function titleProblem(title: unknown): string | undefined {

    if (typeof title !== "string" || !title.trim())
        return "Give the memory a title.";

    if (title.trim().length > TITLE_LIMIT || /[\r\n]/.test(title.trim()))
        return `A memory's title is one line of up to ${TITLE_LIMIT} characters.`;

    return undefined;
}

/** Why a text cannot be saved, or nothing when it can. */
export function textProblem(text: unknown): string | undefined {

    if (typeof text !== "string" || !text.trim())
        return "Give the memory its text.";

    if (text.trim().length > TEXT_LIMIT)
        return `A memory's text is up to ${TEXT_LIMIT} characters. Save a shorter one, or split it into two memories.`;

    return undefined;
}

export class MemoryStore {

    private database?: DatabaseSync;

    /** @param file The database file. ":memory:" keeps it in memory only - the tests. */
    constructor(private readonly file: string) {}

    /** Opened on first use, so a server that never touches a memory makes no file. */
    private open(): DatabaseSync {

        if (this.database)
            return this.database;

        if (this.file !== ":memory:")
            fs.mkdirSync(path.dirname(this.file), { recursive: true });

        const database = new DatabaseSync(this.file);

        database.exec(`
            create table if not exists memories (
                id integer primary key autoincrement,
                level text not null,
                owner text not null default '',
                place text not null default '',
                title text not null,
                body text not null,
                author text not null,
                created integer not null,
                updated integer not null
            );
            create index if not exists memories_by_owner on memories (level, owner);
        `);

        this.database = database;

        return database;
    }

    close(): void {

        this.database?.close();
        this.database = undefined;
    }

    /** Every memory, the most recently changed first. */
    all(): MemoryRow[] {

        const rows = this.open().prepare(`select ${COLUMNS} from memories order by updated desc, id desc`).all() as unknown as StoredRow[];

        return rows.map(rowOf);
    }

    /** The memories of these scopes, the most recently changed first. */
    list(scopes: readonly MemoryScope[]): MemoryRow[] {

        if (!scopes.length)
            return [];

        const where = scopes.map(() => "(level = ? and owner = ?)").join(" or ");
        const values = scopes.flatMap(scope => [scope.level, scope.owner]);

        const rows = this.open()
            .prepare(`select ${COLUMNS} from memories where ${where} order by updated desc, id desc`)
            .all(...values) as unknown as StoredRow[];

        return rows.map(rowOf);
    }

    /**
     * The memories of these scopes whose title or text has every word of
     * `query`. Case does not matter. An empty query finds them all.
     */
    search(scopes: readonly MemoryScope[], query: string): MemoryRow[] {

        const words = query.toLowerCase().split(/\s+/).filter(Boolean);

        return this.list(scopes).filter(row => {

            const hay = `${row.title}\n${row.text}`.toLowerCase();

            return words.every(word => hay.includes(word));
        });
    }

    get(id: number): MemoryRow | undefined {

        const row = this.open().prepare(`select ${COLUMNS} from memories where id = ?`).get(id) as unknown as StoredRow | undefined;

        return row ? rowOf(row) : undefined;
    }

    add(memory: NewMemory, now: number = Date.now()): MemoryRow {

        const result = this.open()
            .prepare("insert into memories (level, owner, place, title, body, author, created, updated) values (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(memory.level, memory.owner, memory.place, memory.title.trim(), memory.text.trim(), memory.author, now, now);

        return this.get(Number(result.lastInsertRowid))!;
    }

    /** Changes what is given. Nothing when there is no such memory. */
    update(id: number, change: Partial<Pick<NewMemory, "level" | "owner" | "place" | "title" | "text">>, now: number = Date.now()): MemoryRow | undefined {

        const before = this.get(id);

        if (!before)
            return undefined;

        this.open()
            .prepare("update memories set level = ?, owner = ?, place = ?, title = ?, body = ?, updated = ? where id = ?")
            .run(
                change.level ?? before.level,
                change.owner ?? before.owner,
                change.place ?? before.place,
                (change.title ?? before.title).trim(),
                (change.text ?? before.text).trim(),
                now,
                id);

        return this.get(id);
    }

    /** False when there was no such memory. */
    remove(id: number): boolean {

        return Number(this.open().prepare("delete from memories where id = ?").run(id).changes) > 0;
    }

    /**
     * Gives every memory of one folder to another folder - the folder was
     * moved or renamed. Returns how many were moved.
     */
    repoint(fromOwner: string, toOwner: string, toPlace: string): number {

        return Number(this.open()
            .prepare("update memories set owner = ?, place = ? where level = 'folder' and owner = ?")
            .run(toOwner, toPlace, fromOwner).changes);
    }
}
