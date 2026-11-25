import { describe, expect, it } from "vitest";
import { TemplateResolver, TemplateResolutionError, TemplateScope } from "../TemplateResolver";

const resolver = new TemplateResolver();

/** A scope with everything available, unless a test narrows it. */
function scope(overrides: Partial<TemplateScope> = {}): TemplateScope {

    return {
        workspaceFolder: "C:/repo",
        workspaceConfig: "C:/repo/.eesha",
        cwd: "C:/repo/packages/api/dist",
        home: "C:/Users/dev",
        env: {},
        vars: {},
        run: {},
        ...overrides
    };
}

const STAMPS = {
    dateToday: "2026-09-05",
    dateNow: "2026-09-05T15:42:10",
    dateUtcNow: "2026-09-05T10:12:10Z",
    timestamp: "20260905-154210",
    runId: "run-7",
    platform: "windows"
};

describe("TemplateResolver", () => {

    describe("run stamps", () => {

        it("resolves each bare, like an anchor", () => {

            expect(resolver.resolve(
                "${{ dateToday }}|${{ dateNow }}|${{ dateUtcNow }}|${{ timestamp }}|${{ runId }}|${{ platform }}",
                scope({ stamps: STAMPS })))
                .toBe("2026-09-05|2026-09-05T15:42:10|2026-09-05T10:12:10Z|20260905-154210|run-7|windows");
        });

        it("is readable from a vars: value - stamps are known before vars resolve", () => {

            expect(resolver.resolveVars(
                { artifact: "app-${{ dateToday }}" },
                scope({ stamps: STAMPS })))
                .toEqual({ artifact: "app-2026-09-05" });
        });

        it("says when they come to exist, where no run has stamped them", () => {

            expect(() => resolver.resolve("${{ dateToday }}", scope({ stamps: undefined })))
                .toThrow(/stamped when a run starts/);
        });

        it("still refuses a name that is not a stamp", () => {

            expect(() => resolver.resolve("${{ dateTodayy }}", scope({ stamps: STAMPS })))
                .toThrow(/not a thing.*dateToday/s);
        });
    });

    describe("the four directory anchors", () => {

        it("resolves each to its own directory", () => {

            expect(resolver.resolve("${{ workspaceFolder }}|${{ workspaceConfig }}|${{ cwd }}|${{ home }}", scope()))
                .toBe("C:/repo|C:/repo/.eesha|C:/repo/packages/api/dist|C:/Users/dev");
        });

        // In a monorepo the anchors and the working directory differ, and
        // a file in packages/api needs its own cwd as well as the repo.
        it("keeps workspaceConfig distinct from workspaceFolder", () => {

            expect(resolver.resolve("${{ workspaceConfig }}/scripts", scope()))
                .not.toBe(resolver.resolve("${{ workspaceFolder }}/scripts", scope()));
        });

        it("resolves home to the person's directory, outside the repository", () => {

            expect(resolver.resolve("${{ home }}/ai-notes/style.md", scope()))
                .toBe("C:/Users/dev/ai-notes/style.md");
        });

        it("names home among what is available when an expression is not a thing", () => {

            expect(() => resolver.resolve("${{ hoem }}", scope()))
                .toThrow(/home/);
        });
    });

    describe("resolve", () => {

        it("resolves ${{ env.NAME }} from the given env map", () => {

            expect(resolver.resolve("${{ env.SCRIPTS_DIR }}", scope({ env: { SCRIPTS_DIR: "C:/s" } })))
                .toBe("C:/s");
        });

        it("resolves ${{ vars.NAME }}", () => {

            expect(resolver.resolve("v${{ vars.version }}", scope({ vars: { version: "1.4.0" } })))
                .toBe("v1.4.0");
        });

        it("resolves ${{ run.context.NAME }} and ${{ run.context.NAME.key }}", () => {

            const at = scope({ run: { SIGNED: "sha256:9f", PR: { number: 12 } } });

            expect(resolver.resolve("${{ run.context.SIGNED }}", at)).toBe("sha256:9f");
            expect(resolver.resolve("#${{ run.context.PR.number }}", at)).toBe("#12");
        });

        it("refuses the flat ${{ run.NAME }} spelling, and says what is available", () => {

            expect(() => resolver.resolve("${{ run.SIGNED }}", scope({ run: { SIGNED: "sha256:9f" } })))
                .toThrow(/'run' is not a thing.*run\.context\.NAME/);
        });

        // A path reads as deep as the value goes: dotted keys, `[n]`
        // into a list, `["odd.key"]` for a key holding a dot. It never
        // computes anything - see EXPRESSION in the resolver.
        it("walks a path of any depth into vars and run.context", () => {

            const at = scope({
                vars: { a: { b: { c: 1 } } },
                run: { RESP: { json: { items: [{ id: 7 }, { id: 9 }], "odd.key": "dotted" } } }
            });

            expect(resolver.resolve("${{ vars.a.b.c }}", at)).toBe("1");
            expect(resolver.resolve("${{ run.context.RESP.json.items[1].id }}", at)).toBe("9");
            expect(resolver.resolve("${{ run.context.RESP.json[\"odd.key\"] }}", at)).toBe("dotted");
            expect(resolver.resolveValue("${{ run.context.RESP.json.items }}", at)).toEqual([{ id: 7 }, { id: 9 }]);
        });

        it("resolves a null at the end of a path to nothing, like any absent value", () => {

            expect(resolver.resolve("[${{ run.context.RESP.json.owner }}]", scope({ run: { RESP: { json: { owner: null } } } })))
                .toBe("[]");
        });

        it("fails a path that misses, naming the deepest node that resolved", () => {

            const at = scope({ run: { PR: { number: 12, labels: ["a"] } } });

            expect(() => resolver.resolve("${{ run.context.PR.number.digits }}", at))
                .toThrow(/'run\.context\.PR\.number' is a number, so there is no 'digits' under it/);

            expect(() => resolver.resolve("${{ run.context.PR.nope }}", at))
                .toThrow(/'run\.context\.PR' has no 'nope'\. It has: number, labels/);

            expect(() => resolver.resolve("${{ run.context.PR.labels[3] }}", at))
                .toThrow(/'run\.context\.PR\.labels' is a list of 1, so \[3\] is out of range/);

            expect(() => resolver.resolve("${{ run.context.PR.labels.first }}", at))
                .toThrow(/is a list of 1, so it is read by position/);
        });

        it("keeps env flat - nothing sits under a name", () => {

            expect(() => resolver.resolve("${{ env.HOME.x }}", scope({ env: { HOME: "C:/u" } })))
                .toThrow(/env vars are flat text/);
        });

        it("passes through text with no template expressions", () => {

            expect(resolver.resolve("echo hello", scope())).toBe("echo hello");
        });

        it("resolves multiple expressions in one string", () => {

            expect(resolver.resolve("${{ workspaceConfig }}/${{ env.SUBDIR }}", scope({ env: { SUBDIR: "dist" } })))
                .toBe("C:/repo/.eesha/dist");
        });

        it("stringifies a non-string var when it is interpolated into text", () => {

            expect(resolver.resolve("retries=${{ vars.retries }}", scope({ vars: { retries: 3 } })))
                .toBe("retries=3");
        });

        it("throws for an unknown env var reference", () => {

            expect(() => resolver.resolve("${{ env.DOES_NOT_EXIST }}", scope()))
                .toThrow(TemplateResolutionError);
        });

        it("throws for an unrecognized built-in, listing what is available", () => {

            expect(() => resolver.resolve("${{ workflow.root }}", scope()))
                .toThrow(/workflow.*Available.*workspaceFolder, workspaceConfig, cwd, home/s);
        });

        it("includes the offending expression and source text in the error message", () => {

            expect(() => resolver.resolve("${{ env.SCRPITS_DIR }}/db-reset.ps1", scope()))
                .toThrow(/env\.SCRPITS_DIR.*db-reset\.ps1/s);
        });
    });

    // The rule that lets a plugin input schema check a real number.
    describe("resolveValue - typed passthrough", () => {

        it("keeps the type when the whole value is one expression", () => {

            expect(resolver.resolveValue("${{ vars.retries }}", scope({ vars: { retries: 3 } })))
                .toBe(3);

            expect(resolver.resolveValue("${{ vars.enabled }}", scope({ vars: { enabled: false } })))
                .toBe(false);

            expect(resolver.resolveValue("${{ vars.args }}", scope({ vars: { args: ["-c", "Release"] } })))
                .toEqual(["-c", "Release"]);
        });

        it("stringifies when the expression is part of a larger string", () => {

            expect(resolver.resolveValue("v${{ vars.version }}", scope({ vars: { version: 2 } })))
                .toBe("v2");
        });

        it("recurses into lists and maps", () => {

            const resolved = resolver.resolveValue(
                { args: ["--tag", "${{ vars.tag }}"], nested: { dir: "${{ workspaceConfig }}" } },
                scope({ vars: { tag: "v1" } }));

            expect(resolved).toEqual({
                args: ["--tag", "v1"],
                nested: { dir: "C:/repo/.eesha" }
            });
        });

        it("leaves non-string leaves exactly as they are", () => {

            expect(resolver.resolveValue({ retries: 3, on: true, none: null }, scope()))
                .toEqual({ retries: 3, on: true, none: null });
        });
    });

    describe("resolveVars", () => {

        it("resolves a var against the directory anchors", () => {

            expect(resolver.resolveVars({ scripts: "${{ workspaceConfig }}/scripts" }, scope()))
                .toEqual({ scripts: "C:/repo/.eesha/scripts" });
        });

        it("resolves a var that references a sibling, in either declaration order", () => {

            expect(resolver.resolveVars(
                { full: "${{ vars.base }}/dist", base: "${{ workspaceConfig }}/out" },
                scope()
            )).toEqual({
                base: "C:/repo/.eesha/out",
                full: "C:/repo/.eesha/out/dist"
            });
        });

        it("keeps a non-string var untouched", () => {

            expect(resolver.resolveVars({ retries: 3, tags: ["a", "b"] }, scope()))
                .toEqual({ retries: 3, tags: ["a", "b"] });
        });

        // The one-directional rule. Without the specific message this reads
        // as "unknown variable" for something declared three lines below.
        it("refuses to read env, and says why", () => {

            expect(() => resolver.resolveVars({ home: "${{ env.HOME }}" }, scope()))
                .toThrow(/env is not available here.*resolved after vars/s);
        });

        it("refuses to read run variables, and says why", () => {

            expect(() => resolver.resolveVars({ x: "${{ run.context.SIGNED }}" }, scope()))
                .toThrow(/produced by tasks as they finish/);
        });
    });

    describe("settings variables", () => {

        const VARIABLES = { Team: { Name: "Payments", Repos: ["api", "web"] }, CurrentUser: "octocat" };

        it("reads a top-level name bare, and a path into it", () => {

            expect(resolver.resolve("${{ CurrentUser }}@${{ Team.Name }}", scope({ variables: VARIABLES })))
                .toBe("octocat@Payments");

            expect(resolver.resolve("${{ Team.Repos[1] }}", scope({ variables: VARIABLES })))
                .toBe("web");
        });

        it("keeps the type when the whole value is one variable", () => {

            expect(resolver.resolveValue("${{ Team }}", scope({ variables: VARIABLES })))
                .toEqual({ Name: "Payments", Repos: ["api", "web"] });
        });

        it("is readable from vars: and env:", () => {

            const with_ = scope({ variables: VARIABLES });

            expect(resolver.resolveVars({ dir: "${{ home }}/${{ Team.Name }}" }, with_))
                .toEqual({ dir: "C:/Users/dev/Payments" });

            expect(resolver.resolveEnv({ TEAM: "${{ Team.Name }}" }, with_))
                .toEqual({ TEAM: "Payments" });
        });

        it("names the variables among what is available when a name misses", () => {

            expect(() => resolver.resolve("${{ Tean.Name }}", scope({ variables: VARIABLES })))
                .toThrow(/'Tean' is not a thing\. Available: .*Team, CurrentUser/);
        });

        it("says how far a path got when it misses under a variable", () => {

            expect(() => resolver.resolve("${{ Team.Nmae }}", scope({ variables: VARIABLES })))
                .toThrow(/'Team' has no 'Nmae'\. It has: Name, Repos/);
        });

        it("lets a loop variable of the same name win inside its task", () => {

            expect(resolver.resolve("${{ Team }}", scope({ variables: VARIABLES, items: { Team: "loop" } })))
                .toBe("loop");
        });
    });

    describe("resolveVariables", () => {

        it("settles the block against the anchors, env and itself, in any order", () => {

            expect(resolver.resolveVariables({
                Repo: "${{ home }}/src/${{ Team.Name }}",
                Team: { Name: "${{ env.TEAM }}", Owner: "${{ CurrentUser }}" },
                CurrentUser: "octocat"
            }, scope({ env: { TEAM: "Payments" } }))).toEqual({
                Repo: "C:/Users/dev/src/Payments",
                Team: { Name: "Payments", Owner: "octocat" },
                CurrentUser: "octocat"
            });
        });

        it("refuses vars, params and run - none exist when settings are read", () => {

            for (const expression of ["vars.x", "params.x", "run.context.x"])
                expect(() => resolver.resolveVariables({ A: `\${{ ${expression} }}` }, scope({ params: { x: "1" } })))
                    .toThrow(TemplateResolutionError);
        });

        it("fails on two variables that read each other, naming the read as written", () => {

            expect(() => resolver.resolveVariables({ A: "${{ B }}", B: "${{ A }}" }, scope()))
                .toThrow(/Cannot resolve '\$\{\{ B \}\}' in 'A'.*reads a variable that reads it back/s);
        });
    });

    describe("resolveEnv", () => {

        it("resolves each value independently against the anchors", () => {

            expect(resolver.resolveEnv(
                { SCRIPTS_DIR: "${{ workspaceConfig }}/scripts", DIST_DIR: "${{ workspaceConfig }}/dist" },
                scope()
            )).toEqual({
                SCRIPTS_DIR: "C:/repo/.eesha/scripts",
                DIST_DIR: "C:/repo/.eesha/dist"
            });
        });

        it("resolves a value that references a sibling key, regardless of declaration order", () => {

            const result = resolver.resolveEnv(
                { BUILD_DIR: "${{ env.SCRIPTS_DIR }}/build", SCRIPTS_DIR: "${{ workspaceConfig }}/scripts" },
                scope()
            );

            expect(result.SCRIPTS_DIR).toBe("C:/repo/.eesha/scripts");
            expect(result.BUILD_DIR).toBe("C:/repo/.eesha/scripts/build");
        });

        it("reads vars, which are resolved before it", () => {

            expect(resolver.resolveEnv(
                { BUILD_CONFIGURATION: "${{ vars.config }}" },
                scope({ vars: { config: "Release" } })
            )).toEqual({ BUILD_CONFIGURATION: "Release" });
        });

        it("sees the process environment, so ${{ env.PATH }} does not have to be redeclared", () => {

            expect(resolver.resolveEnv(
                { TOOLS: "${{ env.PATH }}/tools" },
                scope({ env: { PATH: "C:/bin" } })
            )).toEqual({ TOOLS: "C:/bin/tools" });
        });

        it("lets a declared value win over the process environment of the same name", () => {

            expect(resolver.resolveEnv(
                { PATH: "C:/mine", TOOLS: "${{ env.PATH }}" },
                scope({ env: { PATH: "C:/from-process" } })
            )).toEqual({ PATH: "C:/mine", TOOLS: "C:/mine" });
        });

        it("stringifies a typed var, because a process environment holds only strings", () => {

            expect(resolver.resolveEnv(
                { RETRIES: "${{ vars.retries }}" },
                scope({ vars: { retries: 3 } })
            )).toEqual({ RETRIES: "3" });
        });

        it("throws once no further progress can be made resolving a bad reference", () => {

            expect(() => resolver.resolveEnv({ A: "${{ env.DOES_NOT_EXIST }}" }, scope()))
                .toThrow(TemplateResolutionError);
        });

        // The environment is the one way into a process that needs no
        // quoting, so it has to be able to carry what a model wrote.
        it("reads run variables, which exist by the time a task's env is resolved", () => {

            expect(resolver.resolveEnv(
                { NOTES: "${{ run.context.NOTES.summary }}" },
                scope({ run: { NOTES: { summary: "Fixes `url` handling; costs $0" } } })
            )).toEqual({ NOTES: "Fixes `url` handling; costs $0" });
        });

        it("names a run variable nothing produced", () => {

            expect(() => resolver.resolveEnv({ NOTES: "${{ run.context.NOPE }}" }, scope({ run: {} })))
                .toThrow(/no run variable named 'NOPE'/);
        });

        it("leaves plain values untouched", () => {

            expect(resolver.resolveEnv({ BUILD_CONFIGURATION: "Release" }, scope()))
                .toEqual({ BUILD_CONFIGURATION: "Release" });
        });
    });

    /**
     * Params sit with the anchors rather than with vars and env: they are
     * answered before the run starts, so unlike every other namespace
     * there is no level too early to read one.
     */
    describe("params", () => {

        it("resolves a declared param", () => {

            expect(resolver.resolve("AB#${{ params.work_item }}", scope({ params: { work_item: "48213" } })))
                .toBe("AB#48213");
        });

        // A list or map param is read by path like anything else, and
        // a whole-value expression hands the list over as a list - what
        // a `foreach:` runs on.
        it("reads into a list or map param by path", () => {

            const at = scope({ params: { labs: ["uat", "perf"], pins: { web: 12 } } });

            expect(resolver.resolveValue("${{ params.labs }}", at)).toEqual(["uat", "perf"]);
            expect(resolver.resolve("${{ params.labs[1] }}", at)).toBe("perf");
            expect(resolver.resolve("${{ params.pins.web }}", at)).toBe("12");
            expect(resolver.resolve("${{ params.labs }}", at)).toBe("[\"uat\",\"perf\"]");
        });

        it("is readable from vars, which resolve first", () => {

            expect(resolver.resolveVars(
                { spec: "${{ params.spec_root }}/thing" },
                scope({ params: { spec_root: "eesha-code/specs" } })
            )).toEqual({ spec: "eesha-code/specs/thing" });
        });

        it("is readable from env", () => {

            expect(resolver.resolveEnv(
                { ITEM: "${{ params.work_item }}" },
                scope({ params: { work_item: "48213" } })
            )).toEqual({ ITEM: "48213" });
        });

        it("throws on a param the file never declared, naming the block", () => {

            expect(() => resolver.resolve("${{ params.nope }}", scope({ params: { work_item: "1" } })))
                .toThrow(/declares no param named 'nope'/);
        });

        // tasks.yml has no `params:` at all, so the error should say the
        // namespace is unavailable rather than blame the name.
        it("says params are unavailable when there is no params block", () => {

            expect(() => resolver.resolve("${{ params.work_item }}", scope({ params: undefined })))
                .toThrow(/params are not available here/);
        });

        it("does not reach into Object.prototype", () => {

            expect(() => resolver.resolve("${{ params.constructor }}", scope({ params: {} })))
                .toThrow(TemplateResolutionError);
        });
    });
});
