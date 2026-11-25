// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { accountOf, ConnectorCache } from "../connectors/cache";
import { ADO_SOURCES, GITHUB_SOURCES, type ConnectorsConfig } from "../connectors/config";
import { Connectors } from "../connectors/Connectors";
import type { AdoChoices, GithubChoices } from "../protocol";

/*
 * What the connectors keep: each kind of list with its own
 * time, the file that outlives a restart, the account in every key,
 * version tags, and when it is all dropped.
 */

interface Route {

    pattern: RegExp;

    /** The answer: text as it is, anything else as JSON. A function gets the request's headers. */
    body: unknown | ((headers: Record<string, string>) => { body?: unknown; status?: number; headers?: Record<string, string> });
}

function fakeFetch(routes: Route[]) {

    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];

    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {

        const text = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;

        calls.push({ url: text, method: init?.method ?? "GET", headers });

        const found = routes.find(route => route.pattern.test(text));

        if (!found)
            return new Response(JSON.stringify({ message: "no route" }), { status: 404 });

        const answer = typeof found.body === "function"
            ? (found.body as (h: Record<string, string>) => { body?: unknown; status?: number; headers?: Record<string, string> })(headers)
            : { body: found.body };

        const status = answer.status ?? 200;
        const body = status === 304 ? null : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);

        return new Response(body, { status, headers: answer.headers ?? {} });
    });

    return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const GITHUB: ConnectorsConfig = {
    github: {
        reach: ["octocat/hello"],
        sources: { ...Object.fromEntries(GITHUB_SOURCES.map(source => [source, "off"])), files: "read", actions: "read", issues: "write" } as GithubChoices["sources"]
    }
};

const ADO: ConnectorsConfig = {
    ado: {
        reach: [{ org: "contoso", project: "Web" }],
        sources: { ...Object.fromEntries(ADO_SOURCES.map(source => [source, "off"])), builds: "read" } as AdoChoices["sources"]
    }
};

const REPO = { full_name: "octocat/hello", default_branch: "main", html_url: "https://github.com/octocat/hello" };

const WORKFLOWS = { workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] };

function service(config: ConnectorsConfig, routes: Route[], options: { token?: () => string; cacheFile?: string | false } = {}) {

    const fake = fakeFetch(routes);
    const connectors = new Connectors({
        folders: () => [],
        onSignIn: () => undefined,
        readConfig: () => config,
        fetcher: fake.fetcher,
        tokens: { get: async () => options.token?.() ?? "token", forget: () => undefined },
        cacheFile: options.cacheFile ?? false
    });

    return { ...fake, connectors };
}

const count = (calls: { url: string }[], pattern: RegExp) => calls.filter(call => pattern.test(call.url)).length;

/** A token shaped like az's: a JWT whose middle part holds the person's ids. */
function adoToken(oid: string, extra: string): string {

    return `x.${Buffer.from(JSON.stringify({ oid, tid: "t1", nonce: extra })).toString("base64url")}.y`;
}

afterEach(() => vi.useRealTimers());

describe("accountOf", () => {

    it("names an ADO account by its ids, so a new token for the same person is the same account", () => {

        expect(accountOf("ado", adoToken("me", "a"))).toBe(accountOf("ado", adoToken("me", "b")));
        expect(accountOf("ado", adoToken("me", "a"))).not.toBe(accountOf("ado", adoToken("someone", "a")));
    });

    it("names a GitHub account by its token, and never holds the token itself", () => {

        expect(accountOf("github", "gho_one")).not.toBe(accountOf("github", "gho_two"));
        expect(accountOf("github", "gho_one")).not.toContain("gho_one");
    });
});

