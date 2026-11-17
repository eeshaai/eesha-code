import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginContext, PluginHandleContext } from "../../../core/plugins/Plugin";
import manifest from "../plugin.json";
import { execute, handle, releaseHostOf } from "../index";
import { acquireAzToken } from "../../ado/azToken";
import { PluginManifest, pluginFromManifest } from "../../../core/plugins/PluginManifest";

/**
 * `ado-release@1` against a stubbed `fetch`: which host, which
 * endpoint, which verb, and what the create body says. The az CLI is
 * mocked out - `ado/azToken.ts` owns that seam.
 */

vi.mock("../../ado/azToken", () => ({ acquireAzToken: vi.fn() }));

const azToken = vi.mocked(acquireAzToken);

function context(overrides: Partial<PluginContext> = {}) {

    const logged: string[] = [];

    const ctx: PluginContext = {
        runId: "run-1",
        taskId: "s#0",
        attempt: 1,
        cwd: "C:/work",
        root: "C:/work",
        env: {},
        secret: name => name === "AZURE_DEVOPS_EXT_PAT" ? "pat-value" : undefined,
        log: text => logged.push(text),
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined,
        ...overrides
    };

    return { ctx, text: () => logged.join("\n") };
}

const where = { orgUrl: "https://dev.azure.com/contoso", project: "Platform" };

function jsonResponse(value: unknown, status = 200) {

    return { ok: status >= 200 && status < 300, status, json: async () => value };
}

/** Stubs fetch, answering by URL substring so parallel calls land right, and hands back what it saw. */
function stubFetch(routes: [string, ReturnType<typeof jsonResponse>][]) {

    const calls: { url: string; init: RequestInit }[] = [];

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {

        calls.push({ url, init });

        const hit = routes.find(([needle]) => url.includes(needle));

        return hit ? hit[1] : jsonResponse({ message: `no route for ${url}` }, 404);
    }));

    return calls;
}

const DEFINITION = {
    id: 12,
    name: "Web",
    environments: [{ id: 200, name: "Prod", rank: 2 }, { id: 100, name: "UAT", rank: 1 }],
    artifacts: [{ alias: "_web-ci" }]
};

const VERSIONS = {
    artifactVersions: [{
        alias: "_web-ci",
        defaultVersion: { id: "4821", name: "20260909.3" },
        versions: [{ id: "4821", name: "20260909.3" }, { id: "4790", name: "20260908.1" }]
    }]
};

beforeEach(() => { azToken.mockResolvedValue("entra-token"); });

