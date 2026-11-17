import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalCliBinary, requireCli } from "../providers/copilotCli";

/**
 * The prerequisite check. The SDK spawns the Copilot CLI (~340 MB, not
 * bundled). Without this check the failure is a spawn error naming a
 * path inside `node_modules`.
 *
 * Tested against `copilotCli` rather than `CopilotProvider`: the
 * provider imports the SDK, and these tests run with no SDK, CLI,
 * credentials or network.
 */

let temp: string;

beforeEach(() => {

    temp = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-cli-"));
});

afterEach(() => {

    fs.rmSync(temp, { recursive: true, force: true });
});

/*
 * PATH is passed as an argument, not set on `process.env`, so a machine
 * that has the CLI installed cannot leak into a `{}` call.
 */
const PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The name a shell would actually find, per platform. */
function installCli(directory: string): string {

    const name = process.platform === "win32" ? "copilot.cmd" : "copilot";

    const shim = path.join(directory, name);

    fs.writeFileSync(shim, "");

    return shim;
}

/** What this platform's package is called, the way the SDK names it. */
function platformPackage(): string {

    const variant = process.platform === "linux" ? "linux" : process.platform;

    return `copilot-${variant}-${process.arch}`;
}

/**
 * An npm global install in the Windows shape (shim in the prefix,
 * packages in `node_modules` beneath it), because both branches of the
 * walk reach it without a symlink on every platform.
 */
function installGlobally(prefix: string, executable = "copilot.exe"): { shim: string; binary: string } {

    const root = path.join(prefix, "node_modules", "@github", platformPackage());

    fs.mkdirSync(root, { recursive: true });

    // `exports["."]` is what the walk reads.
    fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: `@github/${platformPackage()}`, exports: { ".": `./${executable}` } }));

    const binary = path.join(root, executable);

    fs.writeFileSync(binary, "");

    return { shim: installCli(prefix), binary };
}

describe("requireCli", () => {

    it("passes when the environment already names a CLI", () => {

        expect(() => requireCli({ COPILOT_CLI_PATH: "C:/somewhere/copilot.exe" })).not.toThrow();
    });

    it("passes when the CLI is on PATH, which is where a global install lands", () => {

        installCli(temp);

        expect(() => requireCli({ PATH: temp, PATHEXT })).not.toThrow();
    });

    it("throws when it is nowhere", () => {

        expect(() => requireCli({})).toThrow(/Copilot CLI not found/);
    });

    it("says what to install, because a message nobody can act on helps no one", () => {

        expect(() => requireCli({})).toThrow(/npm install -g @github\/copilot/);
    });

    it("says the CLI is not the Copilot extension - the mistake this is most often read as", () => {

        expect(() => requireCli({})).toThrow(/Copilot CLI program itself is needed/);
    });

    it("ignores an empty COPILOT_CLI_PATH rather than treating it as an answer", () => {

        expect(() => requireCli({ COPILOT_CLI_PATH: "" })).toThrow(/Copilot CLI not found/);
    });

    it("does not mistake a directory named copilot for the executable", () => {

        fs.mkdirSync(path.join(temp, process.platform === "win32" ? "copilot.cmd" : "copilot"));

        expect(() => requireCli({ PATH: temp, PATHEXT })).toThrow(/Copilot CLI not found/);
    });

    it("keeps looking past a PATH entry that does not exist", () => {

        installCli(temp);

        expect(() => requireCli({
            PATH: [path.join(temp, "nope"), temp].join(path.delimiter),
            PATHEXT
        })).not.toThrow();
    });

    /* Windows spells the real key `Path`. */
    it("reads PATH case-insensitively, the way the OS does", () => {

        installCli(temp);

        expect(() => requireCli({ Path: temp, PathExt: PATHEXT })).not.toThrow();
    });
});

/**
 * Turning what `PATH` holds into something the SDK can spawn. The SDK
 * resolves the CLI through its own `node_modules` walk and never sees a
 * global install on its own.
 *
 * Tested through `globalCliBinary` rather than `cliBinary`, because
 * every machine running these has the copy shipped with this build.
 */
describe("globalCliBinary", () => {

    it("finds the executable belonging to a global install", () => {

        const { shim, binary } = installGlobally(temp);

        expect(globalCliBinary(shim)).toBe(binary);
    });

    it("returns the executable, never the shim PATH actually found", () => {

        const { shim } = installGlobally(temp);

        // The SDK spawns a non-`.js` path with no shell, and Node will
        // not spawn a `.cmd` that way (`spawn EINVAL`).
        expect(globalCliBinary(shim)).not.toBe(shim);
    });

    it("reads the executable's name from the package rather than guessing it", () => {

        const { shim, binary } = installGlobally(temp, "copilot-renamed.bin");

        expect(globalCliBinary(shim)).toBe(binary);
    });

    it("finds nothing when the platform package never came down", () => {

        // Corporate registry: the loader installs, its optional platform
        // dependency does not.
        const shim = installCli(temp);

        expect(globalCliBinary(shim)).toBeUndefined();
    });

    it("finds nothing when the package declares an executable that is not there", () => {

        const { shim, binary } = installGlobally(temp);

        fs.rmSync(binary);

        expect(globalCliBinary(shim)).toBeUndefined();
    });

    it("survives a shim that is not on disk at all", () => {

        expect(globalCliBinary(path.join(temp, "nope", "copilot.cmd"))).toBeUndefined();
    });
});

/*
 * `cliBinary` itself has no tests. Covering it means controlling
 * `require.resolve`, and every attempt ended as a test that passed for
 * whichever branch this checkout happens to take.
 */