describe("kept lists", () => {

    it("keeps each kind for its own time", async () => {

        vi.useFakeTimers({ toFake: ["Date"] });

        const { connectors, calls } = service(ADO, [{ pattern: /build\/definitions/, body: { value: [{ id: 5, name: "web-ci" }] } }]);

        await connectors.call("ado_list_build_pipelines", {}, async () => true);
        await connectors.call("ado_list_build_pipelines", {}, async () => true);

        expect(count(calls, /build\/definitions/)).toBe(1);

        // Pipelines are kept half an hour.
        vi.setSystemTime(Date.now() + 29 * 60_000);
        await connectors.call("ado_list_build_pipelines", {}, async () => true);
        expect(count(calls, /build\/definitions/)).toBe(1);

        vi.setSystemTime(Date.now() + 2 * 60_000);
        await connectors.call("ado_list_build_pipelines", {}, async () => true);
        expect(count(calls, /build\/definitions/)).toBe(2);
    });

    it("shows the picker a list past its time at once, fetches a fresh one behind it, and offers a refresh row", async () => {

        vi.useFakeTimers({ toFake: ["Date"] });

        let name = "ci.yml";
        const { connectors, calls } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /actions\/workflows\?/, body: () => ({ body: { workflows: [{ ...WORKFLOWS.workflows[0], path: `.github/workflows/${name}` }] } }) }
        ]);

        expect((await connectors.search(["github", "actions"], "")).map(row => row.name)).toEqual(["ci.yml"]);

        name = "build.yml";
        vi.setSystemTime(Date.now() + 31 * 60_000);

        const old = await connectors.search(["github", "actions"], "");

        expect(old.map(row => row.name)).toEqual(["ci.yml", "refresh"]);
        expect(old.at(-1)).toEqual(expect.objectContaining({ refresh: true, detail: expect.stringContaining("Saved 31 min ago") }));

        // The fresh one came in behind it.
        await vi.waitFor(() => expect(count(calls, /actions\/workflows/)).toBe(2));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect((await connectors.search(["github", "actions"], "")).map(row => row.name)).toEqual(["build.yml"]);
    });

    it("gives no refresh row for a list fetched under a minute ago", async () => {

        const { connectors } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /actions\/workflows\?/, body: WORKFLOWS }
        ]);

        await connectors.search(["github", "actions"], "");

        expect((await connectors.search(["github", "actions"], "")).some(row => row.refresh)).toBe(false);
    });

    it("asks again when the refresh row is picked, even within the list's time", async () => {

        vi.useFakeTimers({ toFake: ["Date"] });

        const { connectors, calls } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /actions\/workflows\?/, body: WORKFLOWS }
        ]);

        await connectors.search(["github", "actions"], "");
        vi.setSystemTime(Date.now() + 5 * 60_000);

        expect((await connectors.search(["github", "actions"], "")).some(row => row.refresh)).toBe(true);

        const fresh = await connectors.search(["github", "actions"], "", { refresh: true });

        expect(count(calls, /actions\/workflows/)).toBe(2);
        expect(fresh.some(row => row.refresh)).toBe(false);
    });

    it("keeps a file tree under its commit, and fetches it again only when the branch moves", async () => {

        vi.useFakeTimers({ toFake: ["Date"] });

        let head = "aaa";
        const { connectors, calls } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /commits\/main$/, body: () => ({ body: head }) },
            { pattern: /git\/trees\/aaa\?/, body: { tree: [{ path: "old.md", type: "blob" }] } },
            { pattern: /git\/trees\/bbb\?/, body: { tree: [{ path: "new.md", type: "blob" }] } }
        ]);

        expect((await connectors.search(["github", "files"], "")).map(row => row.name)).toEqual(["old.md"]);

        // The branch did not move: the tree is not asked for again, however long it has been.
        vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60_000);
        await connectors.search(["github", "files"], "");

        expect(count(calls, /git\/trees/)).toBe(1);

        head = "bbb";
        vi.setSystemTime(Date.now() + 2 * 60_000);

        // The picker may show the old tree once while the new head is fetched.
        await connectors.search(["github", "files"], "");
        await vi.waitFor(() => expect(count(calls, /commits\/main$/)).toBeGreaterThan(1));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect((await connectors.search(["github", "files"], "")).map(row => row.name)).toContain("new.md");
    });

    it("never gives one account's lists to another", async () => {

        let token = "gho_one";
        const { connectors, calls } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /actions\/workflows\?/, body: WORKFLOWS }
        ], { token: () => token });

        await connectors.search(["github", "actions"], "");
        token = "gho_two";
        await connectors.search(["github", "actions"], "");

        expect(count(calls, /actions\/workflows/)).toBe(2);
    });

    it("drops the lists after a write, even one that failed", async () => {

        const { connectors, calls } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /actions\/workflows\?/, body: WORKFLOWS },
            { pattern: /issues$/, body: () => ({ body: { message: "refused" }, status: 422 }) }
        ]);

        await connectors.search(["github", "actions"], "");
        await connectors.call("gh_create_issue", { title: "x" }, async () => true);
        await connectors.search(["github", "actions"], "");

        expect(count(calls, /actions\/workflows/)).toBe(2);
    });

    it("drops everything kept for a connector on Disconnect", async () => {

        const { connectors, calls } = service(GITHUB, [
            { pattern: /repos\/octocat\/hello$/, body: REPO },
            { pattern: /actions\/workflows\?/, body: WORKFLOWS }
        ]);

        await connectors.search(["github", "actions"], "");
        await connectors.remove("github");
        await connectors.search(["github", "actions"], "");

        expect(count(calls, /actions\/workflows/)).toBe(2);
    });

    it("does not keep a list whose fetch began before a clear", async () => {

        const cache = new ConnectorCache();
        let finish: (value: string[]) => void = () => undefined;

        const pending = cache.list("github", "a", "workflows", "r", () => new Promise<string[]>(resolve => { finish = resolve; }), "wait");

        cache.clear("github");
        finish(["old"]);
        await pending;

        const loaded = vi.fn(async () => ["new"]);

        expect(await cache.list("github", "a", "workflows", "r", loaded, "wait")).toEqual(["new"]);
        expect(loaded).toHaveBeenCalledOnce();
    });
});

