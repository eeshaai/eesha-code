import { createHash } from "crypto";
import * as fs from "fs";

import { writeAtomic } from "../paths";
import type { ConnectorId } from "./config";

/*
 * What the connectors keep so they do not ask ADO and GitHub again and
 * again. Two stores, both owned by one `Connectors`:
 *
 * 1. Lists - repos, pipelines, wiki pages and so on. Each kind has its
 *    own time (`FRESH_MS`). They are also written to
 *    ~/.eesha/cache/connectors.json, so they survive a restart. A
 *    list kept past its time can still be shown in the `>` picker
 *    while a fresh one is fetched; the AI's tools always wait for the
 *    fresh one.
 * 2. Version tags - for every other read, the last answer and the tag
 *    the service gave it. The next read of the same address sends the
 *    tag, and "not changed" (304) gives the kept answer. In memory only.
 *
 * Every key holds the signed-in account (`accountOf`), so a different
 * account never sees what the last one was shown. No token is ever
 * written, only a short hash.
 */

const MINUTE = 60_000;

/** The kinds of lists kept, each with its own time. */
export const FRESH_MS = {
    /** The orgs, projects and repos the Connect window offers. */
    offered: 60 * MINUTE,
    /** The signed-in person's id in an ADO org. */
    me: 24 * 60 * MINUTE,
    /** An ADO project's repos. */
    repos: 30 * MINUTE,
    /** An ADO project's build or release pipelines. */
    pipelines: 30 * MINUTE,
    /** One GitHub repo's details, like its default branch. */
    repo: 30 * MINUTE,
    queries: 30 * MINUTE,
    wikis: 60 * MINUTE,
    wikipages: 10 * MINUTE,
    testplans: 30 * MINUTE,
    workflows: 30 * MINUTE,
    /** Which commit a branch is on now. */
    head: MINUTE,
    /** All file paths at one commit. A commit never changes, so no time. */
    tree: Infinity
} as const;

export type CacheKind = keyof typeof FRESH_MS;

/**
 * How a caller takes a list kept past its time:
 * - `wait`: fetch a fresh one and wait for it (the AI's tools).
 * - `stale`: take the old one now, fetch a fresh one behind it (the picker).
 * - `reload`: fetch a fresh one even when the kept one is in time (the refresh row).
 */
export type CacheMode = "wait" | "stale" | "reload";

/** A list not used for this long is dropped. */
const UNUSED_MS = 7 * 24 * 60 * MINUTE;

/** The most the lists may take, in characters of JSON - in memory, and on disk. */
const MEMORY_CHARS = 64 * 1024 * 1024;

const DISK_CHARS = 20 * 1024 * 1024;

/** A list larger than this stays in memory only. */
const DISK_ONE_CHARS = 4 * 1024 * 1024;

/** The most the version-tag answers may take, and the largest one kept. */
const TAGGED_CHARS = 32 * 1024 * 1024;

const TAGGED_ONE_CHARS = 4 * 1024 * 1024;

/** How long after a change the file is written. */
const SAVE_DELAY_MS = 2_000;

const FILE_VERSION = 1;

interface Entry {

    /** When it was fetched. */
    at: number;

    /** When it was last given out. */
    used: number;

    value: unknown;

    /** Its size in characters of JSON. */
    chars: number;
}

/** A read's last answer, and what the service tagged it with. */
export interface Tagged {

    etag?: string;

    modified?: string;

    body: string;
}

/**
 * Who a token belongs to, as a short hash. ADO's tokens carry the
 * person's directory and object ids, which stay the same when az hands
 * out a new token. GitHub's do not change until the next sign-in, so the
 * token's own hash names the account.
 */
