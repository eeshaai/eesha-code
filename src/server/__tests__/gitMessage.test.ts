// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import type { PathJail } from "../../core/agent/providers/pathJail";
import { cleanMessage, messagePrompt, readOnlyGate, readOnlyLine } from "../gitMessage";

/*
 * The hidden commit-message session: what its own permission check lets
 * run, and how its answer becomes the message.
 */

const root = path.resolve(os.tmpdir(), "repo");

describe("readOnlyLine", () => {

    it("lets read-only git commands run, piped into a plain reader or after a cd inside the repository", () => {

        for (const command of [
            "git status",
            "git diff --staged",
            "git --no-pager diff --stat",
            "git log -5 --oneline",
            "git show HEAD:a.ts",
            "git diff | head -50",
            `cd "${path.join(root, "src")}" && git diff`,
            `git -C "${root}" status`,
            "git branch --show-current",
            "git stash list"
        ])
            expect(readOnlyLine(command, root), command).toBe(true);
    });

    it("refuses every command that changes something, writes a file, or leaves the repository", () => {

        for (const command of [
            "git add -A",
            "git commit -m x",
            "git checkout -- a.ts",
            "git branch -D main",
            "git stash",
            "git diff --output=out.txt",
            "git diff > out.txt",
            "git -c core.pager=evil log",
            `git -C "${path.dirname(root)}" status`,
            `cd .. && git status`,
            "rm -rf src",
            "git status; rm a.ts",
            "git log $(rm a.ts)"
        ])
            expect(readOnlyLine(command, root), command).toBe(false);
    });
});

describe("readOnlyGate", () => {

    // The session's folder boundary: everything under `root`.
    const jail = {
        escape: (input: { paths: string[] }) => {

            const asked = path.resolve(root, input.paths[0]);
            const relative = path.relative(root, asked);

            return relative.startsWith("..") || path.isAbsolute(relative) ? { asked, resolved: asked } : undefined;
        }
    } as unknown as PathJail;

    const gate = readOnlyGate(root);

    it("lets reads inside the repository and read-only git run, and never asks", () => {

        expect(gate.decide({ tool: "Read", what: "read", paths: ["src/a.ts"] }, jail).verdict).toBe("allow");
        expect(gate.decide({ tool: "Bash", what: "command", command: "git diff" }, jail).verdict).toBe("allow");
        expect(gate.decide({ tool: "TodoWrite", what: "housekeeping" }, jail).verdict).toBe("allow");
    });

    it("refuses edits, writes, reads outside, the web and MCP - with a reason the agent can act on", () => {

        for (const call of [
            { tool: "Edit", what: "edit" as const, paths: ["a.ts"] },
            { tool: "Read", what: "read" as const, paths: ["../secret.txt"] },
            { tool: "Bash", what: "command" as const, command: "git commit -am x" },
            { tool: "WebFetch", what: "web" as const, url: "https://example.com" },
            { tool: "mcp", what: "mcp" as const, server: "s", mcpTool: "t" }
        ]) {

            const decision = gate.decide(call, jail);

            expect(decision.verdict, call.tool).toBe("deny");

            if (decision.verdict === "deny")
                expect(decision.reason).toContain("commit message");
        }
    });
});

describe("the message", () => {

    it("tells the session where to look, to find the changes itself, and to change nothing", () => {

        const prompt = messagePrompt(root);

        expect(prompt).toContain(root);
        expect(prompt).toContain("git diff --staged");
        expect(prompt).toContain("Do not change any file");
    });

    it("takes the answer as it is, without a code fence around it", () => {

        expect(cleanMessage("\n```\nFix the login\n\nBody line\n```\n")).toBe("Fix the login\n\nBody line");
        expect(cleanMessage("```text\nAdd tests\n```")).toBe("Add tests");
        expect(cleanMessage("  Plain message  ")).toBe("Plain message");
    });
});
