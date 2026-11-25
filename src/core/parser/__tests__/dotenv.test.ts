import { describe, expect, it } from "vitest";
import { parseDotEnv } from "../dotenv";

const values = (text: string) => parseDotEnv(text).values;

describe("parseDotEnv", () => {

    it("reads plain NAME=value lines", () => {

        expect(values("A=1\nB=two")).toEqual({ A: "1", B: "two" });
    });

    it("ignores blank lines and comments", () => {

        expect(values("# a comment\n\n  \nA=1\n   # indented comment\n")).toEqual({ A: "1" });
    });

    it("accepts the `export` prefix shell-sourced files carry", () => {

        expect(values("export TOKEN=abc")).toEqual({ TOKEN: "abc" });
    });

    it("trims whitespace around the name and the value", () => {

        expect(values("  A  =  spaced  ")).toEqual({ A: "spaced" });
    });

    it("keeps everything after the first = , so a value may contain one", () => {

        expect(values("CONNECTION=Server=db;Port=5432")).toEqual({ CONNECTION: "Server=db;Port=5432" });
    });

    it("strips double quotes and honours escapes inside them", () => {

        expect(values('A="line one\\nline two"')).toEqual({ A: "line one\nline two" });
        expect(values('A="say \\"hi\\""')).toEqual({ A: 'say "hi"' });
    });

    it("strips single quotes and honours nothing inside them", () => {

        expect(values("A='line one\\nline two'")).toEqual({ A: "line one\\nline two" });
    });

    it("keeps a quoted value's inner whitespace", () => {

        expect(values('A="  padded  "')).toEqual({ A: "  padded  " });
    });

    // dotenv implementations disagree here. Truncating at a `#` breaks a
    // URL fragment and any password containing one, which is far more
    // common than trailing comments on a value line.
    it("does not treat a # inside an unquoted value as a comment", () => {

        expect(values("URL=https://example.com/#anchor")).toEqual({ URL: "https://example.com/#anchor" });
    });

    it("takes values literally - an engine is characters, not an expression", () => {

        expect(values("SECRET=${{ not.a.template }}")).toEqual({ SECRET: "${{ not.a.template }}" });
    });

    it("lets a later line win over an earlier one of the same name", () => {

        expect(values("A=first\nA=second")).toEqual({ A: "second" });
    });

    describe("problems", () => {

        it("reports a line with no =, naming the line number, and keeps the rest", () => {

            const result = parseDotEnv("A=1\nthis is not a pair\nB=2");

            expect(result.values).toEqual({ A: "1", B: "2" });
            expect(result.problems).toEqual(["line 2: expected NAME=value, got 'this is not a pair'"]);
        });

        it("rejects a name that could not be an environment variable", () => {

            const result = parseDotEnv("not a name=1\nB=2");

            expect(result.values).toEqual({ B: "2" });
            expect(result.problems[0]).toMatch(/not a name/);
        });

        it("is silent on a clean file", () => {

            expect(parseDotEnv("A=1").problems).toEqual([]);
        });
    });
});
