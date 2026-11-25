import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";

import {
    claudeWrites,
    copilotWrites,
    createJail,
    engineDirectories,
    openJail,
    pathsIn
} from "../pathJail";

/**
 * The boundary a session has. `cwd` and `additionalDirectories` are not
 * a sandbox; they only decide what the SDK asks about. The tests assert
 * containment for structured path arguments (any depth, relative or
 * absolute, through a symlink) and the last block says what is not
 * covered.
 */

/* A real directory tree, because the jail resolves symlinks. */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "jail-"));

const inside = path.join(base, "repo");
const sibling = path.join(base, "other");
const outside = path.join(base, "secrets");

fs.mkdirSync(path.join(inside, "src"), { recursive: true });
fs.mkdirSync(sibling, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

fs.writeFileSync(path.join(inside, "src", "app.ts"), "");
fs.writeFileSync(path.join(outside, "keys.txt"), "");

/*
 * A link inside a root that points out of it. Windows needs a privilege
 * for this that a normal account lacks, so tests that use it skip when
 * it could not be made.
 */
const link = path.join(inside, "escape");

const linked = (() => {

    try {
        fs.symlinkSync(outside, link, "junction");
        return true;
    } catch {
        return false;
    }
})();

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const jail = createJail(inside, [sibling]);

describe("createJail", () => {

    describe("the roots themselves", () => {

        it("allows the working directory", () => {

            expect(jail.allows(inside)).toBe(true);
        });

        it("allows a directory the host opened alongside it", () => {

            expect(jail.allows(sibling)).toBe(true);
        });

        it("allows a file under a root", () => {

            expect(jail.allows(path.join(inside, "src", "app.ts"))).toBe(true);
        });

        it("allows a file that does not exist yet, so a write can be checked before it happens", () => {

            expect(jail.allows(path.join(inside, "src", "new", "file.ts"))).toBe(true);
        });

        /* The working directory is always a root - refusing it would refuse the task. */
        it("keeps the working directory as a root even when the host opened nothing", () => {

            expect(createJail(inside).allows(inside)).toBe(true);
        });
    });

    describe("outside", () => {

        it("refuses a file above the working directory", () => {

            expect(jail.allows(path.join(outside, "keys.txt"))).toBe(false);
        });

        it("refuses a relative name that climbs out", () => {

            expect(jail.allows("../secrets/keys.txt")).toBe(false);
        });

        /* A task in a sample folder must not read the repository above it. */
        it("refuses a file in the repository above a sample folder", () => {

            const sample = createJail(path.join(inside, "src"));

            expect(sample.allows(path.join(inside, "src", "app.ts"))).toBe(true);
            expect(sample.allows(path.join(outside, "keys.txt"))).toBe(false);
        });

        /* A plain `startsWith` would put `C:\repo-backup` inside `C:\repo`. */
        it("refuses a sibling whose name merely starts with a root's", () => {

            const near = path.join(base, "repo-backup");

            fs.mkdirSync(near, { recursive: true });

            expect(jail.allows(path.join(near, "file.ts"))).toBe(false);
        });

        it.skipIf(!linked)("refuses a link inside a root that points outside it", () => {

            expect(jail.allows(path.join(link, "keys.txt"))).toBe(false);
        });

        it("refuses everything when it was given no roots at all", () => {

            expect(createJail("").roots).toEqual([]);
            expect(createJail("").allows(inside)).toBe(false);
        });
    });

    describe("a tool call", () => {

        it("passes a call whose file is inside", () => {

            expect(jail.escape({ file_path: path.join(inside, "src", "app.ts") }))
                .toBeUndefined();
        });

        it("catches a call whose file is outside", () => {

            expect(jail.escape({ file_path: path.join(outside, "keys.txt") })?.asked)
                .toBe(path.join(outside, "keys.txt"));
        });

        it("catches a path nested inside the arguments, not only a top-level one", () => {

            const input = { edits: [{ path: path.join(inside, "a.ts") }, { path: path.join(outside, "b.ts") }] };

            expect(jail.escape(input)?.asked).toBe(path.join(outside, "b.ts"));
        });

        it("catches a working directory just as it catches a file", () => {

            expect(jail.escape({ command: "ls", cwd: outside })?.asked).toBe(outside);
        });

        it("honours a path the SDK already flagged, which is all a shell command gives us", () => {

            expect(jail.escape({ command: "cat ../secrets/keys.txt" }, path.join(outside, "keys.txt"))?.asked)
                .toBe(path.join(outside, "keys.txt"));
        });

        it("ignores a flagged path that is inside after all", () => {

            expect(jail.escape({}, path.join(inside, "src", "app.ts"))).toBeUndefined();
        });

        it("passes a call with no paths in it at all", () => {

            expect(jail.escape({ pattern: "TODO", output_mode: "content" })).toBeUndefined();
        });

        it("says where the refusal came from and where the agent may work instead", () => {

            const escape = jail.escape({ file_path: path.join(outside, "keys.txt") })!;

            const message = jail.refusal(escape);

            expect(message).toContain(path.join(outside, "keys.txt"));
            expect(message).toContain(inside);
            expect(message).toContain(sibling);
        });
    });

    /*
     * Windows treats `C:\Repo` and `c:\repo` as one directory; other
     * platforms do not. The platform is passed in so the test does not
     * depend on the machine it runs on.
     */
    describe("case", () => {

        it("treats a differently-cased root as the same place on Windows", () => {

            expect(createJail("C:/Work/repo", [], true).allows("c:/work/repo/src/app.ts")).toBe(true);
        });

        it("does not, anywhere else", () => {

            expect(createJail("/work/repo", [], false).allows("/Work/Repo/src/app.ts")).toBe(false);
        });
    });
});

/*
 * The engine's own files, which a session may read and may not write.
 * An SDD phase attaches the grammar shipped in Eesha Code's
 * `resources/`, which is not under `cwd`. Read-only rather than a third
 * root: a shipped prompt the agent can rewrite changes every future run
 * on the machine.
 */
describe("the engine's own directories", () => {

    const shipped = path.join(base, "extension", "resources");

    const grammar = path.join(shipped, "styles", "custom", "grammar.md");

    fs.mkdirSync(path.dirname(grammar), { recursive: true });
    fs.writeFileSync(grammar, "the grammar");

    const guarded = createJail(inside, [sibling], undefined, [shipped]);

    it("lets a read reach the shipped grammar", () => {

        expect(guarded.allows(grammar, false)).toBe(true);
    });

    it("refuses a write to it", () => {

        expect(guarded.allows(grammar, true)).toBe(false);
    });

    /* The default. A caller that cannot tell reads from writes gets the roots only. */
    it("treats a call that did not say as a write", () => {

        expect(guarded.allows(grammar)).toBe(false);
    });

    it("passes a tool call that reads it", () => {

        expect(guarded.escape({ file_path: grammar }, undefined, false)).toBeUndefined();
    });

    it("catches a tool call that would edit it", () => {

        expect(guarded.escape({ file_path: grammar }, undefined, true)?.asked).toBe(grammar);
    });

    it("still refuses a read outside both tiers", () => {

        expect(guarded.allows(path.join(outside, "keys.txt"), false)).toBe(false);
    });

    it("reports the read-only directories separately from the roots", () => {

        expect(guarded.readable).toEqual([fs.realpathSync(shipped)]);
        expect(guarded.roots).not.toContain(fs.realpathSync(shipped));
    });

    it("names them in the refusal, so the agent is not told a readable file is unreachable", () => {

        const escape = guarded.escape({ file_path: grammar }, undefined, true)!;

        expect(guarded.refusal(escape)).toContain(fs.realpathSync(shipped));
    });

    it("adds nothing when the host named no directories", () => {

        expect(createJail(inside).readable).toEqual([]);
    });
});

describe("engineDirectories", () => {

    const home = path.join(base, "home");

    it("names Eesha Code's resources directory", () => {

        expect(engineDirectories("C:/ext/resources", home)).toContain("C:/ext/resources");
    });

    it("names the profile's styles directory", () => {

        expect(engineDirectories(undefined, home))
            .toEqual([path.join(home, ".eesha", "styles")]);
    });

    /*
     * Not the profile directory itself: it holds `settings.json` (env
     * values, tokens) and `events/` (every past run). `styles/` is the
     * only part a phase attaches.
     */
    it("does not name the profile directory itself", () => {

        for (const named of engineDirectories("C:/ext/resources", home))
            expect(named).not.toBe(path.join(home, ".eesha"));
    });

    it("says nothing about resources when there is no install behind it", () => {

        expect(engineDirectories(undefined, home)).toHaveLength(1);
    });
});

describe("which tools can change a file", () => {

    it("counts the Claude tools that only look as reads", () => {

        for (const tool of ["Read", "Glob", "Grep", "WebFetch"])
            expect(claudeWrites(tool)).toBe(false);
    });

    it("counts the ones that change a file as writes", () => {

        for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"])
            expect(claudeWrites(tool)).toBe(true);
    });

    /* An unknown tool (a future SDK's, an MCP server's) gets the roots only. */
    it("counts a tool it has never heard of as a write", () => {

        expect(claudeWrites("SomethingNew")).toBe(true);
        expect(claudeWrites("mcp__files__write")).toBe(true);
        expect(claudeWrites(undefined)).toBe(true);
    });

    it("answers the same question for Copilot's tool names", () => {

        expect(copilotWrites("view")).toBe(false);
        expect(copilotWrites("grep")).toBe(false);
        expect(copilotWrites("edit")).toBe(true);
        expect(copilotWrites(undefined)).toBe(true);
    });
});

/*
 * Opened by `debug: true` in the profile settings only. The loader
 * rejects it in a workspace settings.json, so a cloned repository cannot
 * open its own jail. That rule is tested where the loader lives.
 */
describe("openJail", () => {

    const open = openJail(inside, [sibling]);

    it("allows a file outside every root", () => {

        expect(open.allows(path.join(outside, "keys.txt"))).toBe(true);
    });

    it("allows a tool call the closed jail would refuse", () => {

        expect(open.escape({ file_path: path.join(outside, "keys.txt") })).toBeUndefined();
    });

    it("allows a path the SDK itself flagged as out of scope", () => {

        expect(open.escape({}, path.join(outside, "keys.txt"))).toBeUndefined();
    });

    /* The roots are still worked out, for the log line and the panel. */
    it("still reports the roots it is not enforcing", () => {

        expect(open.roots).toEqual(createJail(inside, [sibling]).roots);
    });

    it("still has something to say if a caller ever asks it for a refusal", () => {

        expect(open.refusal({ asked: "x", resolved: "y" })).toContain("x");
    });
});

describe("pathsIn", () => {

    it("takes a value because its key names a path", () => {

        expect(pathsIn({ file_path: "/a/b.ts" })).toEqual(["/a/b.ts"]);
    });

    /*
     * Keys are read, not values. A command line is full of absolute
     * paths outside the roots (`/usr/bin/node`), and scanning values
     * would deny the toolchain.
     */
    it("leaves a path sitting in a command string alone", () => {

        expect(pathsIn({ command: "/usr/bin/node --version" })).toEqual([]);
    });

    it("leaves a path-shaped grep pattern alone", () => {

        expect(pathsIn({ pattern: "^/api/v1/users" })).toEqual([]);
    });

    it("reads every element of a list of paths", () => {

        expect(pathsIn({ paths: ["/a.ts", "/b.ts"] })).toEqual(["/a.ts", "/b.ts"]);
    });

    it("finds a path however deeply an MCP server buries it", () => {

        expect(pathsIn({ arguments: { options: [{ target: "/deep.ts" }] } })).toEqual(["/deep.ts"]);
    });

    it("ignores an empty string, which names nothing", () => {

        expect(pathsIn({ file_path: "" })).toEqual([]);
    });

    it("ignores a non-string under a path key", () => {

        expect(pathsIn({ path: 42 })).toEqual([]);
    });

    it("returns nothing for arguments that are not an object", () => {

        expect(pathsIn(undefined)).toEqual([]);
        expect(pathsIn("just text")).toEqual([]);
    });
});

/*
 * What this jail does not do, written as tests so the limit is visible.
 *
 *   - A shell command is checked only through the path the SDK flags.
 *     The command text is not scanned: every program a build needs
 *     lives outside the roots.
 *
 *   - Confining a shell needs an OS sandbox (`sandbox: { enabled: true }`
 *     on the Claude SDK), a separate layer not switched on yet.
 */
describe("what it does not do", () => {

    it("does not read a shell command, so a climb with no absolute path in it is invisible here", () => {

        expect(jail.escape({ command: "cd .. && cat secrets/keys.txt" })).toBeUndefined();
    });

    it("does not stop a command naming a program outside the roots - and must not", () => {

        expect(jail.escape({ command: "node --version" })).toBeUndefined();
    });
});
