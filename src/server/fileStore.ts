import type { ChatStore } from "../chat/chatStore";
import { logger } from "../core/logging/logger";
import { readJson, writeAtomic } from "./paths";

/**
 * The saved values the chat keeps - each chat's runtime pick, names
 * given by hand, the permission level - in one file,
 * ~/.eesha/state.json.
 *
 * Read once at start and kept in memory; every change writes the whole
 * file again. Writes never overlap: each waits for the one before.
 */
export class FileStore implements ChatStore {

    private readonly values: Record<string, unknown>;

    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly file: string) {

        const saved = readJson(file);

        this.values = saved && typeof saved === "object" && !Array.isArray(saved)
            ? { ...saved as Record<string, unknown> }
            : {};
    }

    get<T>(key: string): T | undefined {

        return this.values[key] as T | undefined;
    }

    /** `undefined` removes the key. */
    update(key: string, value: unknown): Promise<void> {

        if (value === undefined)
            delete this.values[key];
        else
            this.values[key] = value;

        const text = JSON.stringify(this.values, undefined, 2) + "\n";

        this.writing = this.writing.then(() => {

            try {

                writeAtomic(this.file, text);

            } catch (error) {

                logger.warning(`Eesha Code: could not save ${this.file}. ${(error as Error).message}`);
            }
        });

        return this.writing;
    }
}
