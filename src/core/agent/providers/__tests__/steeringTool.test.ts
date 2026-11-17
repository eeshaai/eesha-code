import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { SteeringEntry } from "../../AgentSession";
import { sessionConfig } from "../CopilotProvider";
import { answerSteering, STEERING_TOOL_NAME, steeringDescription } from "../steeringTool";

/** Two tagged files on disk, one sharing a tag with the other. */
function files(): SteeringEntry[] {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steering-tool-"));

    fs.writeFileSync(path.join(dir, "api.md"), "---\ntags: [api]\n---\nAPI rules.\n");
    fs.writeFileSync(path.join(dir, "db.md"), "---\ntags: [api, db]\n---\nDB rules.\n");

    return [
        { path: path.join(dir, "api.md"), relative: "rules/api.md", tags: ["api"] },
        { path: path.join(dir, "db.md"), relative: "rules/db.md", tags: ["API", "db"] }
    ];
}

describe("steeringDescription", () => {

    it("lists each tag once, sorted, with the files under it", () => {

        const text = steeringDescription(files());

        expect(text).toContain("- api (rules/api.md, rules/db.md)\n- db (rules/db.md)");
        expect(text).toContain("together with your first file reads");
    });
});

describe("answerSteering", () => {

    it("returns the text of every file with a tag asked for, whatever its case", () => {

        const answer = answerSteering(files(), { tags: ["Db"] });

        expect(answer).toContain("=== rules/db.md (tags: API, db) ===");
        expect(answer).toContain("DB rules.");
        expect(answer).not.toContain("API rules.");
    });

    it("returns a file once when two of its tags are asked for", () => {

        const answer = answerSteering(files(), { tags: ["api", "db"] });

        expect(answer.match(/DB rules\./g)).toHaveLength(1);
        expect(answer).toContain("API rules.");
    });

    it("names the unknown tags beside the ones it found", () => {

        const answer = answerSteering(files(), { tags: ["db", "ui"] });

        expect(answer).toMatch(/^No steering files for: ui\./);
        expect(answer).toContain("DB rules.");
    });

    it("returns the tag list when no tags are given", () => {

        expect(answerSteering(files(), {})).toBe("Tags:\n- api (rules/api.md, rules/db.md)\n- db (rules/db.md)");
    });

    it("returns the tag list when none of the tags is known", () => {

        expect(answerSteering(files(), { tags: ["ui"] })).toMatch(/^No steering files for: ui\.\n\nTags:\n- api/);
    });

    it("tells the log what was asked for and what went back", () => {

        const lines: string[] = [];

        answerSteering(files(), { tags: ["db"] }, text => lines.push(text));
        answerSteering(files(), undefined, text => lines.push(text));

        expect(lines).toEqual([
            "Steering: asked for db; returned rules/db.md.",
            "Steering: asked for no tags; returned the tag list."
        ]);
    });

    it("says a file could not be read rather than failing", () => {

        const answer = answerSteering(
            [{ path: path.join(os.tmpdir(), "steering-gone-" + Date.now() + ".md"), relative: "gone.md", tags: ["x"] }],
            { tags: ["x"] });

        expect(answer).toContain("(could not be read:");
    });
});

/* The tool reaches Copilot only when the project has tagged files. */
describe("as Copilot is given it", () => {

    interface CopilotTool { name: string; description: string; skipPermission?: boolean; defer?: string; handler?: (args: unknown) => Promise<unknown> }

    const toolsOf = (steering: SteeringEntry[] | undefined) =>
        (sessionConfig({ workingDirectory: "/work", env: {}, steering }, undefined, undefined, undefined) as unknown as { tools: CopilotTool[] }).tools;

    it("is registered with the tags in its description, never deferred and with nothing to approve", async () => {

        const tool = toolsOf(files()).find(one => one.name === STEERING_TOOL_NAME)!;

        expect(tool.description).toContain("- db (rules/db.md)");
        expect(tool.skipPermission).toBe(true);
        expect(tool.defer).toBe("never");
        expect(await tool.handler!({ tags: ["db"] })).toContain("DB rules.");
    });

    it("is absent when there are no tagged files", () => {

        expect(toolsOf(undefined).some(one => one.name === STEERING_TOOL_NAME)).toBe(false);
        expect(toolsOf([]).some(one => one.name === STEERING_TOOL_NAME)).toBe(false);
    });
});
