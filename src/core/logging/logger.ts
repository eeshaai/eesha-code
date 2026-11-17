import {
    configure, ConsoleSink, LogEvent, LogEventLevel, Logger, LoggerConfiguration, Sink
} from "serilogger";

/**
 * The one logger, importable from anywhere.
 *
 * The engine under `src/core` runs in the server, the plugin
 * sandbox's child process, and plain Node under vitest. The logger is
 * a facade over a pipeline of {@link Sink}s. The server installs its
 * own (the daily log file, and the console when it runs in the
 * foreground); everything else keeps the default console sink.
 *
 * Built on `serilogger`, so fan-out is its `writeTo()` chain and a
 * category is an enrichment property, not text in the message.
 *
 * Four levels:
 *
 * - `info` - something started, finished, or chose a path.
 * - `warning` - something is off but the operation carried on.
 * - `error` - the operation failed.
 * - `critical` - Eesha Code itself is broken or degraded:
 *   the server cannot start, data is at risk.
 *
 * These map onto serilogger's information / warning / error / fatal.
 * Nothing outside this file needs to know `critical` is `fatal`.
 *
 * Callers never hold a sink reference, so a pipeline installed after a
 * module was imported still receives that module's messages - `engine`
 * below is reassigned, and every call reads it fresh.
 */

/** Where log lines go. One method per level - see the module comment. */
export interface LogSink {
    info(message: string): void;
    warning(message: string): void;
    error(message: string): void;
    critical(message: string): void;
}

/**
 * A message never travels as a serilogger template, only as a property
 * bound to this fixed one. Templates treat a bare `{word}` as a
 * capture, and our messages are arbitrary text (plugin errors, JSON,
 * `${{ expr }}` syntax) that can contain `{something}` by accident.
 */
const MESSAGE_TEMPLATE = "{Message}";

/** The property `MESSAGE_TEMPLATE` binds to, and what a sink reads back out. */
const MESSAGE_PROPERTY = "Message";

/** The property a category logger enriches every event with - see {@link getLogger}. */
const CATEGORY_PROPERTY = "category";

/** Reads the text a `LogSink` call produced, however it reached the event. */
export function textOf(event: LogEvent): string {

    return String((event.properties as Record<string, unknown>)[MESSAGE_PROPERTY]);
}

/** Reads the category a {@link getLogger} call attached, if any. */
export function categoryOf(event: LogEvent): string | undefined {

    const value = (event.properties as Record<string, unknown>)[CATEGORY_PROPERTY];

    return typeof value === "string" ? value : undefined;
}

/** `LogEventLevel` in our own four words, for a sink to render. */
export function levelName(level: LogEventLevel): "info" | "warning" | "error" | "critical" {

    switch (level) {

        case LogEventLevel.information: return "info";
        case LogEventLevel.warning: return "warning";
        case LogEventLevel.error: return "error";
        // `fatal`, and anything outside our four levels.
        default: return "critical";
    }
}

/** The fallback pipeline: the console, unfiltered. Right for tests and any process that never calls `setLogSinks`. */
function consolePipeline(): LoggerConfiguration {

    return configure().minLevel.verbose().writeTo(new ConsoleSink());
}

/** The active pipeline. Reassigned by `setLogSinks`, never captured by callers. */
let engine: Logger = consolePipeline().create();

/** Installs the server's sinks. Every call fans out to all of them. */
export function setLogSinks(...sinks: Sink[]): void {

    let config = configure().minLevel.verbose();

    for (const sink of sinks)
        config = config.writeTo(sink);

    engine = config.create();
}

/** Back to the console - for tests. */
export function resetLogSink(): void {

    engine = consolePipeline().create();
}

/**
 * Waits for every event already logged to reach its sink.
 *
 * serilogger dispatches through `Promise.resolve().then(...)` hops, not
 * synchronously inside `.info()`. Ordinary logging does not need this.
 * It matters when a log must survive something that could end the
 * process - a `critical` before a rethrow, shutdown - and in a test
 * asserting on what a sink received.
 */
export function flushLogs(): Promise<unknown> {

    return engine.flush();
}

/** Builds a `LogSink` facade over whatever `engine` currently is, optionally enriched with a category. */
function facade(category?: string): LogSink {

    const target = (): Logger => category ? engine.createChild({ [CATEGORY_PROPERTY]: category }) : engine;

    return {
        info: message => target().info(MESSAGE_TEMPLATE, message),
        warning: message => target().warn(MESSAGE_TEMPLATE, message),
        error: message => target().error(MESSAGE_TEMPLATE, message),
        critical: message => target().fatal(MESSAGE_TEMPLATE, message)
    };
}

/** What everything imports. No category on its events. */
export const logger: LogSink = facade();

/**
 * A logger scoped to one category - `getLogger("PluginHost").error(...)`.
 * The category is a property on every event (see `categoryOf`), for a
 * sink or panel to filter by. Reads `engine` fresh on every call, so a
 * category logger obtained before `setLogSinks` still reaches sinks
 * installed after.
 */
export function getLogger(category: string): LogSink {

    return facade(category);
}

/**
 * Text for an unknown thrown value.
 *
 * `Error.message` alone, not the stack: a stack trace off a bundled
 * file names lines that mean nothing without the source.
 */
export function messageOf(error: unknown): string {

    return error instanceof Error ? error.message : String(error);
}
