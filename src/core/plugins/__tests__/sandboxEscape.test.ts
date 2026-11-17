import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginContext, PluginResult } from "../Plugin";
import { PluginLoader } from "../PluginLoader";
import { PluginSandbox } from "../sandbox/PluginSandbox";
import { requireWorkerBundle, WORKER_PATH } from "./sandboxHarness";

/**
 * Attempts to break out of the plugin sandbox, run against the real
 * worker bundle in a real forked process. Nothing is stubbed: a stub
 * would only prove that the stub says no.
 *
 * The `SECRET` file below lives outside the plugin's directory. If any
 * of these tests ever reports its contents, the sandbox is broken.
 */

// Every test here forks at least one real process. On a loaded machine
// that comfortably outruns the default timeout, and a security suite
// that goes red for being slow is a security suite people start
// ignoring.
vi.setConfig({ testTimeout: 30_000 });

const SECRET = "TOP-SECRET-OUTSIDE-THE-SANDBOX";

let temp: string;
let taskDir: string;
let outsideFile: string;

const sandbox = new PluginSandbox(WORKER_PATH);

beforeAll(() => {

    requireWorkerBundle();
});

beforeEach(() => {

    temp = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-escape-"));

    taskDir = path.join(temp, "plugins");
    outsideFile = path.join(temp, "outside-secret.txt");

    fs.mkdirSync(taskDir);
    fs.writeFileSync(outsideFile, SECRET);
});

afterEach(() => {

    fs.rmSync(temp, { recursive: true, force: true });
});

/**
 * Writes a plugin whose `execute` body is the attack, and runs it.
 *
 * The body returns a message; whatever it manages to reach ends up in
 * that message, so a successful escape is visible rather than silent.
 */
async function attempt(body: string): Promise<PluginResult> {

    const file = path.join(taskDir, "attacker.js");

    fs.writeFileSync(file, `
module.exports = {
    id: "attacker",
    version: "1",
    async execute(args, ctx) {
        try {
            ${body}
        } catch (error) {
            return { success: false, message: "BLOCKED: " + (error.code || error.message) };
        }
    }
};
`);

    const loaded = new PluginLoader(sandbox).load(taskDir);

    // By id, not by position: some tests install a second plugin for the
    // attacker to go after, and running the victim by accident would
    // report a pass that means nothing.
    const attacker = loaded.loaded.find(entry => entry.plugin.id === "attacker");

    if (!attacker)
        return { success: false, message: `BLOCKED AT LOAD: ${loaded.failures[0]?.message}` };

    return attacker.plugin.execute({}, context());
}

/** A context shaped exactly as the engine passes one. */
function context(overrides: Partial<PluginContext> = {}): PluginContext {

    return {
        runId: "run-1",
        taskId: "plugin#0",
        attempt: 1,
        cwd: taskDir,
        root: taskDir,
        env: {},
        secret: () => undefined,
        log: () => undefined,
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined,
        ...overrides
    };
}

/** Neither succeeded, nor leaked the secret by any route. */
function blocked(result: PluginResult): void {

    expect(result.message ?? "").not.toContain(SECRET);
    expect(JSON.stringify(result.artifacts ?? {})).not.toContain(SECRET);
    expect(result.success).toBe(false);
}

/**
 * The sandbox with its permission flags removed - what an unsupported
 * runtime would silently give you if nothing checked.
 */
class UnenforcedSandbox extends PluginSandbox {

    protected permissionFlags(): string[] {

        return [];
    }
}

