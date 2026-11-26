// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { checkRuntimes, doctorLine, doctorReport, foundOnly, RuntimeCheck } from "../doctor";

/*
 * `eesha doctor` - which runtimes' programs are on this machine.
 * The lookup runs against a made-up PATH, never the real one.
 */

function fakePath(...programs: string[]): string {

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-doctor-"));

    // A Windows shell finds `name.cmd`; any other finds `name`.
    for (const program of programs)
        for (const name of [program, `${program}.cmd`])
            fs.writeFileSync(path.join(folder, name), "");

    return folder;
}

const agent = (command: string) => ({ agent: { command }, source: "built-in" });

describe("checkRuntimes", () => {

    it("finds each runtime's program on PATH, at a full path, or by its override, and says how to get the others", () => {

        const folder = fakePath("gemini");
        const own = path.join(folder, "my-agent.exe");

        fs.writeFileSync(own, "");

        const checks = checkRuntimes(
            ["ghcp", "gemini-cli", "codex-cli", "mine", "nope"],
            { "gemini-cli": agent("gemini"), "codex-cli": agent("codex-acp"), mine: agent(own) },
            { PATH: folder, PATHEXT: ".CMD", COPILOT_CLI_PATH: "C:\\tools\\copilot.exe" });

        expect(checks[0]).toEqual({ id: "ghcp", program: "copilot", found: "C:\\tools\\copilot.exe", install: expect.stringContaining("@github/copilot") });
        expect(checks[1].found?.toLowerCase()).toMatch(/gemini(\.cmd)?$/);
        expect(checks[2]).toEqual({ id: "codex-cli", program: "codex-acp", install: "the Codex ACP adapter" });
        expect(checks[3]).toMatchObject({ id: "mine", found: own, install: "check ai.acpAgents.mine.command in settings.json" });
        expect(checks[4]).toMatchObject({ id: "nope", program: "?" });
        expect(checks[4].found).toBeUndefined();
    });
});

describe("foundOnly", () => {

    it("keeps the runtimes whose program is found, in their order", () => {

        const folder = fakePath("gemini");

        expect(foundOnly(
            ["ghcp", "gemini-cli", "codex-cli"],
            { "gemini-cli": agent("gemini"), "codex-cli": agent("codex-acp") },
            { PATH: folder, PATHEXT: ".CMD", COPILOT_CLI_PATH: "C:\\tools\\copilot.exe" })).toEqual(["ghcp", "gemini-cli"]);
    });

    it("keeps them all when none is found, so the picker is never empty", () => {

        expect(foundOnly(["gemini-cli", "codex-cli"], { "gemini-cli": agent("gemini"), "codex-cli": agent("codex-acp") }, { PATH: fakePath() }))
            .toEqual(["gemini-cli", "codex-cli"]);
    });
});

describe("what it prints", () => {

    const checks: RuntimeCheck[] = [
        { id: "claude", program: "claude", found: "C:\\bin\\claude.exe", install: "npm install -g @anthropic-ai/claude-code" },
        { id: "gemini-cli", program: "gemini", install: "Google's Gemini CLI" }
    ];

    it("lists each runtime, and says the picker offers the ones found when settings.json lists none", () => {

        const text = doctorReport({ checks, listed: false });

        expect(text).toContain("claude      found      C:\\bin\\claude.exe");
        expect(text).toContain("gemini-cli  not found  gemini - install: Google's Gemini CLI");
        expect(text).toContain("1 of 2 found.");
        expect(text).toContain("the picker offers the ones found");
    });

    it("says the list is settings.json's when it names the runtimes", () => {

        const text = doctorReport({ checks, listed: true });

        expect(text).toContain("(ai.providers in settings.json)");
        expect(text).not.toContain("the ones found");
    });

    it("says where rg is, or how to install it", () => {

        expect(doctorReport({ checks, listed: false, ripgrep: "C:\\bin\\rg.exe" })).toContain("rg found at C:\\bin\\rg.exe.");

        const missing = doctorReport({ checks, listed: false });

        expect(missing).toContain("rg not found.");
        expect(missing).toContain("winget install BurntSushi.ripgrep.MSVC");
    });

    it("says the settings problem instead of a list", () => {

        expect(doctorReport({ checks: [], listed: false, problem: "settings.json could not be read: bad JSON" })).toBe("settings.json could not be read: bad JSON");
    });

    it("sums it up in one line for a first start", () => {

        expect(doctorLine(checks)).toBe("Runtimes found: claude. Not found: gemini-cli - `eesha doctor` says how to install them.");
        expect(doctorLine([checks[1]])).toContain("No runtime's program was found");
    });
});
