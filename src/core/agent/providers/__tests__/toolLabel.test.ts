import { describe, expect, it } from "vitest";
import { labelVerb, toolLabel, toolTitle } from "../describe";

/** The row and the "files changed" list both tell a label from a name by its verb. */
describe("labelVerb", () => {

    it("names the verb of every label", () => {

        expect(labelVerb("Reading tasks.md")).toBe("Reading");
        expect(labelVerb("Searching web 'vitest'")).toBe("Searching");
        expect(labelVerb("Running task 'Find callers'")).toBe("Running");
    });

    it("is undefined for a bare name or a purpose sentence", () => {

        expect(labelVerb("grep")).toBeUndefined();
        expect(labelVerb("mcp__github__search_issues")).toBeUndefined();
        expect(labelVerb("github/Find the failing build")).toBeUndefined();
        expect(labelVerb("Reading")).toBeUndefined();
    });
});

/**
 * The built-in tools of both vendors are titled in plain words, from
 * the one argument that says what the call is about. Every other tool
 * keeps its own name.
 */
describe("toolLabel", () => {

    it("titles file tools by the file's name, not its path", () => {

        expect(toolLabel("view", { path: "C:\\work\\src\\app.js" })).toBe("Reading app.js");
        expect(toolLabel("Read", { file_path: "src/view/ChatView.tsx" })).toBe("Reading ChatView.tsx");
        expect(toolLabel("create", { path: "docs/new.md", content: "x" })).toBe("Writing new.md");
        expect(toolLabel("Write", { file_path: "a/b.ts" })).toBe("Writing b.ts");
        expect(toolLabel("str_replace", { path: "src/app.ts" })).toBe("Editing app.ts");
        expect(toolLabel("MultiEdit", { file_path: "src/app.ts" })).toBe("Editing app.ts");
        expect(toolLabel("NotebookEdit", { notebook_path: "nb/run.ipynb" })).toBe("Editing run.ipynb");
        expect(toolLabel("ls", { path: "C:/work/src" })).toBe("Listing src");
    });

    it("titles a search by its pattern", () => {

        expect(toolLabel("grep", { pattern: "export function", path: "src" })).toBe("Searching 'export function'");
        expect(toolLabel("Glob", { pattern: "**/*.ts" })).toBe("Searching '**/*.ts'");
        expect(toolLabel("search", { query: "where is the jail" })).toBe("Searching 'where is the jail'");
    });

    it("titles a shell call by its command", () => {

        expect(toolLabel("powershell", { command: "npm test" })).toBe("Executing 'npm test'");
        expect(toolLabel("Bash", { command: "ls -la" })).toBe("Executing 'ls -la'");
    });

    it("titles the web tools and a sub-task", () => {

        expect(toolLabel("WebFetch", { url: "https://a.io/x" })).toBe("Fetching https://a.io/x");
        expect(toolLabel("web_search", { query: "vitest config" })).toBe("Searching web 'vitest config'");
        expect(toolLabel("Task", { description: "Find callers", prompt: "long..." })).toBe("Running task 'Find callers'");
        expect(toolLabel("task", { prompt: "Find callers" })).toBe("Running task 'Find callers'");
    });

    it("leaves every other tool alone", () => {

        expect(toolLabel("ask_user", { question: "which?" })).toBeUndefined();
        expect(toolLabel("mcp__github__search_issues", { query: "x" })).toBeUndefined();
    });

    it("falls back to the name when the argument is missing", () => {

        expect(toolLabel("view", {})).toBeUndefined();
        expect(toolLabel("grep", undefined)).toBeUndefined();
        expect(toolTitle("view", {})).toBe("view");
        expect(toolTitle("Bash", {})).toBe("Bash");
    });

    it("lets a stated purpose win over the label", () => {

        expect(toolTitle("grep", { pattern: "x", __tool_use_purpose: "Find the caller" })).toBe("grep/Find the caller");
    });
});
