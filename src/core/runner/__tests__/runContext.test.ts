import * as path from "path";
import { describe, expect, it } from "vitest";
import { TemplateResolver } from "../../templating/TemplateResolver";
import { resolveContext, runStamps, ContextRequest } from "../runContext";

const resolver = new TemplateResolver();

const WORKSPACE = path.resolve("C:/repo");
const ROOT = path.resolve("C:/repo/packages/api");

/** A level with nothing declared, plus whatever the test cares about. */
function request(overrides: Partial<ContextRequest> = {}): ContextRequest {

    return {
        workspace: WORKSPACE,
        root: ROOT,
        inheritedCwd: ROOT,
        vars: {},
        env: {},
        processEnv: {},
        ...overrides
    };
}

/** A fake disk: paths in, contents out, and a record of what was asked for. */
function disk(files: Record<string, string>) {

    const asked: string[] = [];

    return {
        asked,
        read: (file: string) => {

            asked.push(file);

            return files[file];
        }
    };
}

describe("runStamps", () => {

    /* Pinned to a fixed instant, so the formats are checked as literal
     * strings, not re-derived with the same date API they are built from. */
    it("formats one instant six ways", () => {

        const stamps = runStamps("run-42", new Date(2026, 8, 5, 15, 42, 10));

        expect(stamps.dateToday).toBe("2026-09-05");
        expect(stamps.dateNow).toBe("2026-09-05T15:42:10");
        expect(stamps.timestamp).toBe("20260905-154210");
        expect(stamps.dateUtcNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(stamps.runId).toBe("run-42");
        expect(["windows", "macos", "linux"]).toContain(stamps.platform);
    });

    it("pads single-digit fields, so names sort as text", () => {

        const stamps = runStamps("r", new Date(2026, 0, 2, 3, 4, 5));

        expect(stamps.dateToday).toBe("2026-01-02");
        expect(stamps.timestamp).toBe("20260102-030405");
    });

    it("reaches a vars: value through resolveContext, from the one object the run minted", () => {

        const stamps = runStamps("run-9", new Date(2026, 8, 5, 15, 42, 10));

        const level = resolveContext(resolver, request({
            stamps,
            vars: { artifact: "app-${{ dateToday }}-${{ runId }}" }
        }));

        expect(level.vars.artifact).toBe("app-2026-09-05-run-9");
        expect(level.scope.stamps).toBe(stamps);
    });
});

describe("resolveContext", () => {

    describe("cwd", () => {

        it("resolves a declared cwd inside the inherited one", () => {

            const level = resolveContext(resolver, request({ declaredCwd: "./dist" }));

            expect(level.cwd).toBe(path.join(ROOT, "dist"));
        });

        it("stays where it was when the level says none", () => {

            const level = resolveContext(resolver, request({ declaredCwd: "none" }));

            expect(level.cwd).toBe(ROOT);
        });

        it("reads none whatever the casing, so None is never a folder called None", () => {

            const level = resolveContext(resolver, request({ declaredCwd: " None " }));

            expect(level.cwd).toBe(ROOT);
        });

        it("still treats ./none as the folder it looks like", () => {

            const level = resolveContext(resolver, request({ declaredCwd: "./none" }));

            expect(level.cwd).toBe(path.join(ROOT, "none"));
        });
    });

    describe("dotenv", () => {

        it("loads values and exports them", () => {

            const at = disk({ [path.resolve(ROOT, ".env")]: "TOKEN=abc\nPORT=5432" });

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                readEnvFile: at.read
            }));

            expect(level.env).toEqual({ TOKEN: "abc", PORT: "5432" });
        });

        it("resolves a relative path against root, not the inherited cwd", () => {

            const at = disk({});

            resolveContext(resolver, request({
                dotenv: [".env"],
                inheritedCwd: path.resolve(ROOT, "dist"),
                readEnvFile: at.read
            }));

            expect(at.asked).toEqual([path.resolve(ROOT, ".env")]);
        });

        it("templates the path against the anchors and vars", () => {

            const at = disk({});

            resolveContext(resolver, request({
                vars: { flavour: "ci" },
                dotenv: ["${{ workspaceFolder }}/.env.${{ vars.flavour }}"],
                readEnvFile: at.read
            }));

            expect(at.asked).toEqual([path.resolve(WORKSPACE, ".env.ci")]);
        });

        // The layering rule: a file that travels with the machine must not
        // beat a value the workflow states outright.
        it("sits under this level's own env:", () => {

            const at = disk({ [path.resolve(ROOT, ".env")]: "SCOPE=from-file" });

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                env: { SCOPE: "declared" },
                readEnvFile: at.read
            }));

            expect(level.env.SCOPE).toBe("declared");
        });

        it("sits over the real process environment", () => {

            const at = disk({ [path.resolve(ROOT, ".env")]: "SCOPE=from-file" });

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                processEnv: { SCOPE: "from-process" },
                readEnvFile: at.read
            }));

            expect(level.scope.env!.SCOPE).toBe("from-file");
        });

        it("lets a later file win over an earlier one", () => {

            const at = disk({
                [path.resolve(ROOT, ".env")]: "SCOPE=base\nONLY_BASE=1",
                [path.resolve(ROOT, ".env.local")]: "SCOPE=override"
            });

            const level = resolveContext(resolver, request({
                dotenv: [".env", ".env.local"],
                readEnvFile: at.read
            }));

            expect(level.env).toEqual({ SCOPE: "override", ONLY_BASE: "1" });
        });

        it("makes a loaded value readable from a declared env: value", () => {

            const at = disk({ [path.resolve(ROOT, ".env")]: "HOST=db.internal" });

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                env: { CONNECTION: "Server=${{ env.HOST }}" },
                readEnvFile: at.read
            }));

            expect(level.env.CONNECTION).toBe("Server=db.internal");
        });

        // A `.env` is the one file nobody commits, so a shared tasks.yml
        // naming it must still run for someone who has not made one.
        it("skips a missing file rather than failing, and says so", () => {

            const problems: string[] = [];

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                readEnvFile: () => undefined,
                onProblem: message => problems.push(message)
            }));

            expect(level.env).toEqual({});
            expect(problems).toHaveLength(1);
            expect(problems[0]).toMatch(/No dotenv file at .*\.env.*skipping/);
        });

        it("reports a malformed line and keeps the rest of the file", () => {

            const problems: string[] = [];

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                readEnvFile: () => "A=1\nrubbish\nB=2",
                onProblem: message => problems.push(message)
            }));

            expect(level.env).toEqual({ A: "1", B: "2" });
            expect(problems[0]).toMatch(/line 2/);
        });

        it("lets a declared env: value read a run variable", () => {

            const level = resolveContext(resolver, request({
                env: { NOTES: "${{ run.context.NOTES.summary }}" },
                run: { NOTES: { summary: "Fixes `url` handling" } }
            }));

            expect(level.env).toEqual({ NOTES: "Fixes `url` handling" });
        });

        it("does not touch the disk when nothing declares a dotenv", () => {

            const at = disk({});

            resolveContext(resolver, request({ readEnvFile: at.read }));

            expect(at.asked).toEqual([]);
        });

        it("takes a loaded value literally, even one that looks like a template", () => {

            const level = resolveContext(resolver, request({
                dotenv: [".env"],
                readEnvFile: () => "SECRET=${{ env.NOPE }}"
            }));

            expect(level.env.SECRET).toBe("${{ env.NOPE }}");
        });
    });
});
