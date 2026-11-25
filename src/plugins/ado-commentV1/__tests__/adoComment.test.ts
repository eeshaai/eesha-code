import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginContext } from "../../../core/plugins/Plugin";
import manifest from "../plugin.json";
import { execute } from "../index";
import { acquireAzToken } from "../../ado/azToken";
import { PluginManifest, pluginFromManifest } from "../../../core/plugins/PluginManifest";

/**
 * `ado-comment@1` against a stubbed `fetch` - what travels on the wire
 * is the contract here: which endpoint, which verb, which auth header,
 * and which of add/update/unchanged the marker decided. The az CLI is
 * mocked out entirely: `azToken.ts` owns that seam, and these tests
 * own what the plugin does with what it returns.
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

const args = {
    orgUrl: "https://dev.azure.com/contoso",
    project: "Platform",
    workItem: 48120,
    key: "release-status",
    body: "Release passed staging."
};

/** What the plugin writes: the body with the marker riding at the end. */
const expectedText = "Release passed staging.\n\n[eesha:release-status]";

function jsonResponse(value: unknown, status = 200) {

    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => value
    };
}

/** Stubs fetch with one answer per call, in order, and hands back the calls it saw. */
function stubFetch(...answers: ReturnType<typeof jsonResponse>[]) {

    const calls: { url: string; init: RequestInit }[] = [];

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {

        calls.push({ url, init });

        return answers[Math.min(calls.length - 1, answers.length - 1)];
    }));

    return calls;
}

// Braced on purpose: `mockResolvedValue` returns the mock, and a
// function returned from `beforeEach` is registered as teardown - which
// vitest then *calls*, handing the mock a phantom invocation whose
// rejected promise fails whichever test set `mockRejectedValue`.
beforeEach(() => { azToken.mockResolvedValue("entra-token"); });