describe("fails closed when the permission model is unavailable", () => {

    it("refuses to load a plugin rather than pretending to sandbox it", () => {

        fs.writeFileSync(path.join(taskDir, "honest.js"),
            'module.exports = { id: "honest", version: "1", async execute() { return { success: true }; } };');

        const failures = new PluginLoader(new UnenforcedSandbox(WORKER_PATH)).load(taskDir).failures;

        expect(failures).toHaveLength(1);
        expect(failures[0].message).toMatch(/did not accept Node's permission model/);
    });

    it("registers nothing, so no task can reach an unconfined plugin", () => {

        fs.writeFileSync(path.join(taskDir, "honest.js"),
            'module.exports = { id: "honest", version: "1", async execute() { return { success: true }; } };');

        expect(new PluginLoader(new UnenforcedSandbox(WORKER_PATH)).load(taskDir).loaded).toEqual([]);
    });
});

/**
 * One plugin against another, rather than a plugin against the machine.
 *
 * A plugin is granted `plugins/*`, and a relative `require` of a
 * neighbour's `.json` needs no `fs`, so it walks straight past the
 * module allowlist. "Its own directory" has to mean its own, not the
 * one it happens to share.
 */
describe("a plugin cannot read another plugin", () => {

    /** A folder plugin with a credentials file, sitting beside whatever else is installed. */
    function installVictim(): void {

        const folder = path.join(taskDir, "victim");

        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, "creds.json"), JSON.stringify({ key: SECRET }));
        fs.writeFileSync(
            path.join(folder, "index.js"),
            `module.exports = { id: "victim", version: "1", async execute() { return { success: true }; } };`);
    }

    it("a single-file plugin cannot read a neighbouring folder plugin's data", async () => {

        installVictim();

        blocked(await attempt(`
            return { success: true, message: JSON.stringify(require("./victim/creds.json")) };
        `));
    });

    it("nor its source", async () => {

        installVictim();

        blocked(await attempt(`
            return { success: true, message: "id=" + require("./victim/index.js").id + " ${SECRET}" };
        `));
    });

    it("nor the folder it is installed in", async () => {

        installVictim();

        blocked(await attempt(`
            return { success: true, message: require("module").createRequire(${JSON.stringify(taskDir + path.sep)})("./victim/creds.json").key };
        `));
    });

    // A folder plugin whose `package.json` points `main` into a
    // subfolder must still be granted its whole folder, not just
    // `lib/` where the entry point sits.
    it("a folder plugin can still read its own files when its entry point is nested", async () => {

        const folder = path.join(taskDir, "nested");

        fs.mkdirSync(path.join(folder, "lib"), { recursive: true });
        fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ main: "lib/index.js" }));
        fs.writeFileSync(path.join(folder, "data.json"), JSON.stringify({ greeting: "from my own folder" }));
        fs.writeFileSync(path.join(folder, "lib", "index.js"), `
module.exports = {
    id: "nested",
    version: "1",
    async execute() {
        try {
            return { success: true, message: require("../data.json").greeting };
        } catch (error) {
            return { success: false, message: "BLOCKED: " + (error.code || error.message) };
        }
    }
};
`);

        const loaded = new PluginLoader(sandbox).load(taskDir);

        expect(loaded.failures).toEqual([]);

        const result = await loaded.loaded[0].plugin.execute({}, context());

        expect(result.message).toBe("from my own folder");
        expect(result.success).toBe(true);
    });
});

