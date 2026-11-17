import * as fs from "fs";
import * as path from "path";

import { profileDirectory } from "../../loader/profilePaths";

/*
 * The running usage totals of each Claude conversation, kept on disk.
 *
 * The Claude runtime reports a turn's cost and tokens as running totals
 * for the whole conversation, and a turn's own share is the difference
 * from the totals last seen. Reopening a conversation - a model change,
 * a page reload - starts a new runtime process, and that process
 * restores the conversation's totals from its transcript. Counting from
 * zero would charge every earlier turn a second time.
 *
 * So the totals last seen are kept here, by conversation id, and a
 * reopened conversation starts from them.
 */

export interface ClaudeTotals {

    costUsd: number;

    /** `cached`: cache reads. */
    byModel: Record<string, { cost: number; input: number; output: number; cached: number }>;
}

/** Where a conversation's totals are read from and written to. */
export interface ClaudeTotalsStore {

    read(sessionId: string): ClaudeTotals | undefined;

    write(sessionId: string, totals: ClaudeTotals): void;
}

/** How many conversations are remembered. The oldest go first; one that old is not reopened. */
const LIMIT = 500;

type Stored = Record<string, ClaudeTotals & { at: number }>;

/**
 * The store in the profile folder, shared by every window. Never throws:
 * a store that cannot be read is an empty one, and a failed write loses
 * only the correction for a later reopen.
 */
export function fileTotalsStore(file = path.join(profileDirectory(), "state", "claude-usage.json")): ClaudeTotalsStore {

    const load = (): Stored => {

        try {

            const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;

            return parsed && typeof parsed === "object" ? parsed as Stored : {};

        } catch {

            return {};
        }
    };

    return {
        read(sessionId) {

            const found = load()[sessionId];

            return found && typeof found.costUsd === "number" && found.byModel && typeof found.byModel === "object"
                ? { costUsd: found.costUsd, byModel: found.byModel }
                : undefined;
        },

        write(sessionId, totals) {

            try {

                const all = load();

                all[sessionId] = { ...totals, at: Date.now() };

                const kept = Object.entries(all)
                    .sort(([, left], [, right]) => (right.at ?? 0) - (left.at ?? 0))
                    .slice(0, LIMIT);

                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(Object.fromEntries(kept)), "utf8");

            } catch {

                // See above: the turn's bill is already right; only a
                // later reopen loses its starting point.
            }
        }
    };
}