afterEach(() => {

    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("ado-release@1", () => {

    it("loads from its manifest, with a tab and the two page handlers", () => {

        const plugin = pluginFromManifest(manifest as PluginManifest, execute as never, "ado-releaseV1", handle as never);

        expect(plugin.id).toBe("ado-release");
        expect(plugin.version).toBe("1");
        expect(plugin.secretsFrom).toBe("patEnv");
        expect(plugin.ui).toEqual({ label: "ADO releases", entry: "ui/index.html", surface: "run" });
        expect(plugin.handle).toBeDefined();
    });

    describe("the release host", () => {

        it("is vsrm for dev.azure.com and for the old visualstudio.com form", () => {

            expect(releaseHostOf("https://dev.azure.com/contoso/")).toBe("https://vsrm.dev.azure.com/contoso");
            expect(releaseHostOf("https://contoso.visualstudio.com")).toBe("https://contoso.vsrm.visualstudio.com");
            expect(releaseHostOf("https://vsrm.dev.azure.com/contoso")).toBe("https://vsrm.dev.azure.com/contoso");
        });
    });

    it("lists definitions from the release host with the az token", async () => {

        const calls = stubFetch([["/definitions?", jsonResponse({ value: [{ id: 12, name: "Web", path: "\\" }, { id: 15, name: "Api", path: "\\Back" }] })]]);

        const result = await execute({ ...where, operation: "definitions" }, context().ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts).toEqual({
            definitions: [{ id: 12, name: "Web", path: "\\" }, { id: 15, name: "Api", path: "\\Back" }]
        });

        expect(calls[0].url).toBe("https://vsrm.dev.azure.com/contoso/Platform/_apis/release/definitions?api-version=7.1");
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer entra-token");
    });

    it("lists a definition's builds per artifact and its stages in rank order", async () => {

        stubFetch([
            ["/definitions/12?", jsonResponse(DEFINITION)],
            ["/artifacts/versions?definitionId=12", jsonResponse(VERSIONS)]
        ]);

        const result = await execute({ ...where, operation: "versions", definition: 12 }, context().ctx);

        expect(result.artifacts).toEqual({
            versions: [{
                alias: "_web-ci",
                default: { id: "4821", name: "20260909.3" },
                versions: [{ id: "4821", name: "20260909.3" }, { id: "4790", name: "20260908.1" }]
            }],
            environments: [{ id: 100, name: "UAT" }, { id: 200, name: "Prod" }]
        });
    });

    describe("create", () => {

        it("pins the named build, takes the default for the rest, and holds the named stages", async () => {

            const calls = stubFetch([
                ["/definitions/12?", jsonResponse(DEFINITION)],
                ["/artifacts/versions?definitionId=12", jsonResponse(VERSIONS)],
                ["/releases?", jsonResponse({ id: 900, name: "Release-41", environments: [{ id: 1, name: "UAT", status: "notStarted" }, { id: 2, name: "Prod", status: "notStarted" }] })]
            ]);

            const result = await execute(
                { ...where, operation: "create", definition: 12, pin: { "_web-ci": "4790" }, hold: ["UAT"], description: "nightly drop" },
                context().ctx);

            expect(result.success).toBe(true);
            expect(result.artifacts).toEqual({
                releaseId: 900,
                name: "Release-41",
                environments: { UAT: { id: 1, status: "notStarted" }, Prod: { id: 2, status: "notStarted" } }
            });

            const create = calls.find(call => call.init.method === "POST")!;

            expect(create.url).toBe("https://vsrm.dev.azure.com/contoso/Platform/_apis/release/releases?api-version=7.1");
            expect(JSON.parse(create.init.body as string)).toEqual({
                definitionId: 12,
                description: "nightly drop",
                isDraft: false,
                reason: "manual",
                artifacts: [{ alias: "_web-ci", instanceReference: { id: "4790", name: "20260908.1" } }],
                manualEnvironments: ["UAT"]
            });
        });

        it("accepts a pin by build name too, and takes the default when nothing is pinned", async () => {

            const calls = stubFetch([
                ["/definitions/12?", jsonResponse(DEFINITION)],
                ["/artifacts/versions?definitionId=12", jsonResponse(VERSIONS)],
                ["/releases?", jsonResponse({ id: 901, name: "Release-42", environments: [] })]
            ]);

            await execute({ ...where, operation: "create", definition: 12, pin: { "_web-ci": "20260908.1" } }, context().ctx);
            await execute({ ...where, operation: "create", definition: 12 }, context().ctx);

            const bodies = calls.filter(call => call.init.method === "POST").map(call => JSON.parse(call.init.body as string));

            expect(bodies[0].artifacts[0].instanceReference).toEqual({ id: "4790", name: "20260908.1" });
            expect(bodies[1].artifacts[0].instanceReference).toEqual({ id: "4821", name: "20260909.3" });
            expect(bodies[1].manualEnvironments).toEqual([]);
        });

        it("refuses a pin naming an artifact or build the definition does not have, before creating anything", async () => {

            const calls = stubFetch([
                ["/definitions/12?", jsonResponse(DEFINITION)],
                ["/artifacts/versions?definitionId=12", jsonResponse(VERSIONS)]
            ]);

            const wrongAlias = await execute({ ...where, operation: "create", definition: 12, pin: { api: "1" } }, context().ctx);

            expect(wrongAlias.success).toBe(false);
            expect(wrongAlias.message).toMatch(/'pin' names artifact 'api', which definition 12 does not have\. It has: _web-ci/);

            const wrongBuild = await execute({ ...where, operation: "create", definition: 12, pin: { "_web-ci": "9" } }, context().ctx);

            expect(wrongBuild.message).toMatch(/has no version '9'\. It has: 20260909\.3 \(4821\), 20260908\.1 \(4790\)/);

            const wrongStage = await execute({ ...where, operation: "create", definition: 12, hold: ["Stage9"] }, context().ctx);

            expect(wrongStage.message).toMatch(/'hold' names stage 'Stage9', which definition 12 does not have\. It has: UAT, Prod/);

            expect(calls.some(call => call.init.method === "POST")).toBe(false);
        });
    });

    describe("promote", () => {

        it("finds the stage by name on the release and starts it", async () => {

            const calls = stubFetch([
                ["/releases/900?", jsonResponse({ id: 900, name: "Release-41", environments: [{ id: 1, name: "UAT" }, { id: 2, name: "Prod" }] })],
                ["/releases/900/environments/1?", jsonResponse({ id: 1, name: "UAT", status: "inProgress" })]
            ]);

            const result = await execute({ ...where, operation: "promote", release: 900, stage: "UAT" }, context().ctx);

            expect(result.artifacts).toEqual({ releaseId: 900, stage: "UAT", status: "inProgress" });

            const patch = calls.find(call => call.init.method === "PATCH")!;

            expect(patch.url).toBe("https://vsrm.dev.azure.com/contoso/Platform/_apis/release/releases/900/environments/1?api-version=7.1");
            expect(JSON.parse(patch.init.body as string)).toEqual({ status: "inProgress" });
        });

        it("fails naming the stages the release does have", async () => {

            stubFetch([["/releases/900?", jsonResponse({ id: 900, name: "R", environments: [{ id: 1, name: "UAT" }] })]]);

            const result = await execute({ ...where, operation: "promote", release: 900, stage: "Prod" }, context().ctx);

            expect(result.success).toBe(false);
            expect(result.message).toBe("Release 900 has no stage 'Prod'. It has: UAT.");
        });
    });

    describe("args", () => {

        it("names the missing field per operation", async () => {

            const { ctx } = context();

            expect((await execute({ ...where, operation: "versions" } as never, ctx)).message).toMatch(/'definition' must be a release definition id for 'versions'/);
            expect((await execute({ ...where, operation: "promote", release: 1 } as never, ctx)).message).toMatch(/'stage' must name the stage/);
            expect((await execute({ ...where, operation: "deploy" } as never, ctx)).message).toMatch(/'operation' must be one of definitions, versions, create, promote/);
            expect((await execute({ ...where, operation: "definitions", auth: "oauth" } as never, ctx)).message).toMatch(/'auth' must be 'az' or 'pat'/);
        });

        it("uses basic auth with the PAT under auth: pat", async () => {

            const calls = stubFetch([["/definitions?", jsonResponse({ value: [] })]]);

            await execute({ ...where, operation: "definitions", auth: "pat" }, context().ctx);

            expect((calls[0].init.headers as Record<string, string>).Authorization)
                .toBe(`Basic ${Buffer.from(":pat-value").toString("base64")}`);
            expect(azToken).not.toHaveBeenCalled();
        });

        it("names the HTTP status and the likely cause on a refused call", async () => {

            stubFetch([["/definitions?", jsonResponse({}, 401)]]);

            const result = await execute({ ...where, operation: "definitions" }, context().ctx);

            expect(result.message).toMatch(/Could not list release definitions: HTTP 401\. An expired 'az login'/);
        });
    });

    describe("the page's handle", () => {

        const pageContext: PluginHandleContext = {
            cwd: "C:/work",
            root: "C:/work",
            env: {},
            secret: () => undefined,
            log: () => undefined
        };

        it("answers definitions and versions with the org and project from the payload", async () => {

            stubFetch([
                ["/definitions?", jsonResponse({ value: [{ id: 12, name: "Web" }] })],
                ["/definitions/12?", jsonResponse(DEFINITION)],
                ["/artifacts/versions?definitionId=12", jsonResponse(VERSIONS)]
            ]);

            expect(await handle({ name: "definitions", payload: where }, pageContext))
                .toEqual([{ id: 12, name: "Web", path: "\\" }]);

            const versions = await handle({ name: "versions", payload: { ...where, definition: 12 } }, pageContext) as { environments: unknown };

            expect(versions.environments).toEqual([{ id: 100, name: "UAT" }, { id: 200, name: "Prod" }]);
        });

        it("refuses anything else, and a payload with no org", async () => {

            await expect(handle({ name: "create", payload: where }, pageContext)).rejects.toThrow(/no handler named 'create'/);
            await expect(handle({ name: "definitions", payload: {} }, pageContext)).rejects.toThrow(/'orgUrl' must be/);
        });
    });
});