export function accountOf(id: ConnectorId, token: string): string {

    let seed = `${id}:${token}`;

    if (id === "ado") {

        try {

            const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { oid?: string; tid?: string };

            if (claims.oid)
                seed = `ado:${claims.tid ?? ""}:${claims.oid}`;

        } catch {

            // Not a JWT - the token's own hash, below.
        }
    }

    return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

export class ConnectorCache {

    private readonly lists = new Map<string, Entry>();

    private readonly loading = new Map<string, Promise<unknown>>();

    /** Counts each connector's clears, so a fetch that began before one is not kept. */
    private readonly cleared = new Map<ConnectorId, number>();

    private readonly tagged = new Map<string, Tagged & { chars: number }>();

    private taggedChars = 0;

    private read = false;

    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    /** `file`: where the lists are written. Nothing: memory only - the tests. */
    constructor(private readonly file?: string) { }

    // ---------------------------------------------------------------
    // Lists
    // ---------------------------------------------------------------

    /**
     * The list kept under `key`, or `load`'s answer - see `CacheMode`.
     * `onSaved` hears when the answer is a kept one, with when it was fetched.
     */
    async list<T>(connector: ConnectorId, account: string, kind: CacheKind, key: string, load: () => Promise<T>,
        mode: CacheMode, onSaved?: (at: number) => void): Promise<T> {

        this.readFile();

        const full = `${connector}:${account}:${kind}:${key.toLowerCase()}`;
        const found = this.lists.get(full);
        const now = Date.now();

        if (found && mode !== "reload") {

            const inTime = now - found.at < FRESH_MS[kind];

            if (inTime || mode === "stale") {

                found.used = now;

                if (!inTime)
                    void this.fetch(connector, full, load).catch(() => undefined);

                onSaved?.(found.at);

                return found.value as T;
            }
        }

        return this.fetch(connector, full, load);
    }

    /** One fetch per key at a time; its answer is kept unless the connector was cleared meanwhile. */
    private fetch<T>(connector: ConnectorId, full: string, load: () => Promise<T>): Promise<T> {

        const running = this.loading.get(full);

        if (running)
            return running as Promise<T>;

        const generation = this.cleared.get(connector) ?? 0;

        const started = load().then(value => {

            if ((this.cleared.get(connector) ?? 0) === generation)
                this.keep(full, value);

            return value;

        }).finally(() => {

            // A clear may have dropped it already, and a newer fetch taken its place.
            if (this.loading.get(full) === started)
                this.loading.delete(full);
        });

        this.loading.set(full, started);

        return started;
    }

    private keep(full: string, value: unknown): void {

        const now = Date.now();
        const chars = JSON.stringify(value ?? null).length;

        this.lists.set(full, { at: now, used: now, value, chars });
        this.trim(this.lists, MEMORY_CHARS);
        this.saveSoon();
    }

    /**
     * Drops what is kept for a connector. `all`: the version tags too and
     * every account - after a sign-in or a Disconnect. Otherwise only the
     * lists - after a write, which may have changed one.
     */
    clear(connector: ConnectorId, all = false): void {

        this.readFile();
        this.cleared.set(connector, (this.cleared.get(connector) ?? 0) + 1);

        for (const key of [...this.loading.keys()])
            if (key.startsWith(`${connector}:`))
                this.loading.delete(key);

        for (const key of [...this.lists.keys()])
            if (key.startsWith(`${connector}:`))
                this.lists.delete(key);

        if (all)
            for (const [key, one] of [...this.tagged])
                if (key.startsWith(`${connector}:`)) {

                    this.tagged.delete(key);
                    this.taggedChars -= one.chars;
                }

        this.saveSoon();
    }

    /** Drops the least recently used lists until they fit in `limit` characters. */
    private trim(entries: Map<string, Entry>, limit: number): void {

        let total = 0;

        for (const one of entries.values())
            total += one.chars;

        if (total <= limit)
            return;

        for (const [key, one] of [...entries].sort((a, b) => a[1].used - b[1].used)) {

            if (total <= limit)
                break;

            entries.delete(key);
            total -= one.chars;
        }
    }

    // ---------------------------------------------------------------
    // The file
    // ---------------------------------------------------------------

    /** Reads the file once, on first use. A missing or broken file is an empty cache. */
    private readFile(): void {

        if (this.read || !this.file)
            return;

        this.read = true;

        try {

            const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as { version?: number; lists?: Record<string, Entry> };

            if (saved.version !== FILE_VERSION || !saved.lists)
                return;

            const now = Date.now();

            for (const [key, one] of Object.entries(saved.lists))
                if (one && typeof one.at === "number" && typeof one.used === "number" && now - one.used < UNUSED_MS && !this.lists.has(key))
                    this.lists.set(key, { at: one.at, used: one.used, value: one.value, chars: JSON.stringify(one.value ?? null).length });

        } catch {

            // Nothing saved yet, or not readable - start empty.
        }
    }

    private saveSoon(): void {

        if (!this.file || this.saveTimer)
            return;

        this.saveTimer = setTimeout(() => {

            this.saveTimer = undefined;
            this.save();

        }, SAVE_DELAY_MS);

        this.saveTimer.unref?.();
    }

    /** Writes the lists now - the ones not too large, newest use first, up to the disk limit. */
    save(): void {

        if (!this.file)
            return;

        if (this.saveTimer) {

            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        const now = Date.now();
        const lists: Record<string, Omit<Entry, "chars">> = {};
        let total = 0;

        for (const [key, one] of [...this.lists].sort((a, b) => b[1].used - a[1].used)) {

            if (one.chars > DISK_ONE_CHARS || now - one.used >= UNUSED_MS || total + one.chars > DISK_CHARS)
                continue;

            lists[key] = { at: one.at, used: one.used, value: one.value };
            total += one.chars;
        }

        try {

            writeAtomic(this.file, JSON.stringify({ version: FILE_VERSION, lists }));

        } catch {

            // A cache that could not be written is only slower next start.
        }
    }

    // ---------------------------------------------------------------
    // Version tags
    // ---------------------------------------------------------------

    /** The last tagged answer for a read, or nothing. */
    taggedFor(key: string): Tagged | undefined {

        const found = this.tagged.get(key);

        if (found) {

            // Map order is use order: the oldest use is dropped first.
            this.tagged.delete(key);
            this.tagged.set(key, found);
        }

        return found;
    }

    keepTagged(key: string, answer: Tagged): void {

        const old = this.tagged.get(key);

        if (old) {

            this.tagged.delete(key);
            this.taggedChars -= old.chars;
        }

        const chars = answer.body.length;

        if (chars > TAGGED_ONE_CHARS)
            return;

        this.tagged.set(key, { ...answer, chars });
        this.taggedChars += chars;

        for (const [first, one] of this.tagged) {

            if (this.taggedChars <= TAGGED_CHARS)
                break;

            this.tagged.delete(first);
            this.taggedChars -= one.chars;
        }
    }
}
