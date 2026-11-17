import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliBinary, globalCliBinary, requireCli } from "../providers/claudeCli";

/**
 * Finding the Claude Code CLI on a machine that installed Eesha Code
 * from a package, which ships the SDK but not its ~320 MB platform binary.
 *
 * Tested against `claudeCli` rather than `ClaudeProvider`: the provider
 * loads the SDK, and these tests run with no SDK, CLI, credentials or
 * network.
 */

let temp: string;

beforeEach(() => {

    temp = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-claude-cli-"));
});

afterEach(() => {

    fs.rmSync(temp, { recursive: true, force: true });
});

/*
 * PATH is passed as an argument, not set on `process.env`, so a machine
 * that has the CLI installed cannot leak into a `{}` call.
 */
const PATHEXT = ".COM;.EXE;.BAT;.CMD";

const EXE = process.platform === "win32" ? "claude.exe" : "claude";

/** npm's shim, the name a shell would actually find. */
function installShim(directory: string): string {

    const shim = path.join(directory, process.platform === "win32" ? "claude.cmd" : "claude.js");

    fs.writeFileSync(shim, "");

    return shim;
}

/** A file on disk, with its folders. */
function touch(file: string): string {

    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(file, "");

    return file;
}

describe("requireCli", () => {

    it("passes when a binary was found", () => {

        expect(() => requireCli("C:/somewhere/claude.exe")).not.toThrow();
    });

    it("throws when nothing was", () => {

        expect(() => requireCli(undefined)).toThrow(/Claude Code CLI not found/);
    });

    it("says what to install - the SDK's own message says to reinstall a package the user never installed", () => {

        expect(() => requireCli(undefined)).toThrow(/npm install -g @anthropic-ai\/claude-code/);
    });

    it("names the override", () => {

        expect(() => requireCli(undefined)).toThrow(/CLAUDE_CLI_PATH/);
    });
});

describe("cliBinary", () => {

    it("takes CLAUDE_CLI_PATH over everything else", () => {

        expect(cliBinary({ CLAUDE_CLI_PATH: "C:/tools/claude.exe" })).toBe("C:/tools/claude.exe");
    });

    it("ignores an empty CLAUDE_CLI_PATH rather than treating it as an answer", () => {

        // This checkout has the platform package beside the SDK, so an
        // empty override falls through to a real path, not to nothing.
        expect(cliBinary({ CLAUDE_CLI_PATH: "" })).not.toBe("");
    });

    /* Windows spells env names however it likes. */
    it("reads the override case-insensitively, the way the OS does", () => {

        expect(cliBinary({ claude_cli_path: "C:/tools/claude.exe" })).toBe("C:/tools/claude.exe");
    });

    it("finds the platform package beside the SDK, which is what a source checkout runs on", () => {

        const found = cliBinary({});

        expect(found).toBeDefined();
        expect(path.basename(found!)).toBe(EXE);
        expect(found).toContain(path.join("@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`));
    });
});

/**
 * Turning what `PATH` holds into something the SDK can spawn.
 *
 * Tested through `globalCliBinary` rather than `cliBinary`, because
 * every machine running these has the copy shipped with this checkout
 * and `cliBinary` would never reach the PATH walk.
 */
describe("globalCliBinary", () => {

    it("uses a native executable on PATH as it is", () => {

        // The native installer's layout: a real binary, no npm.
        const binary = touch(path.join(temp, EXE));

        expect(globalCliBinary(binary)).toBe(fs.realpathSync(binary));
    });

    it("walks npm's shim to the binary its install step left in claude-code/bin", () => {

        const shim = installShim(temp);

        const binary = touch(path.join(temp, "node_modules", "@anthropic-ai", "claude-code", "bin", EXE));

        expect(globalCliBinary(shim)).toBe(binary);
    });

    it("never returns the shim itself - Node cannot spawn a .cmd without a shell, and a .js is not a program", () => {

        const shim = installShim(temp);

        touch(path.join(temp, "node_modules", "@anthropic-ai", "claude-code", "bin", EXE));

        expect(globalCliBinary(shim)).not.toBe(shim);
    });

    it("finds the platform package hoisted beside claude-code", () => {

        const shim = installShim(temp);

        const binary = touch(path.join(
            temp, "node_modules", "@anthropic-ai", `claude-code-${process.platform}-${process.arch}`, EXE));

        expect(globalCliBinary(shim)).toBe(binary);
    });

    it("finds the platform package nested under claude-code", () => {

        const shim = installShim(temp);

        const binary = touch(path.join(
            temp, "node_modules", "@anthropic-ai", "claude-code", "node_modules", "@anthropic-ai",
            `claude-code-${process.platform}-${process.arch}`, EXE));

        expect(globalCliBinary(shim)).toBe(binary);
    });

    it("also accepts the SDK's own platform package installed globally", () => {

        // `npm install -g @anthropic-ai/claude-agent-sdk` puts no shim
        // on PATH, but a machine with both packages has this one too.
        const shim = installShim(temp);

        const binary = touch(path.join(
            temp, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, EXE));

        expect(globalCliBinary(shim)).toBe(binary);
    });

    it("finds nothing when the platform package never came down", () => {

        // Corporate registry: the loader installs, its optional platform
        // dependency does not.
        const shim = installShim(temp);

        expect(globalCliBinary(shim)).toBeUndefined();
    });

    it("survives a shim that is not on disk at all", () => {

        expect(globalCliBinary(path.join(temp, "nope", "claude.cmd"))).toBeUndefined();
    });

    it("follows a POSIX-style symlinked shim to the install it points into", () => {

        // `/usr/local/bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/cli.js`.
        const target = touch(path.join(temp, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"));

        const binary = touch(path.join(temp, "lib", "node_modules", "@anthropic-ai", "claude-code", "bin", EXE));

        const link = path.join(temp, "bin", "claude.js");

        fs.mkdirSync(path.dirname(link), { recursive: true });

        try {

            fs.symlinkSync(target, link, "file");

        } catch {

            // No symlink rights on this Windows account - nothing to test.
            return;
        }

        expect(globalCliBinary(link)).toBe(binary);
    });
});

describe("on PATH", () => {

    it("is reached from cliBinary through PATH and PATHEXT", () => {

        // Cannot be asserted directly on this checkout (the shipped copy
        // wins), so this only checks the walk accepts a PATH-shaped env.
        installShim(temp);

        expect(() => cliBinary({ PATH: temp, PATHEXT })).not.toThrow();
    });
});
