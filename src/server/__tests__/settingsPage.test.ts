// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eeshaPath } from "../paths";
import { addRuntime, changeSettings, freePort, PAGE_FLAGS, removeRuntime, saveSettingsText, sddModuleOn, settingsView, splitArgs } from "../settingsPage";
import { writeSession } from "../sessions";
import { emptyTrash, orphanScratch, removeOrphanScratch, scratchStats, trashStats } from "../storage";

/*
 * The settings page's server side, against the throwaway home's
 * ~/.eesha/settings.json.
 */

const file = () => eeshaPath("settings.json");

const written = () => JSON.parse(fs.readFileSync(file(), "utf8"));

// The runtimes found are looked up on PATH and two *_CLI_PATH settings.
// The tests set them so that only claude is found: an empty PATH, no
// Copilot path, and a Claude path (taken as it is, never checked).
//
// Only these three are put back after each test. Never the whole
// environment: it is copied when this file loads, before the setup
// moves the home folder, so putting it all back would point every later
// test at the real ~/.eesha - and the clean-up below would delete its
// chats' folder lists, settings.json, trash and scratch folders.
const OWN_VARIABLES = ["PATH", "COPILOT_CLI_PATH", "CLAUDE_CLI_PATH"] as const;

const realEnv: Record<string, string | undefined> = Object.fromEntries(OWN_VARIABLES.map(name => [name, process.env[name]]));

beforeEach(() => {

    // On Windows this is the same setting as `Path`.
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-no-programs-"));
    delete process.env.COPILOT_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = "/fake/claude";

    fs.rmSync(file(), { force: true });
    fs.rmSync(eeshaPath("trash"), { recursive: true, force: true });
    fs.rmSync(eeshaPath("scratch"), { recursive: true, force: true });
    fs.rmSync(eeshaPath("sessions"), { recursive: true, force: true });
});

afterEach(() => {

    for (const name of OWN_VARIABLES) {

        const value = realEnv[name];

        if (value === undefined)
            delete process.env[name];
        else
            process.env[name] = value;
    }
});

describe("what the page shows", () => {

    it("works with no settings.json: dark, only the runtimes found ticked, the flags that matter here", async () => {

        const view = await settingsView(7420, new Set());

        expect(view).toMatchObject({ file: file(), text: "", theme: "dark", port: 7420, runningPort: 7420, providersListed: false, defaultRuntime: "claude" });
        expect(view.problem).toBeUndefined();
        expect(view.runtimes.map(runtime => runtime.id).slice(0, 2)).toEqual(["ghcp", "claude"]);
        expect(view.runtimes.filter(runtime => runtime.shown).map(runtime => runtime.id)).toEqual(["claude"]);
        expect(view.flags.map(flag => flag.name)).toEqual([...PAGE_FLAGS]);
        expect(view.flags.find(flag => flag.name === "handover")?.on).toBe(true);
        expect(view.runtimes.every(runtime => !runtime.own)).toBe(true);
    });

    it("says why a broken file cannot be read, and keeps its text for the text box", async () => {

        fs.mkdirSync(eeshaPath(), { recursive: true });
        fs.writeFileSync(file(), "{ not json");

        const view = await settingsView(7420, new Set());

        expect(view.problem).toContain("not valid JSON");
        expect(view.text).toBe("{ not json");
        expect(view.runtimes).toEqual([]);
    });
});

