import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, Logger, Sink } from "serilogger";

import { createFileSink } from "../fileSink";

let dir: string;

/** A pipeline feeding only the sink under test, shaped as production drives it. */
function loggerFor(sink: Sink): Logger {

    return configure().minLevel.verbose().writeTo(sink).create();
}

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-logs-"));
});

afterEach(() => {

    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** The one daily file the sink should be writing today, read back. */
function todaysLines(): string[] {

    const entries = fs.readdirSync(dir).filter(entry => entry.endsWith(".log"));

    expect(entries).toHaveLength(1);

    return fs.readFileSync(path.join(dir, entries[0]), "utf8").trimEnd().split("\n");
}

describe("createFileSink", () => {

    it("appends every level to a dated file, stamped and labelled", async () => {

        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 26, 14, 3, 5, 123));

        const log = loggerFor(createFileSink(dir));

        log.info("{Message}", "started");
        log.warn("{Message}", "odd");
        log.error("{Message}", "failed");
        log.fatal("{Message}", "broken");

        await log.flush();

        expect(fs.existsSync(path.join(dir, "2026-08-26.log"))).toBe(true);

        expect(todaysLines()).toEqual([
            "14:03:05.123 [info] started",
            "14:03:05.123 [warning] odd",
            "14:03:05.123 [error] failed",
            "14:03:05.123 [critical] broken"
        ]);
    });

    it("creates the directory when it does not exist yet", async () => {

        const nested = path.join(dir, "a", "b");

        const log = loggerFor(createFileSink(nested));

        log.info("{Message}", "first line ever");

        await log.flush();

        expect(fs.readdirSync(nested)).toHaveLength(1);
    });

    it("rolls to a new file when the local day changes", async () => {

        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 26, 23, 59, 0));

        const log = loggerFor(createFileSink(dir));
        log.info("{Message}", "before midnight");

        await log.flush();

        vi.setSystemTime(new Date(2026, 7, 27, 0, 1, 0));
        log.info("{Message}", "after midnight");

        await log.flush();

        expect(fs.existsSync(path.join(dir, "2026-08-26.log"))).toBe(true);
        expect(fs.existsSync(path.join(dir, "2026-08-27.log"))).toBe(true);
    });

    it("deletes daily files older than the retention window, nothing else", () => {

        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 26));

        fs.writeFileSync(path.join(dir, "2026-08-01.log"), "old\n");
        fs.writeFileSync(path.join(dir, "2026-08-20.log"), "recent\n");
        fs.writeFileSync(path.join(dir, "keep-me.txt"), "not ours\n");

        createFileSink(dir);

        expect(fs.existsSync(path.join(dir, "2026-08-01.log"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "2026-08-20.log"))).toBe(true);
        expect(fs.existsSync(path.join(dir, "keep-me.txt"))).toBe(true);
    });

    // A sink whose directory cannot exist says so once on the console
    // and swallows everything after. It never throws into the caller.
    it("disables itself on filesystem failure instead of throwing", async () => {

        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {

            const file = path.join(dir, "not-a-directory");
            fs.writeFileSync(file, "");

            const log = loggerFor(createFileSink(path.join(file, "logs")));

            expect(() => log.info("{Message}", "goes nowhere")).not.toThrow();

            await log.flush();

            expect(error).toHaveBeenCalledTimes(1);

        } finally {

            error.mockRestore();
        }
    });
});
