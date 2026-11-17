import type { ConnectorId } from "./config";

/*
 * The shape every connector tool has: what the AI sees (name,
 * description, input), which source and access it needs, and how it
 * runs. A write tool also says in one line what it is about to do, for
 * the question the person answers first.
 */

export interface ToolDef<Context = unknown> {

    name: string;

    description: string;

    /** JSON Schema of the input, as MCP lists it. */
    inputSchema: Record<string, unknown>;

    connector: ConnectorId;

    source: string;

    write: boolean;

    /** For a write: what it will do, said to the person before it runs. */
    describe?(args: Record<string, unknown>): string;

    run(args: Record<string, unknown>, context: Context): Promise<unknown>;
}

/** A tool call that cannot run as asked: said back to the AI as it is. */
export class ToolError extends Error { }

/** An input schema with these properties, `required` ones named. */
export function schema(properties: Record<string, Record<string, unknown>>, required: string[] = []): Record<string, unknown> {

    return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

export function text(args: Record<string, unknown>, key: string): string | undefined;
export function text(args: Record<string, unknown>, key: string, required: true): string;
export function text(args: Record<string, unknown>, key: string, required = false): string | undefined {

    const value = args[key];

    if (value === undefined || value === null || value === "") {

        if (required)
            throw new ToolError(`Give ${key}.`);

        return undefined;
    }

    if (typeof value !== "string")
        throw new ToolError(`${key} must be text.`);

    return value;
}

export function whole(args: Record<string, unknown>, key: string): number | undefined;
export function whole(args: Record<string, unknown>, key: string, required: true): number;
export function whole(args: Record<string, unknown>, key: string, required = false): number | undefined {

    const value = typeof args[key] === "string" && /^\d+$/.test(args[key] as string) ? Number(args[key]) : args[key];

    if (value === undefined || value === null) {

        if (required)
            throw new ToolError(`Give ${key}.`);

        return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        throw new ToolError(`${key} must be a whole number.`);

    return value;
}

/** A count asked for, kept between 1 and `most`. */
export function count(args: Record<string, unknown>, key: string, fallback: number, most: number): number {

    return Math.min(Math.max(whole(args, key) ?? fallback, 1), most);
}

/** HTML from ADO (descriptions, comments) as plain lines. */
export function plainText(html: string | undefined): string | undefined {

    if (!html)
        return undefined;

    const text = html
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return text || undefined;
}

/** Plain text as HTML for ADO: escaped, line breaks kept. */
export function htmlOf(text: string): string {

    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r?\n/g, "<br>");
}

/** Long text cut to `most` characters, saying so. */
export function capped(text: string, most: number): string {

    return text.length > most ? `${text.slice(0, most)}\n... (cut at ${most} characters)` : text;
}

/**
 * What a `>` path points at: one line for the AI, and the
 * item's web address on its own when it has one, so nothing has to dig
 * it back out of the line. A path that does not resolve gives `problem`.
 */
export interface ItemReference {

    line?: string;

    link?: string;

    problem?: string;

    /** Set only for an ADO work item or a GitHub issue: what a workspace can be linked to. */
    subject?: ItemSubject;
}

/** A work item or an issue, as a workspace's link is made from it. */
export type ItemSubject =
    | { kind: "workitem"; number: number; title: string; /** The project's `>` level name. */ project: string }
    | { kind: "issue"; number: number; title: string; /** owner/repo. */ repo: string };
