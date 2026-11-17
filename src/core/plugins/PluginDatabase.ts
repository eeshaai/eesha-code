import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { PluginDb } from "./Plugin";
import { isPluginId } from "./PluginRef";

/**
 * Storage for plugins: one SQLite file per plugin id, in a folder of
 * their own beside the run database.
 *
 * A file per plugin rather than prefixed tables in one file. The prefix
 * would have to be enforced by rewriting the plugin's SQL, and a bug in
 * that rewrite is a plugin reaching another plugin's rows - or the run
 * history. A separate file needs no rewrite: whatever the plugin writes,
 * it lands in its own file.
 *
 * Opened on first use and kept open; closed with the engine.
 */
export class PluginDatabase {

    private readonly open = new Map<string, DatabaseSync>();

    private closed = false;

    /** @param directory Where the files go - created on first use. */
    constructor(private readonly directory: string) {}

    /** The three calls a plugin gets - see {@link PluginDb}. */
    public for(pluginId: string): PluginDb {

        return {
            run: async (sql, params) => {

                const result = this.statement(pluginId, sql).run(...spread(params));

                return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
            },

            get: async (sql, params) =>
                this.statement(pluginId, sql).get(...spread(params)) as Record<string, unknown> | undefined,

            all: async (sql, params) =>
                this.statement(pluginId, sql).all(...spread(params)) as Record<string, unknown>[]
        };
    }

    /** Where a plugin's file is, whether or not it exists yet. */
    public pathFor(pluginId: string): string {

        if (!isPluginId(pluginId))
            throw new Error(`'${pluginId}' is not a plugin id.`);

        return path.join(this.directory, `${pluginId}.db`);
    }

    public close(): void {

        if (this.closed)
            return;

        this.closed = true;

        for (const db of this.open.values())
            try {

                db.close();

            } catch {

                // Shutting down; nothing left to fail into.
            }

        this.open.clear();
    }

    private statement(pluginId: string, sql: string) {

        if (this.closed)
            throw new Error("The plugin database is closed.");

        return this.connection(pluginId).prepare(String(sql));
    }

    private connection(pluginId: string): DatabaseSync {

        const known = this.open.get(pluginId);

        if (known)
            return known;

        const file = this.pathFor(pluginId);

        fs.mkdirSync(this.directory, { recursive: true });

        const db = new DatabaseSync(file);

        // Same reason as the run store: WAL's shared memory can crash the
        // app when two windows use one workspace.
        try {

            db.exec("PRAGMA journal_mode = DELETE;");

        } catch {

            // A database that will not take the change is left as it is.
        }

        this.open.set(pluginId, db);

        return db;
    }
}

/**
 * `node:sqlite` binds positional params as separate arguments and named
 * ones as one object. A plugin passes either an array or an object.
 */
function spread(params: unknown[] | Record<string, unknown> | undefined): never[] {

    if (params === undefined)
        return [];

    return (Array.isArray(params) ? params : [params]) as never[];
}
