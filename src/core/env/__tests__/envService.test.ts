import { describe, expect, it } from "vitest";

import { EnvService } from "../envService";

/**
 * The env gate as a service: `allowedValues` shows only what something
 * granted, `resolve` hands over one value or explains why not. The
 * algebra under both is the settings file's - three grants, deny wins.
 */

describe("spawnEnvMasked", () => {

    it("registers every granted value as a secret before returning the env", () => {

        const service = new EnvService({
            env: { PATH: "C:/bin", ANTHROPIC_API_KEY: "sk-x" },
            allowed: ["ANTHROPIC_API_KEY"],
            denied: []
        });

        const registered: string[] = [];

        const env = service.spawnEnvMasked(value => registered.push(value));

        expect(env).toEqual({ PATH: "C:/bin", ANTHROPIC_API_KEY: "sk-x" });
        expect(registered).toEqual(["sk-x"]);
    });

    it("works with no callback, for a caller that does not mask", () => {

        const service = new EnvService({
            env: { PATH: "C:/bin" },
            allowed: [],
            denied: []
        });

        expect(() => service.spawnEnvMasked()).not.toThrow();
    });
});

describe("allowedValues", () => {

    it("returns only granted names", () => {

        const service = new EnvService({
            env: { GRANTED: "yes", SECRET: "no" },
            allowed: ["GRANTED"],
            denied: []
        });

        expect(service.allowedValues()).toEqual({ GRANTED: "yes" });
    });

    it("returns nothing when nothing is granted", () => {

        const service = new EnvService({
            env: { SECRET: "no" },
            allowed: [],
            denied: []
        });

        expect(service.allowedValues()).toEqual({});
    });

    it("includes names granted by the task env and by allowedEnv", () => {

        const service = new EnvService({
            env: { FROM_ARG: "machine" },
            allowed: [],
            denied: [],
            taskEnv: { FROM_TASK: "task" },
            allowedEnv: ["FROM_ARG"]
        });

        expect(service.allowedValues()).toEqual({ FROM_TASK: "task", FROM_ARG: "machine" });
    });

    it("prefers the task's value over the machine's", () => {

        const service = new EnvService({
            env: { NAME: "machine" },
            allowed: ["NAME"],
            denied: [],
            taskEnv: { NAME: "task" }
        });

        expect(service.allowedValues()).toEqual({ NAME: "task" });
    });

    /* The veto a person can rely on: denial beats every grant, including the task's own. */
    it("omits denied names no matter what granted them", () => {

        const service = new EnvService({
            env: { SECRET: "value" },
            allowed: ["SECRET"],
            denied: ["SECRET"],
            taskEnv: { SECRET: "task" },
            allowedEnv: ["SECRET"]
        });

        expect(service.allowedValues()).toEqual({});
    });

    it("omits granted names the environment does not set", () => {

        const service = new EnvService({
            env: {},
            allowed: ["UNSET"],
            denied: []
        });

        expect(service.allowedValues()).toEqual({});
    });

    /* Empty is a value someone chose - "set but empty" and "not set" are different facts. */
    it("keeps set-but-empty values", () => {

        const service = new EnvService({
            env: { EMPTY: "" },
            allowed: ["EMPTY"],
            denied: []
        });

        expect(service.allowedValues()).toEqual({ EMPTY: "" });
    });

    it("never answers from the object prototype", () => {

        const service = new EnvService({
            env: {},
            allowed: ["toString"],
            denied: [],
            taskEnv: {}
        });

        expect(service.allowedValues()).toEqual({});
    });
});

describe("grantValues", () => {

    it("returns the values the grant lists expose", () => {

        const service = new EnvService({
            env: { ADO_PAT: "pat-value", API_KEY: "key-value", UNGRANTED: "hidden" },
            allowed: ["ADO_PAT"],
            denied: [],
            allowedEnv: ["API_KEY"]
        });

        expect(service.grantValues().sort()).toEqual(["key-value", "pat-value"]);
    });

    // The task's own env: block is configuration the workflow file
    // spells out, so masking it would only garble the log.
    it("leaves the task's own env values out", () => {

        const service = new EnvService({
            env: {},
            allowed: [],
            denied: [],
            taskEnv: { NODE_ENV: "production" }
        });

        expect(service.grantValues()).toEqual([]);
    });

    it("omits denied and unset names", () => {

        const service = new EnvService({
            env: { VETOED: "value" },
            allowed: ["VETOED", "NEVER_SET"],
            denied: ["VETOED"]
        });

        expect(service.grantValues()).toEqual([]);
    });

    it("resolves a granted name from the task's value when the task carries it", () => {

        const service = new EnvService({
            env: { TOKEN: "machine" },
            allowed: ["TOKEN"],
            denied: [],
            taskEnv: { TOKEN: "task" }
        });

        expect(service.grantValues()).toEqual(["task"]);
    });

    /* Same rule spawnEnv already enforces - a veto dodged by spelling is not a veto. */
    it("matches denied names case-insensitively", () => {

        const service = new EnvService({
            env: { GITHUB_TOKEN: "hunter2" },
            allowed: ["GITHUB_TOKEN"],
            denied: ["github_token"]
        });

        expect(service.grantValues()).toEqual([]);
    });
});