describe("the cache file", () => {

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-cache-"));
    const file = path.join(folder, "connectors.json");

    afterEach(() => fs.rmSync(file, { force: true }));

    it("brings the lists back after a restart", async () => {

        const first = new ConnectorCache(file);

        await first.list("ado", "a", "repos", "contoso/Web", async () => ["web", "api"], "wait");
        first.save();

        const loaded = vi.fn(async () => ["changed"]);
        const second = new ConnectorCache(file);

        expect(await second.list("ado", "a", "repos", "contoso/Web", loaded, "wait")).toEqual(["web", "api"]);
        expect(loaded).not.toHaveBeenCalled();

        // Another account finds nothing.
        expect(await second.list("ado", "b", "repos", "contoso/Web", loaded, "wait")).toEqual(["changed"]);
    });

    it("forgets a connector's lists on disk when it is cleared", async () => {

        const first = new ConnectorCache(file);

        await first.list("ado", "a", "repos", "contoso/Web", async () => ["web"], "wait");
        await first.list("github", "a", "workflows", "octocat/hello", async () => ["ci"], "wait");
        first.clear("ado", true);
        first.save();

        const saved = fs.readFileSync(file, "utf8");

        expect(saved).not.toContain("ado:");
        expect(saved).toContain("github:");
    });

    it("starts empty from a broken file", async () => {

        fs.writeFileSync(file, "{ not json");

        expect(await new ConnectorCache(file).list("ado", "a", "repos", "x", async () => ["fresh"], "wait")).toEqual(["fresh"]);
    });
});

describe("version tags", () => {

    it("sends the tag again and takes the kept answer when nothing changed", async () => {

        const { connectors, calls } = service(GITHUB, [
            { pattern: /issues\/7\/comments/, body: [] },
            { pattern: /issues\/7$/, body: (headers: Record<string, string>) => headers["If-None-Match"] === "\"v1\""
                ? { status: 304 }
                : { body: { number: 7, title: "Login fails", state: "open", html_url: "https://github.com/octocat/hello/issues/7", repository_url: "https://api.github.com/repos/octocat/hello", body: "" }, headers: { ETag: "\"v1\"" } } }
        ]);

        const first = await connectors.call("gh_read_issue", { number: 7 }, async () => true);
        const second = await connectors.call("gh_read_issue", { number: 7 }, async () => true);

        expect(calls.filter(call => /issues\/7$/.test(call.url)).map(call => call.headers["If-None-Match"])).toEqual([undefined, "\"v1\""]);
        expect(second.text).toBe(first.text);
        expect(second.text).toContain("Login fails");
    });
});