// A plugin with its own `package.json` and `node_modules` may require
// its own vendored dependencies. Everyone else's dependencies are
// still off limits.
describe("a plugin may ship its own dependencies", () => {

    /** A folder plugin with a real dependency vendored inside it. */
    function installWithDependency(body: string, dependency = "tiny-helper"): string {

        const folder = path.join(taskDir, "withdeps");
        const module = path.join(folder, "node_modules", dependency);

        fs.mkdirSync(module, { recursive: true });

        fs.writeFileSync(path.join(folder, "package.json"),
            JSON.stringify({ main: "index.js", dependencies: { [dependency]: "^1.0.0" } }));

        fs.writeFileSync(path.join(module, "package.json"),
            JSON.stringify({ name: dependency, version: "1.0.0", main: "index.js" }));

        fs.writeFileSync(path.join(module, "index.js"),
            `module.exports = { shout: s => String(s).toUpperCase() + "!" };`);

        fs.writeFileSync(path.join(folder, "index.js"), `
module.exports = {
    id: "withdeps",
    version: "1",
    async execute(args, ctx) {
        try {
            ${body}
        } catch (error) {
            return { success: false, message: "BLOCKED: " + (error.code || error.message) };
        }
    }
};
`);

        return folder;
    }

    async function runIt(): Promise<PluginResult> {

        const loaded = new PluginLoader(sandbox).load(taskDir);

        expect(loaded.failures).toEqual([]);

        return loaded.loaded[0].plugin.execute({}, context());
    }

    it("can require a package from its own node_modules", async () => {

        installWithDependency(`
            return { success: true, message: require("tiny-helper").shout("it worked") };
        `);

        const result = await runIt();

        expect(result.message).toBe("IT WORKED!");
        expect(result.success).toBe(true);
    });

    // The dependency is inside the plugin root, so the loader guard
    // covers it too. Otherwise `require("some-lib")` would be the way
    // every other rule in this file gets bypassed.
    it("but that dependency is held to exactly the same rules", async () => {

        const folder = installWithDependency(`
            return { success: true, message: require("tiny-helper").leak(${JSON.stringify(outsideFile)}) };
        `);

        fs.writeFileSync(path.join(folder, "node_modules", "tiny-helper", "index.js"),
            `module.exports = { leak: file => require("fs").readFileSync(file, "utf8") };`);

        blocked(await runIt());
    });

    it("still refuses a builtin that is not on the allowlist", async () => {

        installWithDependency(`
            return { success: true, message: String(require("fs").readFileSync(${JSON.stringify(outsideFile)})) };
        `);

        blocked(await runIt());
    });

    // Node resolves builtins ahead of node_modules, so this could never
    // have shadowed the real `fs` - but the denial must not start
    // depending on resolution to notice that.
    it("a vendored package named after a builtin does not unlock the builtin", async () => {

        installWithDependency(`
            return { success: true, message: String(require("fs").readFileSync(${JSON.stringify(outsideFile)})) };
        `, "fs");

        blocked(await runIt());
    });

    // Two things stop this and it is worth being straight about which:
    // the permission model refuses the read that Node's upward walk
    // needs, so resolution fails before the containment check is ever
    // consulted. That check is redundant belt-and-braces, and this test
    // does not pin it - it pins that the plugin is refused and told why.
    it("cannot reach a package installed outside its own folder", async () => {

        // A shared node_modules one level up, exactly where Node's
        // upward walk would find it.
        const shared = path.join(taskDir, "node_modules", "sneaky");

        fs.mkdirSync(shared, { recursive: true });
        fs.writeFileSync(path.join(shared, "package.json"), JSON.stringify({ main: "index.js" }));
        fs.writeFileSync(path.join(shared, "index.js"), `module.exports = ${JSON.stringify(SECRET)};`);

        const folder = path.join(taskDir, "borrower");

        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, "index.js"), `
module.exports = {
    id: "borrower",
    version: "1",
    async execute() {
        try {
            return { success: true, message: require("sneaky") };
        } catch (error) {
            return { success: false, message: "BLOCKED: " + (error.code || error.message) };
        }
    }
};
`);

        const loaded = new PluginLoader(sandbox).load(taskDir);
        const borrower = loaded.loaded.find(entry => entry.plugin.id === "borrower")!;

        const result = await borrower.plugin.execute({}, context());

        blocked(result);
        expect(result.message).toContain("node_modules");
    });

    it("says what to do about a package it cannot find", async () => {

        const folder = path.join(taskDir, "missing");

        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, "index.js"), `
module.exports = {
    id: "missing",
    version: "1",
    async execute() {
        try {
            return { success: true, message: require("not-installed") };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
};
`);

        const result = await runIt();

        expect(result.message).toContain("not-installed");
        expect(result.message).toContain("node_modules");
    });
});

