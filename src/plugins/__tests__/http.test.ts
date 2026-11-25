import * as http from "http";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginContext } from "../../core/plugins/Plugin";
import { execute } from "../httpV1";

/**
 * `http@1` against a real loopback server - the request that is sent
 * and the artifacts that come back, with no network beyond 127.0.0.1.
 *
 * The contracts worth pinning: auth arrives only via `authEnv` (through
 * `ctx.secret`, never a header literal), a body defaults its
 * Content-Type, a non-2xx answer fails the task unless the file says it
 * is data, and the artifacts always carry what a later `if:` reads.
 */

interface Seen {

    method?: string;

    url?: string;

    body?: string;

    headers?: http.IncomingHttpHeaders;
}

let server: http.Server;
let base: string;
const seen: Seen = {};

beforeAll(async () => {

    server = http.createServer((request, response) => {

        seen.method = request.method;
        seen.url = request.url;
        seen.headers = request.headers;

        let body = "";

        request.on("data", chunk => { body += chunk; });

        request.on("end", () => {

            seen.body = body;

            if (request.url === "/hang")
                return; // Never answered - the timeout test's endpoint.

            if (request.url === "/broken") {

                response.writeHead(500, { "Content-Type": "text/plain" });
                response.end("boom");
                return;
            }

            response.writeHead(200, {
                "Content-Type": "application/json",
                "X-Answer": "42",
                // What an auth proxy or a cookied framework answers
                // with - must never reach the run record.
                "Set-Cookie": "session=top-secret; HttpOnly"
            });
            response.end(JSON.stringify({ ok: true }));
        });
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {

    server.closeAllConnections();
    server.close();
});

function context(secrets: Record<string, string> = {}) {

    const logs: string[] = [];

    const ctx: PluginContext = {
        runId: "run-1",
        taskId: "call/http/0",
        attempt: 1,
        cwd: process.cwd(),
        root: process.cwd(),
        env: {},
        secret: name => secrets[name],
        log: text => logs.push(text),
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined
    };

    return { ctx, logs };
}

describe("http@1", () => {

    it("GETs and stores status, body and headers", async () => {

        const { ctx, logs } = context();

        const result = await execute({ url: `${base}/config` }, ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts?.status).toBe(200);
        expect(result.artifacts?.body).toBe('{"ok":true}');
        expect((result.artifacts?.headers as Record<string, string>)["x-answer"]).toBe("42");
        expect(logs.join("\n")).toContain("-> 200");
    });

    it("never stores credential-bearing response headers", async () => {

        const result = await execute({ url: `${base}/config` }, context().ctx);

        const headers = result.artifacts?.headers as Record<string, string>;

        // Node's fetch hands Set-Cookie through headers.entries(),
        // unlike a browser's - storing it would put a session token
        // into a record every later task can template back out.
        expect(headers["set-cookie"]).toBeUndefined();
        expect(JSON.stringify(result.artifacts)).not.toContain("top-secret");
    });

    it("POSTs the body with a defaulted JSON content type", async () => {

        const result = await execute(
            { url: `${base}/webhook`, method: "POST", body: '{"event":"done"}' },
            context().ctx);

        expect(result.success).toBe(true);
        expect(seen.method).toBe("POST");
        expect(seen.body).toBe('{"event":"done"}');
        expect(seen.headers?.["content-type"]).toBe("application/json");
    });

    it("sends the Authorization value authEnv names, via ctx.secret", async () => {

        const result = await execute(
            { url: `${base}/private`, authEnv: "SERVICE_TOKEN" },
            context({ SERVICE_TOKEN: "Bearer sesame" }).ctx);

        expect(result.success).toBe(true);
        expect(seen.headers?.authorization).toBe("Bearer sesame");
    });

    it("fails with the missing env var named when authEnv resolves nothing", async () => {

        const result = await execute({ url: `${base}/private`, authEnv: "NOPE" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("NOPE");
    });

    it("fails on a 4xx/5xx answer by default - and still stores the status", async () => {

        const result = await execute({ url: `${base}/broken` }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("HTTP 500");
        expect(result.artifacts?.status).toBe(500);
        expect(result.artifacts?.body).toBe("boom");
    });

    it("treats a non-2xx answer as data when the file says so", async () => {

        const result = await execute(
            { url: `${base}/broken`, failOnHttpError: false },
            context().ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts?.status).toBe(500);
    });

    it("refuses a URL that is not http(s)", async () => {

        const result = await execute({ url: "ftp://example.test/file" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("'url'");
    });

    it("fails rather than hangs when the endpoint never answers", async () => {

        const result = await execute({ url: `${base}/hang`, timeoutMs: 300 }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("timed out");
    });

    it("names the network cause when nothing is listening", async () => {

        const result = await execute({ url: "http://127.0.0.1:1/nothing" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Could not reach");
    });
});