describe("a simple control's change", () => {

    it("writes the theme, the port and a flag, keeping what else the file holds", async () => {

        await saveSettingsText(JSON.stringify({ ai: { mcpServers: {} } }));

        expect(await changeSettings({ theme: "system" })).toEqual({ ok: true });
        expect(await changeSettings({ port: 7500 })).toEqual({ ok: true });
        expect(await changeSettings({ flag: { name: "steering", on: true } })).toEqual({ ok: true });

        expect(written()).toEqual({ ai: { mcpServers: {} }, eesha: { theme: "system", port: 7500 }, features: { steering: true } });

        const view = await settingsView(7420, new Set());

        expect(view).toMatchObject({ theme: "system", port: 7500, runningPort: 7420 });
        expect(view.flags.find(flag => flag.name === "steering")?.on).toBe(true);
    });

    it("keeps the SDD module off until Feature-SDD is turned on, and off for a broken file", async () => {

        expect(await sddModuleOn()).toBe(false);
        expect((await settingsView(7420, new Set())).flags.find(flag => flag.name === "Feature-SDD")?.on).toBe(false);

        expect(await changeSettings({ flag: { name: "Feature-SDD", on: true } })).toEqual({ ok: true });
        expect(written()).toEqual({ features: { "Feature-SDD": true } });
        expect(await sddModuleOn()).toBe(true);

        fs.writeFileSync(file(), "{ not json");

        expect(await sddModuleOn()).toBe(false);
    });

    it("writes the text size, and refuses one that is not a whole number from 11 to 24", async () => {

        await saveSettingsText(JSON.stringify({ eesha: { theme: "light" } }));

        expect(await changeSettings({ fontSize: 15 })).toEqual({ ok: true });
        expect(written()).toEqual({ eesha: { theme: "light", fontSize: 15 } });
        expect((await settingsView(7420, new Set())).fontSize).toBe(15);

        expect(await changeSettings({ fontSize: 25 })).toHaveProperty("problem");
        expect(await changeSettings({ fontSize: 10 })).toHaveProperty("problem");
        expect(written()).toEqual({ eesha: { theme: "light", fontSize: 15 } });
    });

    it("writes the working folders, each once, drops the key for an empty list, and refuses a path that is not full", async () => {

        await saveSettingsText(JSON.stringify({ eesha: { theme: "light" } }));

        const [one, two] = [fs.mkdtempSync(path.join(os.tmpdir(), "eesha-work-")), fs.mkdtempSync(path.join(os.tmpdir(), "eesha-work-"))];

        expect(await changeSettings({ workingFolders: [one, two, one + path.sep] })).toEqual({ ok: true });
        expect(written()).toEqual({ eesha: { theme: "light", workingFolders: [one, two] } });
        expect((await settingsView(7420, new Set())).workingFolders).toEqual([one, two]);

        expect(await changeSettings({ workingFolders: ["relative/folder"] })).toEqual({ problem: "\"relative/folder\" in the working folders is not a full folder path." });
        expect(await changeSettings({ workingFolders: "C:\\work" as unknown as string[] })).toEqual({ problem: "The working folders must be a list of folder paths." });
        expect(written().eesha.workingFolders).toEqual([one, two]);

        expect(await changeSettings({ workingFolders: [] })).toEqual({ ok: true });
        expect(written()).toEqual({ eesha: { theme: "light" } });
    });

    it("refuses a settings.json whose working folders are wrong", async () => {

        expect(await saveSettingsText(JSON.stringify({ eesha: { workingFolders: ["relative"] } }))).toHaveProperty("problem");
        expect(fs.existsSync(file())).toBe(false);
    });

    it("writes the runtimes the picker shows, and drops the list when just the ones found are shown in the usual order", async () => {

        expect(await changeSettings({ providers: ["claude", "ghcp"] })).toEqual({ ok: true });
        expect(written().ai.providers).toEqual(["claude", "ghcp"]);

        const view = await settingsView(7420, new Set());

        expect(view.providersListed).toBe(true);
        expect(view.runtimes.slice(0, 3).map(runtime => [runtime.id, runtime.shown])).toEqual([["claude", true], ["ghcp", true], [view.runtimes[2].id, false]]);

        // Back to the one found: no list, so a runtime installed later is ticked by itself.
        expect(await changeSettings({ providers: ["claude"] })).toEqual({ ok: true });
        expect(written().ai.providers).toBeUndefined();
        expect((await settingsView(7420, new Set())).providersListed).toBe(false);
    });

    it("keeps the default where it was when a tick changes, so a list without ghcp is not refused", async () => {

        // ghcp is not found, so it is not ticked. Ticking a second runtime
        // writes a list without ghcp; the engine takes it only because the
        // default in effect - claude - is written down with it.
        expect(await changeSettings({ providers: ["claude", "kiro-cli"] })).toEqual({ ok: true });
        expect(written().ai).toEqual({ providers: ["claude", "kiro-cli"], "ai@1": { provider: "claude" } });
        expect((await settingsView(7420, new Set())).defaultRuntime).toBe("claude");
    });

    it("sets the default runtime, only to one the picker shows", async () => {

        expect(await changeSettings({ defaultRuntime: "ghcp" })).toEqual({ problem: expect.stringContaining("Tick ghcp first") });

        expect(await changeSettings({ providers: ["ghcp", "claude"] })).toEqual({ ok: true });
        expect(await changeSettings({ defaultRuntime: "ghcp" })).toEqual({ ok: true });
        expect(written().ai["ai@1"]).toEqual({ provider: "ghcp" });
        expect((await settingsView(7420, new Set())).defaultRuntime).toBe("ghcp");

        expect(await changeSettings({ defaultRuntime: "" })).toHaveProperty("problem");
    });

    it("keeps the other ai@1 defaults when it writes the default runtime", async () => {

        await saveSettingsText(JSON.stringify({ ai: { "ai@1": { model: "auto" } } }));

        expect(await changeSettings({ defaultRuntime: "claude" })).toEqual({ ok: true });
        expect(written().ai["ai@1"]).toEqual({ model: "auto", provider: "claude" });
    });

    it("refuses what the file cannot hold, and leaves the file as it was", async () => {

        await changeSettings({ theme: "light" });

        const before = fs.readFileSync(file(), "utf8");

        expect(await changeSettings({ port: 80 })).toEqual({ problem: expect.stringContaining("1024 to 65535") });
        expect(await changeSettings({ providers: [] })).toEqual({ problem: expect.stringContaining("at least one") });
        expect(await changeSettings({ providers: ["no-such-runtime"] })).toHaveProperty("problem");
        expect(await changeSettings({ flag: { name: "evals", on: true } })).toEqual({ problem: "Not a flag this page changes." });
        expect(await changeSettings({ theme: "blue" as never })).toHaveProperty("problem");

        expect(fs.readFileSync(file(), "utf8")).toBe(before);
    });

    it("is refused while the file is broken - the text box fixes it first", async () => {

        fs.mkdirSync(eeshaPath(), { recursive: true });
        fs.writeFileSync(file(), "{ not json");

        expect(await changeSettings({ theme: "light" })).toEqual({ problem: expect.stringContaining("Fix it in the text box") });
        expect(fs.readFileSync(file(), "utf8")).toBe("{ not json");
    });
});

