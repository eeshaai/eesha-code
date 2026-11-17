import * as fs from "fs";
import { z } from "zod";

import { SteeringEntry } from "../AgentSession";

/**
 * One tool, so an agent loads a project's topic rules only when its
 * work needs them.
 *
 * Steering files with `tags:` in their header are not attached to the
 * chat. The tool's description lists every tag and the files under it,
 * built fresh for each chat from what is on disk. The agent calls it
 * with the tags that fit its work and gets those files' text back.
 * Until it asks, the files cost one line each in the description.
 *
 * Registered only on a session that has tagged files (see
 * `AgentSessionConfig.steering`). Same route as the clocks: in-process,
 * never deferred, nothing to approve.
 */

export const STEERING_TOOL_NAME = "steering";

/** The description, with this chat's tags and the files under each. */
export function steeringDescription(files: readonly SteeringEntry[]): string {

    return "The project's own rules, by topic. Tags:\n"
        + tagList(files)
        + "\n\nCall this with the tags that fit your work, together with your first file reads, "
        + "before you change anything. It returns those rules as text. Call it with no tags to see the list again.";
}

const TAGS_TEXT = "The tags to load, as listed in this tool's description. Leave out to get the list.";

/** The tool's input as a zod shape, for Claude's `tool()`. */
export const steeringToolShape = {

    tags: z.array(z.string()).optional().describe(TAGS_TEXT)
};

/** The same input as JSON Schema, for the runtimes that take one. */
export const steeringToolJsonSchema: Record<string, unknown> = {
    type: "object",
    properties: {
        tags: { type: "array", items: { type: "string" }, description: TAGS_TEXT }
    },
    additionalProperties: false
};

export interface SteeringToolInput {

    tags?: string[];
}

/**
 * The answer to one call: the text of every file with any of the tags
 * asked for, or the tag list when none of them is known. Tags match
 * without regard to case. A sentence for the model, never a throw.
 *
 * @param log Told which tags were asked for and which files went back,
 *            so the run log shows what the agent loaded.
 */
export function answerSteering(
    files: readonly SteeringEntry[],
    input: SteeringToolInput | undefined,
    log?: (text: string) => void
): string {

    const asked = [...new Set((Array.isArray(input?.tags) ? input.tags : [])
        .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
        .map(tag => tag.trim().toLowerCase()))];

    const known = new Set(files.flatMap(file => file.tags.map(tag => tag.toLowerCase())));

    const unknown = asked.filter(tag => !known.has(tag));

    const matched = files.filter(file => file.tags.some(tag => asked.includes(tag.toLowerCase())));

    log?.(`Steering: asked for ${asked.length ? asked.join(", ") : "no tags"}; `
        + `returned ${matched.length ? matched.map(file => file.relative).join(", ") : "the tag list"}.`);

    if (!matched.length)
        return (asked.length ? `No steering files for: ${unknown.join(", ")}.\n\n` : "")
            + "Tags:\n"
            + tagList(files);

    const sections = matched.map(file => `=== ${file.relative} (tags: ${file.tags.join(", ")}) ===\n\n${read(file.path)}`);

    return (unknown.length ? `No steering files for: ${unknown.join(", ")}.\n\n` : "") + sections.join("\n\n");
}

/** One line per tag, naming the files under it. */
function tagList(files: readonly SteeringEntry[]): string {

    return byTag(files).map(([tag, under]) => `- ${tag} (${under.map(file => file.relative).join(", ")})`).join("\n");
}

/** Tags in order, each with the files carrying it. */
function byTag(files: readonly SteeringEntry[]): [string, SteeringEntry[]][] {

    const tags = new Map<string, SteeringEntry[]>();

    for (const file of files)
        for (const tag of file.tags) {

            const key = tag.toLowerCase();

            tags.set(key, [...(tags.get(key) ?? []), file]);
        }

    return [...tags.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** A file's text, read now, or a line saying why it could not be. */
function read(file: string): string {

    try {

        return fs.readFileSync(file, "utf8").trim();

    } catch (error) {

        return `(could not be read: ${(error as Error).message})`;
    }
}