describe("spawnEnv", () => {

    /* An allowlist: what is neither plumbing nor granted stays behind. */
    it("passes the baseline through and holds everything else back", () => {

        const service = new EnvService({
            env: { PATH: "C:/bin", APPDATA: "C:/appdata", NPM_TOKEN: "secret", ANTHROPIC_API_KEY: "sk-x" },
            allowed: [],
            denied: []
        });

        expect(service.spawnEnv()).toEqual({ PATH: "C:/bin", APPDATA: "C:/appdata" });
    });

    /* Windows spells them `Path` and `ComSpec` - a missed spelling is a dead child. */
    it("matches the baseline case-insensitively, keeping the original spelling", () => {

        const service = new EnvService({
            env: { Path: "C:/bin", ComSpec: "C:/cmd.exe" },
            allowed: [],
            denied: []
        });

        expect(service.spawnEnv()).toEqual({ Path: "C:/bin", ComSpec: "C:/cmd.exe" });
    });

    it("includes names granted by env.allowed and allowedEnv", () => {

        const service = new EnvService({
            env: { PATH: "C:/bin", ANTHROPIC_API_KEY: "sk-x", FROM_ARG: "arg" },
            allowed: ["ANTHROPIC_API_KEY"],
            denied: [],
            allowedEnv: ["FROM_ARG"]
        });

        expect(service.spawnEnv()).toEqual({
            PATH: "C:/bin",
            ANTHROPIC_API_KEY: "sk-x",
            FROM_ARG: "arg"
        });
    });

    it("layers the task's values on top, task winning", () => {

        const service = new EnvService({
            env: { PATH: "C:/bin" },
            allowed: [],
            denied: [],
            taskEnv: { EXTRA: "added", PATH: "task-path" }
        });

        expect(service.spawnEnv()).toEqual({ PATH: "task-path", EXTRA: "added" });
    });

    /* The veto beats the baseline, the grant, and the task alike. */
    it("removes a denied name whatever put it there", () => {

        const service = new EnvService({
            env: { PATH: "C:/bin", GRANTED: "yes" },
            allowed: ["GRANTED"],
            denied: ["GRANTED", "SECRET"],
            taskEnv: { SECRET: "task-says-so" }
        });

        expect(service.spawnEnv()).toEqual({ PATH: "C:/bin" });
    });

    /* A veto that could be dodged by spelling is not a veto. */
    it("matches denied names case-insensitively", () => {

        const service = new EnvService({
            env: { Path: "C:/bin" },
            allowed: [],
            denied: ["PATH"]
        });

        expect(service.spawnEnv()).toEqual({});
    });
});

describe("resolve", () => {

    it("returns a granted value", () => {

        const service = new EnvService({
            env: { GRANTED: "yes" },
            allowed: ["GRANTED"],
            denied: []
        });

        expect(service.resolve("GRANTED")).toBe("yes");
    });

    it("prefers the task's value over the machine's", () => {

        const service = new EnvService({
            env: { NAME: "machine" },
            allowed: [],
            denied: [],
            taskEnv: { NAME: "task" }
        });

        expect(service.resolve("NAME")).toBe("task");
    });

    it("resolves a name granted only by allowedEnv", () => {

        const service = new EnvService({
            env: { FROM_ARG: "value" },
            allowed: [],
            denied: [],
            allowedEnv: ["FROM_ARG"]
        });

        expect(service.resolve("FROM_ARG")).toBe("value");
    });

    it("throws for an ungranted name, saying how to grant it", () => {

        const service = new EnvService({
            env: { SECRET: "value" },
            allowed: [],
            denied: []
        });

        expect(() => service.resolve("SECRET"))
            .toThrowError(/Nothing allows 'SECRET' to be read.*env\.allowed/s);
    });

    /* Same rule as spawnEnv: a veto that could be dodged by spelling is not a veto. */
    it("throws for a denied name spelled differently than the settings entry", () => {

        const service = new EnvService({
            env: { GITHUB_TOKEN: "hunter2" },
            allowed: ["GITHUB_TOKEN"],
            denied: ["github_token"]
        });

        expect(() => service.resolve("GITHUB_TOKEN")).toThrowError(/denied by 'env\.denied'/);
    });

    it("throws for a denied name even when everything grants it", () => {

        const service = new EnvService({
            env: { SECRET: "value" },
            allowed: ["SECRET"],
            denied: ["SECRET"],
            taskEnv: { SECRET: "task" },
            allowedEnv: ["SECRET"]
        });

        expect(() => service.resolve("SECRET")).toThrowError(/denied by 'env\.denied'/);
    });

    it("throws for a granted name the environment does not set", () => {

        const service = new EnvService({
            env: {},
            allowed: ["UNSET"],
            denied: []
        });

        expect(() => service.resolve("UNSET")).toThrowError(/'UNSET' is allowed.*not set/);
    });

    it("returns a set-but-empty value rather than calling it unset", () => {

        const service = new EnvService({
            env: { EMPTY: "" },
            allowed: ["EMPTY"],
            denied: []
        });

        expect(service.resolve("EMPTY")).toBe("");
    });
});