describe("adding and removing a runtime", () => {

    // A program that is surely on the machine, by its full path: node itself.
    const node = process.execPath;

    const answers = () => {

        const calls: { command: string; args: readonly string[] }[] = [];

        const probe = async (command: string, args: readonly string[]) => {

            calls.push({ command, args });

            return { ok: true as const };
        };

        return { calls, probe };
    };

    it("splits the arguments on spaces, keeping a quoted one whole", () => {

        expect(splitArgs("--acp  --model \"big one\" x")).toEqual(["--acp", "--model", "big one", "x"]);
        expect(splitArgs("")).toEqual([]);
        expect(splitArgs("--name \"\"")).toEqual(["--name", ""]);
        expect(splitArgs("\"open")).toBeUndefined();
    });

    it("checks the program, then writes it into ai.acpAgents - shown by itself with no list", async () => {

        const { calls, probe } = answers();

        expect(await addRuntime({ id: "my-agent", command: node, args: "--acp --x \"a b\"" }, probe)).toEqual({ ok: true });
        expect(calls).toEqual([{ command: node, args: ["--acp", "--x", "a b"] }]);
        expect(written().ai).toEqual({ acpAgents: { "my-agent": { command: node, args: ["--acp", "--x", "a b"] } } });

        const view = await settingsView(7420, new Set());
        const mine = view.runtimes.find(runtime => runtime.id === "my-agent");

        expect(mine).toMatchObject({ own: true, shown: true, found: node });
    });

    it("puts it on the end of ai.providers when the file lists the runtimes", async () => {

        await changeSettings({ providers: ["claude", "ghcp"] });

        expect(await addRuntime({ id: "mine", command: node }, answers().probe)).toEqual({ ok: true });
        expect(written().ai.providers).toEqual(["claude", "ghcp", "mine"]);
        expect(written().ai.acpAgents).toEqual({ mine: { command: node } });
    });

    it("refuses before starting anything: a bad id, a taken id, no command, a program not found, an open quote", async () => {

        const { calls, probe } = answers();

        expect(await addRuntime({ id: "has space", command: node }, probe)).toEqual({ problem: expect.stringContaining("The id is") });
        expect(await addRuntime({ id: "Claude", command: node }, probe)).toEqual({ problem: expect.stringContaining("already a runtime") });
        expect(await addRuntime({ id: "x", command: "  " }, probe)).toEqual({ problem: expect.stringContaining("Type the command") });
        expect(await addRuntime({ id: "x", command: "no-such-program-here" }, probe)).toEqual({ problem: expect.stringContaining("not found on this machine") });
        expect(await addRuntime({ id: "x", command: node, args: "\"open" }, probe)).toEqual({ problem: expect.stringContaining("not closed") });

        expect(calls).toEqual([]);
        expect(fs.existsSync(file())).toBe(false);
    });

    it("writes nothing when the program does not answer as an ACP agent", async () => {

        const refused = async () => ({ problem: "did not answer" });

        expect(await addRuntime({ id: "x", command: node }, refused)).toEqual({ problem: "did not answer" });
        expect(fs.existsSync(file())).toBe(false);
    });

    it("removes only a runtime you added, and never the default one", async () => {

        await addRuntime({ id: "mine", command: node }, answers().probe);

        // Not the usual order, so the list is kept (the usual order is the same as no list).
        await changeSettings({ providers: ["mine", "claude"] });

        expect(await removeRuntime("claude")).toEqual({ problem: expect.stringContaining("Only a runtime you added") });
        expect(await removeRuntime("kiro-cli")).toEqual({ problem: expect.stringContaining("Only a runtime you added") });

        expect(await changeSettings({ defaultRuntime: "mine" })).toEqual({ ok: true });
        expect(await removeRuntime("mine")).toEqual({ problem: expect.stringContaining("default runtime") });

        expect(await changeSettings({ defaultRuntime: "claude" })).toEqual({ ok: true });
        expect(await removeRuntime("mine")).toEqual({ ok: true });
        expect(written().ai.acpAgents).toBeUndefined();
        expect(written().ai.providers).toEqual(["claude"]);
    });

    it("finds a port nothing listens on", async () => {

        const port = await freePort();

        expect(port).toBeGreaterThanOrEqual(1024);
        expect(port).toBeLessThanOrEqual(65535);
    });
});

