// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { builtInTasks, evalTasks, evalTasksDir, findingInFolder, parseFindings, parseTaskFile, taskClosing } from "../evalTasks";
import { findingRows } from "../../web/evalNumbers";

afterEach(() => fs.rmSync(evalTasksDir(), { recursive: true, force: true }));

function write(file: string, content: string): void {

    fs.mkdirSync(evalTasksDir(), { recursive: true });
    fs.writeFileSync(path.join(evalTasksDir(), file), content);
}

describe("the built-in tasks", () => {

    it("has one that only finds and one that fixes for each topic, security and cache among them", () => {

        const tasks = builtInTasks();
        const names = tasks.map(task => task.name);

        expect(names).toEqual(expect.arrayContaining(["find-security", "fix-security", "find-cache", "fix-cache"]));
        expect(new Set(names).size).toBe(names.length);

        for (const task of tasks) {

            expect(task.own).toBe(false);
            expect(task.kind).toBe(task.name.startsWith("find-") ? "find" : "fix");
        }

        // A model must be free to say it found nothing.
        expect(tasks.find(task => task.name === "find-security")!.text).toContain("found nothing");
    });
});

describe("a person's own task file", () => {

    it("gives the title and the kind in its first lines, and the message under them", () => {

        expect(parseTaskFile("slow-db", "---\ntitle: Find slow database calls\nkind: find\n---\nLook for database calls inside loops.\n"))
            .toEqual({ name: "slow-db", title: "Find slow database calls", kind: "find", text: "Look for database calls inside loops.", own: true });
    });

    it("is a plain message, named after the file, with no first lines", () => {

        expect(parseTaskFile("refactor", "Move the login checks into one service.\r\n"))
            .toEqual({ name: "refactor", title: "refactor", text: "Move the login checks into one service.", own: true });
    });

    it("is refused with a reason for a kind that is not one, and with no message", () => {

        expect(parseTaskFile("x", "---\nkind: review\n---\ntext")).toEqual({ problem: expect.stringContaining("Write find or fix") });
        expect(parseTaskFile("x", "---\nkind: find\n---\n  \n")).toEqual({ problem: expect.stringContaining("no message") });
    });

    it("is listed before the built-in tasks, replaces one of the same name, and a bad file is named", () => {

        write("slow-db.md", "---\nkind: fix\n---\nFix database calls inside loops.");
        write("find-cache.md", "My own cache task.");
        write("bad name.md", "text");
        write("notes.txt", "not a task");

        const { tasks, problems } = evalTasks();

        expect(tasks.slice(0, 2).map(task => [task.name, task.own])).toEqual([["find-cache", true], ["slow-db", true]]);
        expect(tasks.filter(task => task.name === "find-cache")).toHaveLength(1);
        expect(tasks.some(task => task.name === "fix-cache" && !task.own)).toBe(true);
        expect(problems).toEqual([expect.stringContaining("bad name.md")]);
    });

    it("needs no folder: with none there are only the built-in tasks", () => {

        expect(evalTasks()).toEqual({ tasks: builtInTasks(), problems: [] });
    });
});

describe("what is sent for a task", () => {

    it("gives a find and a fix task closing lines, and a plain one none", () => {

        const find = taskClosing("find");

        expect(find.startsWith("Do not change, create or delete any file")).toBe(true);
        expect(find).toContain("```findings");
        expect(find).toContain("file | line | severity | problem");

        const fix = taskClosing("fix");

        expect(fix).toContain("Fix each problem you find");
        expect(fix).not.toContain("Do not change, create or delete any file");
        expect(fix).toContain("```findings");

        expect(taskClosing(undefined)).toBe("");
    });
});

describe("parseFindings", () => {

    it("reads every line of the findings block", () => {

        const answer = [
            "I found two problems.",
            "",
            "```findings",
            "file | line | severity | problem",
            "src/db/users.ts | 42 | high | The query is built by joining strings.",
            "src\\cache\\store.ts | 0 | Medium | The cache is never cleared | not even on logout.",
            "```"
        ].join("\n");

        expect(parseFindings(answer)).toEqual([
            { file: "src/db/users.ts", line: 42, severity: "high", problem: "The query is built by joining strings." },
            { file: "src/cache/store.ts", line: 0, severity: "medium", problem: "The cache is never cleared | not even on logout." }
        ]);
    });

    it("tells an answer with no block from one that found nothing", () => {

        expect(parseFindings("I looked and found nothing.")).toBeUndefined();
        expect(parseFindings("Nothing.\n\n```findings\nnone\n```")).toEqual([]);
    });

    it("keeps the good lines of a block that was cut off, and drops a line said twice", () => {

        const answer = "```findings\na.ts | 1 | low | First.\na.ts | 1 | low | First.\nb.ts | x | urgent | Second.\nc.ts | 3";

        expect(parseFindings(answer)).toEqual([
            { file: "a.ts", line: 1, severity: "low", problem: "First." },
            { file: "b.ts", line: 0, problem: "Second." }
        ]);
    });

    it("writes a file in the variant's copy as a path from its folder", () => {

        const finding = { file: "C:/Users/x/.eesha/evals/one/copies/one-1/src/a.ts", line: 3, problem: "p" };

        expect(findingInFolder(finding, "C:\\Users\\x\\.eesha\\evals\\one\\copies\\one-1").file).toBe("src/a.ts");
        expect(findingInFolder({ ...finding, file: "src/a.ts" }, "C:\\copy").file).toBe("src/a.ts");
    });
});

describe("the findings side by side", () => {

    it("puts the same file and line on one row, the rows more variants listed first", () => {

        const rows = findingRows([
            [{ file: "src/a.ts", line: 10, problem: "one's words" }, { file: "src/only-one.ts", line: 1, problem: "p" }],
            [{ file: "SRC/a.ts", line: 10, severity: "high", problem: "two's words" }, { file: "src/a.ts", line: 11, problem: "a line apart" }],
            undefined
        ]);

        expect(rows.map(row => [row.file, row.line, row.found])).toEqual([
            ["src/a.ts", 10, 2],
            ["src/a.ts", 11, 1],
            ["src/only-one.ts", 1, 1]
        ]);

        expect(rows[0]!.cells.map(cell => cell?.problem)).toEqual(["one's words", "two's words", undefined]);
    });
});
