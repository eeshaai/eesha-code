import * as fs from "fs";
import * as path from "path";

import { LogEvent, Sink } from "serilogger";

import { levelName, messageOf, textOf } from "./logger";

/**
 * A serilogger {@link Sink} that appends to a daily file.
 *
 * A file under the profile's `~/.eesha/logs/` survives the session and
 * can be pasted into a bug report. The server always installs it, and
 * the console sink beside it when it runs in the foreground (see
 * `setLogSinks` in {@link ./logger}).
 *
 * One file per local day, named `2026-08-26.log`. Names are zero-padded
 * so their string order is their date order - retention relies on that.
 *
 * `appendFileSync`, not a stream: logging is not on a hot path, and a
 * synchronous append means no open handle to roll over at midnight,
 * nothing to flush, nothing to dispose. If logging ever gets chatty
 * enough for this to hurt, the fix is a stream in this one file.
 */

/** Daily files older than this many days are deleted at startup. */
const RETENTION_DAYS = 14;

/** What counts as one of our daily files. Nothing else is ever deleted. */
const DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.log$/;

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `2026-08-26.log` for the given moment, in local time. */
function fileName(now: Date): string {

    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
}

/** `14:03:05.123` in local time. The date is already the filename. */
function stamp(now: Date): string {

    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Deletes daily files older than {@link RETENTION_DAYS}.
 *
 * By filename, not mtime: the name is the date, and mtime is whatever
 * the last copy or sync tool left it as.
 */
function prune(directory: string): void {

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

    const oldest = fileName(cutoff);

    for (const entry of fs.readdirSync(directory))
        if (DAILY_FILE.test(entry) && entry < oldest)
            fs.unlinkSync(path.join(directory, entry));
}

/**
 * The sink. Creates the directory and prunes old files up front. Any
 * filesystem failure, then or on a later append, disables the sink for
 * the rest of the session with one console line saying why: logging
 * must never take Eesha Code down.
 */
export function createFileSink(directory: string): Sink {

    let broken = false;

    const disable = (error: unknown): void => {

        broken = true;
        console.error(`File logging to '${directory}' disabled: ${messageOf(error)}`);
    };

    try {

        fs.mkdirSync(directory, { recursive: true });
        prune(directory);

    } catch (error) {

        disable(error);
    }

    const write = (event: LogEvent): void => {

        if (broken)
            return;

        const now = new Date(event.timestamp);

        try {

            fs.appendFileSync(
                path.join(directory, fileName(now)),
                `${stamp(now)} [${levelName(event.level)}] ${textOf(event)}\n`);

        } catch (error) {

            disable(error);
        }
    };

    return {

        emit: events => events.forEach(write),

        // Every write is synchronous, so there is nothing to flush.
        flush: () => Promise.resolve()
    };
}
