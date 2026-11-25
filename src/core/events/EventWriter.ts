import * as fs from "fs";
import * as path from "path";

import { LogLine } from "../models/run";
import { ControlKind, EVENTS_VERSION, RunEvent, parseEvents } from "./runEvents";

/**
 * Appends a run's events to its file, and reads one back.
 *
 * One writer per file: a run owns its file for the life of the run, so
 * there is no lock and no merge. The order of lines in the file is the
 * order things happened - there is no `seq` field, because a spec's
 * file outlives every panel that writes to it and an in-memory counter
 * would restart at zero on the second open.
 *
 * `appendFileSync`, like the daily log sink: no open handle, nothing to
 * flush, and a crash cannot lose a line already written. Volume is low
 * because streaming deltas never reach here. If that changes, the fix
 * is a stream in this one file.
 */
export class EventWriter {

    /** Set once the header line is on disk, so it is written exactly once per file. */
    private opened = false;

    /**
     * @param filePath where this run's events go - from `eventFile.ts`,
     * computed, never stored.
     * @param runId recorded on the header line, so a reader holding only
     * the file knows what it is about.
     * @param failed told when a write fails. A failed write must never
     * stop the run: a full disk loses the transcript, not the work.
     */
    constructor(
        private readonly filePath: string,
        private readonly runId: string,
        private readonly failed?: (error: unknown) => void
    ) { }

    /** One log line, as the run produced it. Ephemeral lines are dropped here rather than at every caller. */
    public log(line: LogLine): void {

        if (line.ephemeral)
            return;

        const { ownerId, at, stream, text, ...meta } = line;

        this.append({ ...meta, at, ownerId, stream, text });
    }

    /** One of the file's own punctuation lines - see {@link ControlKind}. */
    public control(kind: ControlKind, ownerId: string, extra: Partial<RunEvent> = {}): void {

        this.append({ kind, ownerId, at: Date.now(), ...extra });
    }

    /**
     * The provider handed back a conversation id for this owner.
     *
     * `provider` is recorded with it because an id only means something
     * to the provider that issued it - see `sessionToContinue`. `model`
     * so a later turn can tell the person changed it and reopen the
     * conversation on the new one - see `lastSession`.
     */
    public session(ownerId: string, sessionId: string, provider?: string, model?: string): void {

        this.control("session", ownerId, {
            sessionId,
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {})
        });
    }

    /**
     * Everything in the file, or nothing when there is no file yet.
     *
     * A missing or unreadable file is not an error: a run that has not
     * started, or a history a person deleted, is the ordinary case.
     */
    public read(): RunEvent[] {

        try {

            return parseEvents(fs.readFileSync(this.filePath, "utf8"));

        } catch {

            return [];
        }
    }

    /**
     * Removes every record for one owner - a person clearing that
     * conversation for good, not just starting the next run fresh (that
     * is `control("cleared", ...)`).
     *
     * The one exception to this file being append-only. Safe here and
     * nowhere else because of the same one-writer rule the class already
     * promises: this owner's panel is the only thing that ever writes
     * this file, so there is nothing else to race.
     *
     * Never throws: a failed rewrite is reported like a failed append
     * and the file is left as it was - a clear that could not happen is
     * better than a file half-written.
     */
    public clear(ownerId: string): void {

        try {

            const kept = this.read().filter(event => event.ownerId !== ownerId);

            fs.writeFileSync(this.filePath, kept.map(event => `${JSON.stringify(event)}\n`).join(""), "utf8");

        } catch (error) {

            try {

                this.failed?.(error);

            } catch {

                // A failing callback must not throw either.
            }
        }
    }

    /**
     * Writes the file again with only these records - a chat going back
     * to an earlier message, with the later part removed. The chat as it
     * was is copied to another file first, so nothing is lost.
     *
     * The second exception to this file being append-only, safe for the
     * same reason as {@link clear}: one writer per file.
     *
     * Never throws. False when the file could not be written; it is then
     * left as it was.
     */
    public rewrite(kept: readonly RunEvent[]): boolean {

        try {

            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, kept.map(event => `${JSON.stringify(event)}\n`).join(""), "utf8");

            // The header is whatever `kept` starts with.
            this.opened = true;

            return true;

        } catch (error) {

            try {

                this.failed?.(error);

            } catch {

                // A failing callback must not throw either.
            }

            return false;
        }
    }

    private append(event: RunEvent): void {

        try {

            if (!this.opened) {

                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

                // Only if the file is new. A spec's file is appended to
                // for its whole life, and must not get a header on every
                // panel open.
                if (!fs.existsSync(this.filePath))
                    this.write({ v: EVENTS_VERSION, kind: "open", runId: this.runId, at: Date.now() });

                this.opened = true;
            }

            this.write(event);

        } catch (error) {

            // Reported, then swallowed. A failed write must not stop the run.
            try {

                this.failed?.(error);

            } catch {

                // A failing callback must not throw either.
            }
        }
    }

    private write(event: RunEvent): void {

        fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    }
}