afterEach(() => {

    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("ado-comment@1", () => {

    it("loads from its manifest with the id and version its reference resolves to", () => {

        const plugin = pluginFromManifest(manifest as PluginManifest, execute as never, "ado-commentV1");

        expect(plugin.id).toBe("ado-comment");
        expect(plugin.version).toBe("1");
        expect(plugin.secretsFrom).toBe("patEnv");
        expect(plugin.artifacts).toEqual(["commentId", "action"]);
    });

    it("adds a comment when no marker is found, carrying the marker in the text", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [{ id: 1, text: "unrelated" }] }),
            jsonResponse({ id: 7, text: expectedText }));

        const result = await execute(args, context().ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts).toEqual({ commentId: 7, action: "added" });

        expect(calls[0].init.method).toBe("GET");
        expect(calls[0].url).toContain("/Platform/_apis/wit/workItems/48120/comments?api-version=");

        expect(calls[1].init.method).toBe("POST");
        expect(JSON.parse(calls[1].init.body as string)).toEqual({ text: expectedText });
    });

    it("updates the marked comment instead of adding a second one", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [{ id: 3, text: "<div>old words [eesha:release-status]</div>" }] }),
            jsonResponse({ id: 3, text: expectedText }));

        const result = await execute(args, context().ctx);

        expect(result.artifacts).toEqual({ commentId: 3, action: "updated" });

        expect(calls[1].init.method).toBe("PATCH");
        expect(calls[1].url).toContain("/comments/3?api-version=");
    });

    it("writes nothing when the marked comment already says exactly this", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [{ id: 3, text: expectedText }] }));

        const result = await execute(args, context().ctx);

        expect(result.artifacts).toEqual({ commentId: 3, action: "unchanged" });
        expect(calls).toHaveLength(1);
    });

    it("keeps different keys apart - another key's marker is not this task's comment", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [{ id: 3, text: "other note [eesha:build-status]" }] }),
            jsonResponse({ id: 8, text: expectedText }));

        const result = await execute(args, context().ctx);

        expect(result.artifacts).toEqual({ commentId: 8, action: "added" });
        expect(calls[1].init.method).toBe("POST");
    });

    it("follows the continuation token when the marked comment sits on a later page", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [{ id: 1, text: "first page" }], continuationToken: "page-2" }),
            jsonResponse({ comments: [{ id: 9, text: "found [eesha:release-status]" }] }),
            jsonResponse({ id: 9, text: expectedText }));

        const result = await execute(args, context().ctx);

        expect(result.artifacts).toEqual({ commentId: 9, action: "updated" });
        expect(calls[1].url).toContain("continuationToken=page-2");
    });

    it("rides the az token as a bearer by default, asking no secret of anyone", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [] }),
            jsonResponse({ id: 1, text: expectedText }));

        const asked: string[] = [];

        const { ctx } = context({
            secret: name => {
                asked.push(name);
                return "pat-value";
            }
        });

        await execute(args, ctx);

        const header = (calls[0].init.headers as Record<string, string>)["Authorization"];

        expect(header).toBe("Bearer entra-token");
        expect(asked).toEqual([]);
    });

    it("fails with the az message when the CLI cannot mint a token", async () => {

        stubFetch();

        azToken.mockRejectedValue(new Error("Could not get a token from az: Please run 'az login'."));

        const result = await execute(args, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("az login");
    });

    it("rides the PAT as basic auth with an empty user name when auth is pat", async () => {

        const calls = stubFetch(
            jsonResponse({ comments: [] }),
            jsonResponse({ id: 1, text: expectedText }));

        await execute({ ...args, auth: "pat" }, context().ctx);

        const header = (calls[0].init.headers as Record<string, string>)["Authorization"];

        expect(header).toBe(`Basic ${Buffer.from(":pat-value").toString("base64")}`);
        expect(azToken).not.toHaveBeenCalled();
    });

    it("reads the PAT from the env var 'patEnv' names", async () => {

        stubFetch(
            jsonResponse({ comments: [] }),
            jsonResponse({ id: 1, text: expectedText }));

        const asked: string[] = [];

        const { ctx } = context({
            secret: name => {
                asked.push(name);
                return "work-pat";
            }
        });

        const result = await execute({ ...args, auth: "pat", patEnv: "ADO_PAT" }, ctx);

        expect(result.success).toBe(true);
        expect(asked).toEqual(["ADO_PAT"]);
    });

    it("fails naming the env var when auth is pat and no PAT is set", async () => {

        stubFetch();

        const { ctx } = context({ secret: () => undefined });

        const result = await execute({ ...args, auth: "pat" }, ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("AZURE_DEVOPS_EXT_PAT");
    });

    it("fails with the status and a pointed hint on a 401", async () => {

        stubFetch(jsonResponse({}, 401));

        const result = await execute(args, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("HTTP 401");
        expect(result.message).toContain("PAT");
    });

    it("refuses args it cannot proceed with, naming the field", async () => {

        stubFetch();

        const { ctx } = context();

        expect((await execute({ ...args, orgUrl: "contoso" }, ctx)).message).toContain("'orgUrl'");
        expect((await execute({ ...args, workItem: 0 }, ctx)).message).toContain("'workItem'");
        expect((await execute({ ...args, key: " " }, ctx)).message).toContain("'key'");
        expect((await execute({ ...args, key: "a]b" }, ctx)).message).toContain("'key'");
        expect((await execute({ ...args, body: "" }, ctx)).message).toContain("'body'");
        expect((await execute({ ...args, auth: "oauth" }, ctx)).message).toContain("'auth'");
    });

    it("defaults auth to az in the manifest, so a bare task never needs a PAT", () => {

        const plugin = pluginFromManifest(manifest as PluginManifest, execute as never, "ado-commentV1");

        expect(plugin.args?.auth.default).toBe("az");
        expect(plugin.args?.auth.options).toEqual(["az", "pat"]);
    });
});
