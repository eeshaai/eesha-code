import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SddCore } from "../SddCore";

/*
 * Which profile folder SDD reads its settings from. Eesha Code keeps its
 * own (`~/.eesha`) and hands it over; with none handed over it is
 * `<home>/.eesha`.
 */

let home: string;

const resources = path.resolve(__dirname, "..", "..", "..", "resources");

function profileSettings(folder: string, value: unknown): void {

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "settings.json"), JSON.stringify(value), "utf8");
}

beforeEach(() => {

    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-sddprofile-")));
    fs.mkdirSync(path.join(home, "repo"), { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("SDD's profile folder", () => {

    it("reads the profile folder it is handed, not <home>/.eesha", async () => {

        profileSettings(path.join(home, ".eesha"), { ai: { providers: ["ghcp"] } });
        profileSettings(path.join(home, "profile"), { ai: { providers: ["ghcp", "claude"] } });

        const core = await SddCore.create({ workspace: path.join(home, "repo"), resources, home, profile: path.join(home, "profile") });

        expect(core.config.providerIds).toEqual(["ghcp", "claude"]);
    });

    it("keeps <home>/.eesha when none is handed over", async () => {

        profileSettings(path.join(home, ".eesha"), { ai: { providers: ["ghcp"] } });

        const core = await SddCore.create({ workspace: path.join(home, "repo"), resources, home });

        expect(core.config.providerIds).toEqual(["ghcp"]);
    });

    it("keeps a fake pick when the profile turns the fakeRuntime flag on", async () => {

        profileSettings(path.join(home, ".eesha"), { features: { fakeRuntime: true } });

        const core = await SddCore.create(
            { workspace: path.join(home, "repo"), resources, home, profile: path.join(home, ".eesha") },
            { aiPick: { provider: "fake" } });

        expect(core.config.providerIds).toContain("fake");
        expect(core.config.aiPick).toEqual({ provider: "fake" });
    });
});