describe("runtime tools", () => {

    it("writes one runtime's tools and shows them", async () => {

        expect(await changeSettings({ runtimeTools: { id: "kiro-cli-v3", toolsOff: ["str_replace", " fs_write ", "str_replace"] } })).toEqual({ ok: true });

        expect(written().eesha.runtimes).toEqual({ "kiro-cli-v3": { toolsOff: ["str_replace", "fs_write"] } });

        const view = await settingsView(7420, new Set());

        expect(view.runtimeTools).toEqual({ "kiro-cli-v3": { toolsOff: ["str_replace", "fs_write"] } });
    });

    it("removes the entry, and the empty block, when the list is empty", async () => {

        await changeSettings({ theme: "light" });
        await changeSettings({ runtimeTools: { id: "claude", toolsOff: ["WebFetch"] } });
        await changeSettings({ runtimeTools: { id: "claude", toolsOff: [] } });

        expect(written().eesha).toEqual({ theme: "light" });
    });

    it("refuses a bad id and a name with a comma", async () => {

        expect(await changeSettings({ runtimeTools: { id: "", toolsOff: [] } })).toHaveProperty("problem");
        expect(await changeSettings({ runtimeTools: { id: "claude", toolsOff: ["a,b"] } })).toHaveProperty("problem");
        expect(fs.existsSync(file())).toBe(false);
    });
});

describe("the text box", () => {

    it("saves a file the engine reads, and refuses one it would fail on", async () => {

        expect(await saveSettingsText(`{ "eesha": { "theme": "light" } }\n`)).toEqual({ ok: true });

        expect(await saveSettingsText("{ oops")).toEqual({ problem: expect.stringContaining("not valid JSON") });
        expect(await saveSettingsText(`{ "unknown": {} }`)).toHaveProperty("problem");
        expect(await saveSettingsText(`{ "eesha": { "theme": "blue" } }`)).toEqual({ problem: expect.stringContaining("eesha.theme") });

        expect(fs.readFileSync(file(), "utf8")).toBe(`{ "eesha": { "theme": "light" } }\n`);
    });
});

describe("storage", () => {

    it("counts and empties the trash", () => {

        fs.mkdirSync(eeshaPath("trash", "20261111-a"), { recursive: true });
        fs.writeFileSync(eeshaPath("trash", "20261111-a", "x.ts"), "12345");
        fs.writeFileSync(eeshaPath("trash", "loose.txt"), "123");

        expect(trashStats()).toEqual({ files: 2, bytes: 8 });

        emptyTrash();

        expect(trashStats()).toEqual({ files: 0, bytes: 0 });
        expect(fs.existsSync(eeshaPath("trash"))).toBe(true);
    });

    it("removes only the scratch folders no chat uses", () => {

        for (const id of ["saved", "deleted", "shared", "held"]) {

            fs.mkdirSync(eeshaPath("scratch", id), { recursive: true });
            fs.writeFileSync(eeshaPath("scratch", id, "notes.md"), "abc");
        }

        writeSession("saved", { folders: [], scratch: true });

        // A copy made by going back works in "shared".
        writeSession("copy", { folders: [], scratch: true, scratchOf: "shared" });

        expect(orphanScratch(new Set(["held"]))).toEqual([eeshaPath("scratch", "deleted")]);
        expect(scratchStats(new Set(["held"]))).toEqual({ folders: 1, bytes: 3 });

        removeOrphanScratch(new Set(["held"]));

        expect(fs.readdirSync(eeshaPath("scratch")).sort()).toEqual(["held", "saved", "shared"]);
    });
});
