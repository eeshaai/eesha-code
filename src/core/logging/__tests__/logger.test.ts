import { afterEach, describe, expect, it, vi } from "vitest";
import { Sink } from "serilogger";
import { getLogger, levelName, logger, messageOf, resetLogSink, setLogSinks, textOf } from "../logger";

/**
 * A Sink that records "<level> <message>" per event.
 *
 * serilogger dispatches asynchronously, so a call and its effect on a
 * sink are never in the same tick. Every assertion below goes through
 * `vi.waitFor`.
 */
function recordingSink(prefix = ""): { sink: Sink; lines: string[] } {

    const lines: string[] = [];

    return {
        lines,
        sink: {
            emit: events => events.forEach(event => lines.push(`${prefix}${levelName(event.level)} ${textOf(event)}`)),
            flush: () => Promise.resolve()
        }
    };
}

describe("logger", () => {

    afterEach(() => resetLogSink());

    it("routes every level to the installed sink", async () => {

        const { sink, lines } = recordingSink();

        setLogSinks(sink);

        logger.info("a");
        logger.warning("b");
        logger.error("c");
        logger.critical("d");

        await vi.waitFor(() => expect(lines).toEqual(["info a", "warning b", "error c", "critical d"]));
    });

    // Modules import `logger` before the server installs the channel,
    // and their messages still have to land in it.
    it("a sink installed later receives calls from an earlier reference", async () => {

        const log = logger;

        const { sink, lines } = recordingSink();

        setLogSinks(sink);

        log.info("late binding");

        await vi.waitFor(() => expect(lines).toEqual(["info late binding"]));
    });

    it("fans a call out to every installed sink, in order", async () => {

        const a = recordingSink("a ");
        const b = recordingSink("b ");

        setLogSinks(a.sink, b.sink);

        logger.info("x");
        logger.critical("y");

        await vi.waitFor(() => {

            expect(a.lines).toEqual(["a info x", "a critical y"]);
            expect(b.lines).toEqual(["b info x", "b critical y"]);
        });
    });

    it("falls back to the console by default, one level tag per line", async () => {

        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {

            // serilogger's `ConsoleSink` reads `console.*` once, at
            // construction, so the sink must be built after the spies.
            resetLogSink();

            logger.info("i");
            logger.warning("w");
            logger.error("e");
            logger.critical("c");

            await vi.waitFor(() => {

                expect(info).toHaveBeenCalledWith("[Information] i");
                expect(warn).toHaveBeenCalledWith("[Warning] w");
                expect(error).toHaveBeenCalledWith("[Error] e");
                expect(error).toHaveBeenCalledWith("[Fatal] c");
            });

        } finally {

            info.mockRestore();
            warn.mockRestore();
            error.mockRestore();
        }
    });

    it("resetLogSink puts the console back", async () => {

        setLogSinks(recordingSink().sink);

        const info = vi.spyOn(console, "info").mockImplementation(() => {});

        try {

            resetLogSink();

            logger.info("back");

            await vi.waitFor(() => expect(info).toHaveBeenCalledWith("[Information] back"));

        } finally {

            info.mockRestore();
        }
    });
});

describe("getLogger", () => {

    afterEach(() => resetLogSink());

    it("attaches a category to every event, without changing the message", async () => {

        const { sink, lines } = recordingSink();
        const seenCategories: (string | undefined)[] = [];

        setLogSinks({
            emit: events => {

                for (const event of events)
                    seenCategories.push((event.properties as Record<string, unknown>).category as string | undefined);

                sink.emit(events);
            },
            flush: () => Promise.resolve()
        });

        getLogger("PluginHost").error("boom");

        await vi.waitFor(() => {

            expect(lines).toEqual(["error boom"]);
            expect(seenCategories).toEqual(["PluginHost"]);
        });
    });

    it("leaves the uncategorised logger's events with no category", async () => {

        const seen: (string | undefined)[] = [];

        setLogSinks({
            emit: events => {

                for (const event of events)
                    seen.push((event.properties as Record<string, unknown>).category as string | undefined);
            },
            flush: () => Promise.resolve()
        });

        logger.info("plain");

        await vi.waitFor(() => expect(seen).toEqual([undefined]));
    });

    it("two categories obtained before a sink is installed both reach it - same late binding as the root logger", async () => {

        const claude = getLogger("ClaudeProvider");
        const runner = getLogger("TaskRunner");

        const { sink, lines } = recordingSink();

        setLogSinks(sink);

        claude.warning("retrying");
        runner.error("failed");

        await vi.waitFor(() => expect(lines).toEqual(["warning retrying", "error failed"]));
    });
});

describe("messageOf", () => {

    it("takes the message of an Error, not the stack", () => {

        expect(messageOf(new Error("boom"))).toBe("boom");
    });

    it("stringifies anything else", () => {

        expect(messageOf("plain")).toBe("plain");
        expect(messageOf(42)).toBe("42");
        expect(messageOf(undefined)).toBe("undefined");
    });
});