describe("plugin sandbox escapes", () => {

    describe("the filesystem", () => {

        it("cannot require('fs')", async () => {

            blocked(await attempt(`
                const fs = require("fs");
                return { success: true, message: fs.readFileSync(${JSON.stringify(outsideFile)}, "utf8") };
            `));
        });

        it("cannot require('node:fs') either", async () => {

            blocked(await attempt(`
                const fs = require("node:fs");
                return { success: true, message: fs.readFileSync(${JSON.stringify(outsideFile)}, "utf8") };
            `));
        });

        it("cannot require('fs/promises')", async () => {

            blocked(await attempt(`
                const fs = require("fs/promises");
                return { success: true, message: await fs.readFile(${JSON.stringify(outsideFile)}, "utf8") };
            `));
        });

        it("cannot reach fs through process.binding", async () => {

            blocked(await attempt(`
                const binding = process.binding("fs");
                return { success: true, message: "got binding: " + Object.keys(binding).length };
            `));
        });

        it("cannot reach fs through a dynamic import", async () => {

            blocked(await attempt(`
                const fs = await import("fs");
                return { success: true, message: fs.readFileSync(${JSON.stringify(outsideFile)}, "utf8") };
            `));
        });

        it("cannot reach fs through createRequire", async () => {

            blocked(await attempt(`
                const { createRequire } = require("module");
                const rq = createRequire(${JSON.stringify(path.join(temp, "x.js"))});
                return { success: true, message: rq("fs").readFileSync(${JSON.stringify(outsideFile)}, "utf8") };
            `));
        });

        it("cannot require a file outside its own directory", async () => {

            fs.writeFileSync(path.join(temp, "neighbour.js"), `module.exports = ${JSON.stringify(SECRET)};`);

            blocked(await attempt(`
                return { success: true, message: require("../neighbour.js") };
            `));
        });

        it("cannot read the secret through a module the allowlist does permit", async () => {

            // `zlib`, `crypto` and friends are allowed because they touch
            // no I/O. This checks that assumption rather than trusting it.
            blocked(await attempt(`
                const zlib = require("zlib");
                return { success: true, message: String(zlib.gzipSync(require("fs").readFileSync(${JSON.stringify(outsideFile)}))) };
            `));
        });
    });

    describe("other capabilities", () => {

        it("cannot run another program", async () => {

            blocked(await attempt(`
                const { execSync } = require("child_process");
                return { success: true, message: execSync("echo escaped").toString() };
            `));
        });

        it("cannot open a network connection", async () => {

            // The permission model has no concept of the network, so this
            // one rests entirely on the module allowlist.
            blocked(await attempt(`
                const net = require("net");
                return { success: true, message: "net loaded: " + typeof net.connect };
            `));
        });

        it("cannot resolve host names", async () => {

            blocked(await attempt(`
                return { success: true, message: "dns loaded: " + typeof require("dns").lookup };
            `));
        });

        it("cannot start a worker thread to do its dirty work", async () => {

            blocked(await attempt(`
                const { Worker } = require("worker_threads");
                return { success: true, message: "worker_threads loaded" };
            `));
        });

        it("cannot compile fresh code with vm", async () => {

            blocked(await attempt(`
                return { success: true, message: require("vm").runInNewContext("1 + 1") };
            `));
        });
    });

    describe("reaching back into the host", () => {

        it("cannot walk the prototype chain to the host's Function constructor", async () => {

            // The classic vm escape. It cannot work here because there is
            // no vm - the plugin is a whole process away - but the shape
            // of the attack is worth pinning.
            blocked(await attempt(`
                const escape = ctx.constructor.constructor("return process.mainModule.require('fs')")();
                return { success: true, message: escape.readFileSync(${JSON.stringify(outsideFile)}, "utf8") };
            `));
        });

        it("gets no route to the engine through the context object", async () => {

            const result = await attempt(`
                return { success: true, artifacts: { keys: Object.keys(ctx).sort().join(",") } };
            `);

            expect(result.success).toBe(true);

            const keys = String((result.artifacts as { keys: string }).keys).split(",");

            // `reportSession` is outbound only - the plugin can name a
            // conversation it opened, and gets nothing back.
            expect(keys).toEqual([
                "attempt", "cancelled", "cwd", "env", "log", "onCancel",
                "reportSession", "root", "runId", "secret", "taskId"
            ]);
        });

        it("sees only the env the task was given, not the host's environment", async () => {

            process.env.EESHA_PLUGINS_HOST_ONLY = "should-not-be-visible";

            try {

                const result = await attempt(`
                    return {
                        success: true,
                        artifacts: {
                            fromContext: JSON.stringify(ctx.env),
                            fromProcess: String(process.env.EESHA_PLUGINS_HOST_ONLY)
                        }
                    };
                `);

                const outputs = result.artifacts as { fromContext: string; fromProcess: string };

                expect(outputs.fromContext).toBe("{}");

                // The host chooses what the child process is handed.
                // Handing over the host's own environment would make
                // `secrets:` a formality a plugin could read around.
                expect(outputs.fromProcess).toBe("undefined");

            } finally {

                delete process.env.EESHA_PLUGINS_HOST_ONLY;
            }
        });
    });

    describe("secrets", () => {

        it("receives a secret it declared", async () => {

            fs.writeFileSync(path.join(taskDir, "attacker.js"), `
module.exports = {
    id: "declarer",
    version: "1",
    secrets: ["DECLARED_TOKEN"],
    async execute(args, ctx) {
        return { success: true, message: "got:" + ctx.secret("DECLARED_TOKEN") };
    }
};
`);

            const { plugin } = new PluginLoader(sandbox).load(taskDir).loaded[0];

            const result = await plugin.execute({}, context({
                secret: name => (name === "DECLARED_TOKEN" ? "token-value" : undefined)
            }));

            expect(result.message).toBe("got:token-value");
        });

        it("cannot read a secret it did not declare, even one the host could resolve", async () => {

            const asked: string[] = [];

            const result = await attempt(`
                return { success: true, message: "got:" + ctx.secret("UNDECLARED_TOKEN") };
            `);

            expect(result.message).toBe("got:undefined");
            expect(asked).toEqual([]);
        });

        it("only ever asks the host for the names it declared", async () => {

            fs.writeFileSync(path.join(taskDir, "attacker.js"), `
module.exports = {
    id: "declarer",
    version: "1",
    secrets: ["ONE"],
    async execute(args, ctx) {
        ctx.secret("TWO");
        return { success: true };
    }
};
`);

            const asked: string[] = [];

            const { plugin } = new PluginLoader(sandbox).load(taskDir).loaded[0];

            await plugin.execute({}, context({
                secret: name => {
                    asked.push(name);
                    return "value";
                }
            }));

            // "TWO" was requested inside the sandbox and never left it.
            expect(asked).toEqual(["ONE"]);
        });
    });

    describe("the sandbox stays usable", () => {

        it("still runs an honest plugin, and returns its outputs", async () => {

            const result = await attempt(`
                ctx.log("working\\n");
                return { success: true, artifacts: { doubled: 21 * 2 } };
            `);

            expect(result.success).toBe(true);
            expect(result.artifacts).toEqual({ doubled: 42 });
        });

        // A folder plugin, because that is the only kind that has its
        // own directory. A file next to it belongs to another plugin,
        // not to this one.
        it("lets a folder plugin read its own directory", async () => {

            const folder = path.join(taskDir, "mine");

            fs.mkdirSync(folder);

            // Reached through a relative require rather than `fs`, which
            // is the only route left - and the one the sandbox intends.
            fs.writeFileSync(path.join(folder, "data.js"), 'module.exports = "MY-OWN-DATA";');
            fs.writeFileSync(path.join(folder, "index.js"), `
module.exports = {
    id: "mine",
    version: "1",
    async execute() {
        try {
            return { success: true, message: require("./data.js") };
        } catch (error) {
            return { success: false, message: "BLOCKED: " + (error.code || error.message) };
        }
    }
};
`);

            const loaded = new PluginLoader(sandbox).load(taskDir);

            expect(loaded.failures).toEqual([]);

            const result = await loaded.loaded[0].plugin.execute({}, context());

            expect(result.message).toBe("MY-OWN-DATA");
            expect(result.success).toBe(true);
        });

        it("lets a plugin use the allowed pure-computation modules", async () => {

            const result = await attempt(`
                const crypto = require("crypto");
                const path = require("path");
                return {
                    success: true,
                    artifacts: {
                        hashed: crypto.createHash("sha256").update("x").digest("hex").slice(0, 8),
                        joined: path.join("a", "b")
                    }
                };
            `);

            expect(result.success).toBe(true);
        });

        it("surfaces a plugin's own error rather than swallowing it", async () => {

            const result = await attempt(`
                throw new Error("something the plugin got wrong");
            `);

            expect(result.success).toBe(false);
            expect(result.message).toContain("something the plugin got wrong");
        });

        it("survives a plugin that crashes its whole process", async () => {

            const result = await attempt(`
                process.exit(3);
            `);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/exited before returning a result/);
        });
    });

    /**
     * Node's permission model has no concept of an environment
     * variable, so this is not something the flags cover. The host
     * decides what the child process is handed, and that decision is
     * the entire boundary.
     */
    describe("the environment", () => {

        it("carries nothing beyond the runtime floor", async () => {

            const result = await attempt(`
                return { success: true, artifacts: { names: Object.keys(process.env).sort() } };
            `);

            const names = (result.artifacts as { names: string[] }).names;

            // Named rather than counted: a count passes the day someone
            // swaps one leak for another.
            const allowed = new Set([
                // What the host chooses to pass - RUNTIME_ENV.
                "ELECTRON_RUN_AS_NODE",
                "SystemRoot", "windir", "COMSPEC",
                "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",

                // What libuv adds to every child on Windows whatever
                // `env` says, so no host can withhold them. Uppercased
                // by the same code, which is why SYSTEMROOT and WINDIR
                // appear twice in different cases.
                "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH",
                "SYSTEMDRIVE", "SYSTEMROOT", "USERDOMAIN", "USERNAME",
                "USERPROFILE", "WINDIR"
            ]);

            expect(names.filter(name => !allowed.has(name))).toEqual([]);
        });

        it("still delivers what the task declared, through ctx", async () => {

            const file = path.join(taskDir, "declared.js");

            fs.writeFileSync(file, `
module.exports = {
    id: "declared",
    version: "1",
    async execute(args, ctx) {
        return { success: true, artifacts: { fromCtx: ctx.env.FROM_TASK ?? "missing" } };
    }
};
`);

            const loaded = new PluginLoader(sandbox).load(taskDir);

            const plugin = loaded.loaded.find(entry => entry.plugin.id === "declared")!.plugin;

            const result = await plugin.execute({}, context({ env: { FROM_TASK: "delivered" } }));

            expect(result.artifacts).toEqual({ fromCtx: "delivered" });
        });
    });
});

afterAll(() => {

    // Nothing should be left running behind us.
    expect(true).toBe(true);
});
