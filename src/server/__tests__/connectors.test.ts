// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ADO_SOURCES, checkConnector, GITHUB_SOURCES, readConnectors, saveConnector, type ConnectorsConfig } from "../connectors/config";
import type { AdoChoices, ConnectorAccess, GithubChoices } from "../protocol";
import { Connectors, pathsIn } from "../connectors/Connectors";
import { parseRemote } from "../connectors/remotes";
import { eeshaPath } from "../paths";

/*
 * The connectors with the web calls faked: no CLI is
 * run and nothing leaves the machine.
 */

/** A fake fetch: the first route whose pattern the URL matches answers. Text is sent as it is, anything else as JSON. */
function fakeFetch(routes: [RegExp, unknown, number?][]) {

    const calls: { url: string; method: string; body?: unknown }[] = [];

    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {

        const text = String(url);

        calls.push({ url: text, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });

        const found = routes.find(([pattern]) => pattern.test(text));

        if (!found)
            return new Response(JSON.stringify({ message: "no route" }), { status: 404 });

        return new Response(typeof found[1] === "string" ? found[1] : JSON.stringify(found[1]), { status: found[2] ?? 200 });
    });

    return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const tokens = { get: async () => "token", forget: () => undefined };

/** Every ADO source off but the ones given. */
function adoSources(given: Partial<Record<string, ConnectorAccess>>): AdoChoices["sources"] {

    return { ...Object.fromEntries(ADO_SOURCES.map(source => [source, "off"])), ...given } as AdoChoices["sources"];
}

/** Every GitHub source off but the ones given. */
function githubSources(given: Partial<Record<string, ConnectorAccess>>): GithubChoices["sources"] {

    return { ...Object.fromEntries(GITHUB_SOURCES.map(source => [source, "off"])), ...given } as GithubChoices["sources"];
}

const ADO_ONE: ConnectorsConfig = {
    ado: { reach: [{ org: "contoso", project: "Web App" }], sources: adoSources({ workitems: "write", builds: "read" }) }
};

const WORK_ITEM = {
    id: 12345,
    fields: { "System.Id": 12345, "System.Title": "Login fails", "System.State": "Active", "System.WorkItemType": "Bug", "System.TeamProject": "Web App" }
};

function connectors(config: ConnectorsConfig, routes: [RegExp, unknown, number?][] = []) {

    const fake = fakeFetch(routes);

    return {
        ...fake,
        service: new Connectors({ folders: () => [], onSignIn: () => undefined, readConfig: () => config, fetcher: fake.fetcher, tokens, cacheFile: false })
    };
}

describe("parseRemote", () => {

    it("reads the ADO and GitHub remote forms", () => {

        expect(parseRemote("https://contoso@dev.azure.com/contoso/Web%20App/_git/web")).toEqual({ kind: "ado", org: "contoso", project: "Web App" });
        expect(parseRemote("https://contoso.visualstudio.com/DefaultCollection/Web/_git/web")).toEqual({ kind: "ado", org: "contoso", project: "Web" });
        expect(parseRemote("git@ssh.dev.azure.com:v3/contoso/Web/web")).toEqual({ kind: "ado", org: "contoso", project: "Web" });
        expect(parseRemote("https://github.com/octocat/hello.git")).toEqual({ kind: "github", owner: "octocat", repo: "hello" });
        expect(parseRemote("git@github.com:octocat/hello.git")).toEqual({ kind: "github", owner: "octocat", repo: "hello" });
        expect(parseRemote("https://gitlab.com/a/b.git")).toBeUndefined();
    });
});

describe("pathsIn", () => {

    it("finds each > path once, and leaves quotes and arrows alone", () => {

        expect(pathsIn("fix >ado>workitems>12345, see >github>pulls>7. a -> b\n> quoted >ado>workitems>12345")).toEqual([
            ["ado", "workitems", "12345"],
            ["github", "pulls", "7"]
        ]);
    });
});

describe("connector choices", () => {

    afterEach(() => fs.rmSync(eeshaPath("settings.json"), { force: true }));

    it("refuses write access to GitHub repos and bad reach", () => {

        expect(checkConnector("github", { reach: ["octocat"], sources: { pulls: "write", repos: "write" } })).toEqual({ problem: "repos can only be off or read." });
        expect(checkConnector("ado", { reach: [{ org: "contoso" }], sources: {} })).toHaveProperty("problem");
    });

    it("saves into eesha.connectors and removes again, keeping the rest", async () => {

        fs.mkdirSync(eeshaPath(), { recursive: true });
        fs.writeFileSync(eeshaPath("settings.json"), JSON.stringify({ eesha: { theme: "light" } }));

        expect(await saveConnector("github", { reach: ["octocat"], sources: githubSources({ pulls: "read" }) })).toEqual({ ok: true });
        expect(readConnectors().github).toEqual({ reach: ["octocat"], sources: githubSources({ pulls: "read" }) });

        expect(await saveConnector("github", undefined)).toEqual({ ok: true });
        expect(JSON.parse(fs.readFileSync(eeshaPath("settings.json"), "utf8"))).toEqual({ eesha: { theme: "light" } });
    });
});

describe("Connectors", () => {

    it("lists the connected connectors, then the sources that are not off", async () => {

        const { service } = connectors(ADO_ONE);

        expect(await service.search([], "")).toEqual([{ name: "ado", detail: "Azure DevOps" }]);
        // One project in reach: no project level; "mine" comes first.
        expect((await service.search(["ado"], "")).map(row => row.name)).toEqual(["mine", "workitems", "builds"]);
    });

    it("says how to connect when nothing is connected", async () => {

        const { service } = connectors({});

        expect(await service.search([], "")).toEqual([expect.objectContaining({ disabled: true })]);
    });

    it("finds a work item by number and gives its reference line", async () => {

        const { service } = connectors(ADO_ONE, [[/wit\/workitems\/12345/, WORK_ITEM]]);

        expect(await service.search(["ado", "workitems"], "12345")).toEqual([
            { name: "12345", detail: "Bug - Login fails - Active", leaf: true }
        ]);

        const found = await service.references("look at >ado>workitems>12345 please");

        expect(found.lines).toEqual([
            "ADO Bug 12345 in contoso/Web App - Login fails - Active - https://dev.azure.com/contoso/Web%20App/_workitems/edit/12345 - read it with ado_read_work_item."
        ]);
        expect(found.note).toBeUndefined();

        // One item on its own gives its web address as a field, not only inside the line.
        expect(await service.item(["ado", "workitems", "12345"])).toEqual({
            line: found.lines[0],
            link: "https://dev.azure.com/contoso/Web%20App/_workitems/edit/12345",
            subject: { kind: "workitem", number: 12345, title: "Login fails", project: "contoso/Web-App" }
        });
    });

    it("names a path that does not resolve in the note", async () => {

        const { service } = connectors(ADO_ONE);

        const found = await service.references(">ado>releases>x and >github>pulls>1");

        expect(found.lines).toEqual([]);
        expect(found.note).toContain("releases is off");
        expect(found.note).toContain("GitHub is not connected");
    });

    it("lists only the tools the access allows", () => {

        const names = connectors(ADO_ONE).service.tools().map(tool => tool.name);

        expect(names).toContain("ado_add_work_item_comment");
        expect(names).toContain("ado_read_build_run");
        expect(names).not.toContain("ado_start_build_run");
        expect(names.some(name => name.includes("release"))).toBe(false);
    });

    it("refuses a tool that is not allowed, even when called", async () => {

        const ask = vi.fn(async () => true);
        const { service, calls } = connectors(ADO_ONE);

        expect(await service.call("ado_start_build_run", { pipelineId: 1 }, ask)).toEqual(expect.objectContaining({ isError: true }));
        expect(ask).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });

    it("asks before a write, and changes nothing on a no", async () => {

        const { service, calls } = connectors(ADO_ONE, [[/wit\/workitems\/12345/, WORK_ITEM], [/comments/, { id: 9 }]]);

        const no = await service.call("ado_add_work_item_comment", { id: 12345, text: "Fixed <b>it</b>\nin 1.2" }, async question => {

            expect(question).toEqual({ connector: "ado", tool: "ado_add_work_item_comment", text: "Add a comment to work item 12345:\n\nFixed <b>it</b>\nin 1.2" });

            return false;
        });

        expect(no).toEqual({ text: "The person said no. Nothing was changed.", isError: true });
        expect(calls).toEqual([]);

        const yes = await service.call("ado_add_work_item_comment", { id: 12345, text: "Fixed <b>it</b>\nin 1.2" }, async () => true);

        expect(yes.isError).toBeUndefined();
        expect(calls.at(-1)).toEqual(expect.objectContaining({ method: "POST", body: { text: "Fixed &lt;b&gt;it&lt;/b&gt;<br>in 1.2" } }));
    });

    it("keeps GitHub searches to what is in reach", async () => {

        const config: ConnectorsConfig = { github: { reach: ["octocat/hello"], sources: githubSources({ pulls: "read", repos: "read" }) } };
        const { service, calls } = connectors(config, [[/search\/issues/, { items: [{
            number: 7, title: "Add a test", state: "open", html_url: "https://github.com/octocat/hello/pull/7",
            repository_url: "https://api.github.com/repos/octocat/hello", user: { login: "octocat" }
        }] }]]);

        // One repo in reach: a pull request is named by its number alone.
        expect(await service.search(["github", "pulls"], "test")).toEqual([{ name: "7", detail: "Add a test - octocat", leaf: true }]);
        expect(decodeURIComponent(calls[0].url)).toContain("is:pr is:open repo:octocat/hello test");

        expect(await service.call("gh_read_repo", { repo: "someone/else" }, async () => true)).toEqual({
            text: "someone/else is not in reach. In reach: octocat/hello.",
            isError: true
        });
    });

    it("lists the repos first after >github>, then that repo's sources", async () => {

        const config: ConnectorsConfig = { github: { reach: ["octocat", "octocat/tools"], sources: githubSources({ pulls: "read", issues: "read" }) } };
        const { service, calls } = connectors(config, [
            [/search\/repositories/, { items: [
                { full_name: "octocat/hello", description: "Hi", html_url: "https://github.com/octocat/hello" },
                { full_name: "octocat/tools", html_url: "https://github.com/octocat/tools" }
            ] }],
            [/pulls\/7$/, { number: 7, title: "Add a test", state: "open", html_url: "https://github.com/octocat/hello/pull/7", head: { ref: "t", sha: "a" }, base: { ref: "main" } }],
            [/search\/issues/, { items: [{
                number: 7, title: "Add a test", state: "open", html_url: "https://github.com/octocat/hello/pull/7",
                repository_url: "https://api.github.com/repos/octocat/hello", user: { login: "octocat" }
            }] }]
        ]);

        expect((await service.search(["github"], "")).slice(1)).toEqual([{ name: "octocat/hello", detail: "Hi" }, { name: "octocat/tools", detail: undefined }]);
        expect(decodeURIComponent(calls[0].url)).toContain("user:octocat repo:octocat/tools");

        expect((await service.search(["github", "octocat/hello"], "")).map(row => row.name)).toEqual(["pulls", "issues"]);

        // Inside a picked repo, a pull request is named by its number alone, and searches keep to that repo.
        expect(await service.search(["github", "octocat/hello", "pulls"], "test")).toEqual([{ name: "7", detail: "Add a test - octocat", leaf: true }]);
        expect(decodeURIComponent(calls.at(-1)!.url)).toContain("is:pr is:open repo:octocat/hello test");

        expect((await service.references(">github>octocat/hello>pulls>7")).lines[0]).toContain("GitHub pull request octocat/hello#7");

        expect((await service.item(["github", "octocat/hello", "pulls", "7"]))?.link).toMatch(/^https:\/\/github\.com\/octocat\/hello\/pull\/7$/);

        const wrong = await service.references(">github>pulls>7 and >github>someone/else>pulls>1");

        expect(wrong.lines).toEqual([]);
        expect(wrong.note).toContain("pulls is not a repo in reach");
        expect(wrong.note).toContain("someone/else is not a repo in reach");
    });

    it("asks for a new token once when a call is refused", async () => {

        const fresh: boolean[] = [];
        const fake = fakeFetch([[/wit\/workitems\/12345/, { message: "expired" }, 401]]);
        const service = new Connectors({
            folders: () => [],
            onSignIn: () => undefined,
            readConfig: () => ADO_ONE,
            fetcher: fake.fetcher,
            tokens: { get: async (_id, again) => { fresh.push(!!again); return "t"; }, forget: () => undefined },
            cacheFile: false
        });

        const result = await service.call("ado_read_work_item", { id: 12345 }, async () => true);

        expect(fresh).toEqual([false, true]);
        expect(result.isError).toBe(true);
        expect(result.text).toContain("az login");
        expect(result.text).toContain("Microsoft Entra");
    });
});

describe("a workspace's linked work item or issue", () => {

    const two: ConnectorsConfig = {
        ado: { reach: [{ org: "contoso", project: "Web App" }, { org: "contoso", project: "Shop" }], sources: adoSources({ workitems: "read", builds: "read" }) },
        github: { reach: ["octocat", "octocat/tools"], sources: githubSources({ issues: "read" }) }
    };

    const ISSUE = { number: 12, title: "Crash on start", state: "open", html_url: "https://github.com/octocat/tools/issues/12", repository_url: "https://api.github.com/repos/octocat/tools", body: "" };

    it("is made from an ADO work item, named by its number, with its own path even when picked through mine", async () => {

        const { service } = connectors(ADO_ONE, [[/wit\/workitems\/12345/, WORK_ITEM]]);
        const expected = {
            link: {
                connector: "ado", kind: "workitem", id: "12345", title: "Login fails",
                path: ["ado", "workitems", "12345"],
                url: "https://dev.azure.com/contoso/Web%20App/_workitems/edit/12345"
            }
        };

        expect(await service.linkItem(["ado", "workitems", "12345"])).toEqual(expected);
        expect(await service.linkItem(["ado", "mine", "workitems", "12345"])).toEqual(expected);
    });

    it("keeps the project level in the path when more than one ADO project is in reach", async () => {

        const { service } = connectors(two, [[/wit\/workitems\/12345/, WORK_ITEM]]);
        const made = await service.linkItem(["ado", "contoso/Web-App", "workitems", "12345"]);

        expect("link" in made && made.link.path).toEqual(["ado", "contoso/Web-App", "workitems", "12345"]);
    });

    it("is made from a GitHub issue, named owner/repo#number", async () => {

        const { service } = connectors(two, [[/repos\/octocat\/tools\/issues\/12/, ISSUE]]);

        expect(await service.linkItem(["github", "octocat/tools", "issues", "12"])).toEqual({
            link: {
                connector: "github", kind: "issue", id: "octocat/tools#12", title: "Crash on start",
                path: ["github", "octocat/tools", "issues", "12"],
                url: "https://github.com/octocat/tools/issues/12"
            }
        });
    });

    it("is refused for anything else: a container level, a build, an item that cannot be read", async () => {

        const { service } = connectors(ADO_ONE);

        expect(await service.linkItem(["ado", "workitems"])).toEqual({ problem: "Pick an Azure DevOps work item or a GitHub issue." });
        expect("problem" in await service.linkItem(["ado", "workitems", "999"])).toBe(true);
    });

    it("is offered first at the top of the > list as its whole path, a leaf, while its connector is set up", async () => {

        const { service } = connectors(two);
        const link = { connector: "ado" as const, kind: "workitem" as const, id: "12345", title: "Login fails", path: ["ado", "contoso/Shop", "workitems", "12345"] };

        expect((await service.search([], "", { link }))[0]).toEqual({
            name: "ado>contoso/Shop>workitems>12345", detail: "This workspace's work item - Login fails", leaf: true
        });

        // Typing filters it like the other rows - by its path or its title.
        expect((await service.search([], "github", { link })).map(row => row.name)).toEqual(["github"]);
        expect((await service.search([], "login", { link })).map(row => row.name)).toEqual(["ado>contoso/Shop>workitems>12345"]);

        // Its connector gone: no row.
        expect((await service.search([], "", { link: { ...link, connector: "github" as const, path: ["github", "x/y", "issues", "1"] } })).map(row => row.name))
            .toEqual(["github>x/y>issues>1", "ado", "github"]);
        expect((await connectors({ github: two.github }).service.search([], "", { link })).map(row => row.name)).toEqual(["github"]);
    });
});

describe("ADO sources beyond work items and pipelines", () => {

    const ALL: ConnectorsConfig = {
        ado: { reach: [{ org: "contoso", project: "Shop" }], sources: adoSources({ repos: "read", pulls: "write", wiki: "read", testplans: "read", queries: "read" }) }
    };

    const PULL = {
        pullRequestId: 41, title: "Fix login", status: "active", sourceRefName: "refs/heads/fix", targetRefName: "refs/heads/main",
        repository: { id: "r1", name: "web" }, lastMergeSourceCommit: { commitId: "abc" }
    };

    it("lists every source that is on, in the source order", async () => {

        const { service } = connectors(ALL);

        expect((await service.search(["ado"], "")).map(row => row.name)).toEqual(["mine", "queries", "repos", "pulls", "wiki", "testplans"]);
    });

    it("lists repos in the picker and gives the clone URL in the reference line", async () => {

        const { service } = connectors(ALL, [[/git\/repositories\?/, { value: [{ id: "r1", name: "web app", defaultBranch: "refs/heads/main", remoteUrl: "https://contoso@dev.azure.com/contoso/Shop/_git/web%20app", webUrl: "https://x/web" }] }]]);

        expect(await service.search(["ado", "repos"], "web")).toEqual([{ name: "web-app", detail: "main", leaf: true }]);
        expect((await service.references(">ado>repos>web-app")).lines[0]).toContain("git clone https://contoso@dev.azure.com/contoso/Shop/_git/web%20app");
    });

    it("votes on a pull request as the signed-in person, after asking", async () => {

        const { service, calls } = connectors(ALL, [
            [/connectionData/, { authenticatedUser: { id: "me-1" } }],
            [/reviewers\/me-1/, { vote: 10 }],
            [/git\/pullrequests\/41/, PULL]
        ]);
        const ask = vi.fn(async () => true);

        const result = await service.call("ado_vote_pull_request", { id: 41, vote: "approve" }, ask);

        expect(result.isError).toBeUndefined();
        expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: "Vote \"approve\" on pull request 41" }));
        expect(calls.at(-1)).toEqual(expect.objectContaining({ method: "PUT", body: { vote: 10 } }));
        expect(calls.at(-1)!.url).toContain("/git/repositories/r1/pullRequests/41/reviewers/me-1");
    });

    it("completes a pull request with its last commit", async () => {

        const { service, calls } = connectors(ALL, [[/pullrequests\/41/, PULL]]);

        await service.call("ado_complete_pull_request", { id: 41, mergeStrategy: "squash" }, async () => true);

        expect(calls.at(-1)).toEqual(expect.objectContaining({
            method: "PATCH",
            body: { status: "completed", lastMergeSourceCommit: { commitId: "abc" }, completionOptions: { deleteSourceBranch: false, mergeStrategy: "squash" } }
        }));
    });

    it("walks wiki pages below a wiki", async () => {

        const { service } = connectors(ALL, [
            [/wiki\/wikis\/w1\/pages/, { path: "/", subPages: [{ path: "/Home", subPages: [{ path: "/Home/Getting Started" }] }] }],
            [/wiki\/wikis\?/, { value: [{ id: "w1", name: "Shop.wiki", type: "projectWiki" }] }]
        ]);

        expect((await service.search(["ado", "wiki"], "")).map(row => row.name)).toEqual(["Shop.wiki"]);
        expect(await service.search(["ado", "wiki", "Shop.wiki"], "getting")).toEqual([{ name: "/Home/Getting-Started", leaf: true }]);
        expect((await service.references(">ado>wiki>Shop.wiki>/Home/Getting-Started")).lines[0]).toContain("\"/Home/Getting Started\"");
    });

    it("gives the test plans and their failed results, and no write tools", async () => {

        const { service } = connectors(ALL, [
            [/testplan\/plans\?/, { value: [{ id: 7, name: "Sprint 12", state: "Active" }] }],
            [/test\/Runs\/99\/results\?outcomes=Failed/, { value: [{ id: 1, testCaseTitle: "Login works", outcome: "Failed", errorMessage: "timeout" }] }]
        ]);

        expect(await service.search(["ado", "testplans"], "sprint")).toEqual([{ name: "7", detail: "Sprint 12 - Active", leaf: true }]);
        expect((await service.call("ado_read_test_run", { run: 99 }, async () => true)).text).toContain("timeout");

        const names = service.tools().map(tool => tool.name);

        expect(names.filter(name => /wiki|test/.test(name)).every(name => /_(list|read|search)_/.test(name))).toBe(true);
    });
});

describe("GitHub sources beyond pull requests and repos", () => {

    const ONE: ConnectorsConfig = {
        github: { reach: ["octocat/hello"], sources: githubSources({ files: "read", issues: "write", actions: "read", releases: "write", discussions: "read", projects: "read" }) }
    };

    it("finds files on the default branch, names first", async () => {

        const { service } = connectors(ONE, [
            [/commits\/main$/, "c0ffee"],
            [/git\/trees\/c0ffee\?recursive=1/, { tree: [{ path: "docs/app.md", type: "blob" }, { path: "src/app.ts", type: "blob" }, { path: "app-notes", type: "tree" }, { path: "app-notes/x.md", type: "blob" }] }],
            [/repos\/octocat\/hello$/, { full_name: "octocat/hello", default_branch: "main", html_url: "https://github.com/octocat/hello" }]
        ]);

        // One repo in reach: no repo level. A path that only holds the words in a folder comes last.
        expect((await service.search(["github", "files"], "app")).map(row => row.name)).toEqual(["docs/app.md", "src/app.ts", "app-notes", "app-notes/x.md"]);
        expect((await service.references(">github>files>src/app.ts")).lines[0]).toContain("GitHub file src/app.ts in octocat/hello");
    });

    it("shows a workflow's runs, with new turned off when Actions is read only", async () => {

        const { service } = connectors(ONE, [
            [/actions\/workflows\/5\/runs/, { workflow_runs: [{ id: 900, run_number: 12, status: "completed", conclusion: "failure", head_branch: "main", html_url: "u" }] }],
            [/actions\/workflows\?/, { workflows: [{ id: 5, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] }]
        ]);

        expect(await service.search(["github", "actions"], "")).toEqual([{ name: "ci.yml", detail: "CI" }]);

        const rows = await service.search(["github", "actions", "ci.yml"], "");

        expect(rows[0]).toEqual(expect.objectContaining({ name: "new", disabled: true }));
        expect(rows[1]).toEqual({ name: "900", detail: "#12 - failure - main", leaf: true });
        expect(service.tools().map(tool => tool.name)).not.toContain("gh_run_workflow");
    });

    it("starts a workflow on the default branch after asking", async () => {

        const config: ConnectorsConfig = { github: { reach: ["octocat/world"], sources: githubSources({ actions: "write" }) } };
        const { service, calls } = connectors(config, [
            [/dispatches/, {}],
            [/actions\/workflows\?/, { workflows: [{ id: 6, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active" }] }],
            [/repos\/octocat\/world$/, { full_name: "octocat/world", default_branch: "trunk", html_url: "u" }]
        ]);

        const result = await service.call("gh_run_workflow", { workflow: "deploy.yml", inputs: { env: "test" } }, async () => true);

        expect(result.isError).toBeUndefined();
        expect(calls.at(-1)).toEqual(expect.objectContaining({ method: "POST", body: { ref: "trunk", inputs: { env: "test" } } }));
        expect(calls.at(-1)!.url).toContain("/actions/workflows/6/dispatches");
    });

    it("will not read a pull request as an issue", async () => {

        const { service } = connectors(ONE, [[/issues\/7$/, { number: 7, title: "x", state: "open", html_url: "u", repository_url: "https://api.github.com/repos/octocat/hello", pull_request: {} }]]);

        expect((await service.call("gh_read_issue", { number: 7 }, async () => true)).text).toContain("gh_read_pull_request");
    });

    it("makes a release as a draft unless told otherwise", async () => {

        const { service, calls } = connectors(ONE, [[/releases$/, { id: 1, tag_name: "v1.0.0", draft: true, html_url: "u" }]]);

        await service.call("gh_create_release", { tag: "v1.0.0", generateNotes: true }, async () => true);

        expect(calls.at(-1)!.body).toEqual({ tag_name: "v1.0.0", generate_release_notes: true, draft: true, prerelease: false });
    });

    it("keeps discussions to the repos in reach", async () => {

        const { service } = connectors(ONE, [[/graphql/, { data: { search: { nodes: [
            { number: 3, title: "How to start", url: "u", category: { name: "Q&A" }, repository: { nameWithOwner: "octocat/hello" } },
            { number: 4, title: "Elsewhere", url: "u", repository: { nameWithOwner: "someone/else" } },
            {}
        ] } } }]]);

        expect(await service.search(["github", "discussions"], "start")).toEqual([{ name: "3", detail: "How to start - Q&A", leaf: true }]);
    });

    it("says how to add the project permission when the sign-in lacks it", async () => {

        const { service, calls } = connectors(ONE, [[/graphql/, { errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes." }] }]]);

        const result = await service.call("gh_list_projects", {}, async () => true);

        expect(result.isError).toBe(true);
        expect(result.text).toContain("gh auth refresh -s read:project");
        // Asked gh for a token again once, in case the permission was just added.
        expect(calls.length).toBe(2);
    });
});

describe("mine", () => {

    it("lists my open pull requests across GitHub reach, each once with why it is there", async () => {

        const config: ConnectorsConfig = { github: { reach: ["octocat", "octocat/tools"], sources: githubSources({ pulls: "read", issues: "read" }) } };
        const { service, calls } = connectors(config, [
            [/search\/issues/, { items: [{
                number: 7, title: "Add a test", html_url: "https://github.com/octocat/hello/pull/7",
                repository_url: "https://api.github.com/repos/octocat/hello", updated_at: "2026-11-13T00:00:00Z"
            }] }],
            [/pulls\/7$/, { number: 7, title: "Add a test", state: "open", html_url: "https://github.com/octocat/hello/pull/7", head: { ref: "t", sha: "a" }, base: { ref: "main" } }],
            [/search\/repositories/, { items: [] }]
        ]);

        expect((await service.search(["github"], ""))[0]).toEqual(expect.objectContaining({ name: "mine" }));
        expect((await service.search(["github", "mine"], "")).map(row => row.name)).toEqual(["pulls", "issues"]);

        calls.length = 0;

        expect(await service.search(["github", "mine", "pulls"], "")).toEqual([
            { name: "octocat/hello#7", detail: "Add a test - mine, review asked, assigned", leaf: true }
        ]);
        expect(calls.map(call => decodeURIComponent(call.url))).toEqual([
            expect.stringContaining("is:pr is:open author:@me user:octocat repo:octocat/tools"),
            expect.stringContaining("is:pr is:open review-requested:@me"),
            expect.stringContaining("is:pr is:open assignee:@me")
        ]);

        expect((await service.references(">github>mine>pulls>octocat/hello#7")).lines[0]).toContain("GitHub pull request octocat/hello#7");
        expect((await service.references(">github>mine>actions>1")).note).toContain("has no \"mine\" list");
    });

    it("lists my ADO work items and build runs with one project in reach, named by number", async () => {

        const { service, calls } = connectors(ADO_ONE, [
            [/wit\/wiql/, { workItems: [{ id: 12345 }] }],
            [/wit\/workitems\?ids=/, { value: [WORK_ITEM] }],
            [/wit\/workitems\/12345/, WORK_ITEM],
            [/connectionData/, { authenticatedUser: { id: "me-1" } }],
            [/build\/builds\?requestedFor/, { value: [{ id: 9, buildNumber: "20261113.1", status: "completed", result: "succeeded", sourceBranch: "refs/heads/main", definition: { name: "Web-CI" } }] }],
            [/build\/builds\/9\?/, { id: 9, buildNumber: "20261113.1", status: "completed", result: "succeeded", sourceBranch: "refs/heads/main", definition: { name: "Web-CI" } }]
        ]);

        expect((await service.search(["ado", "mine"], "")).map(row => row.name)).toEqual(["workitems", "builds"]);

        expect(await service.search(["ado", "mine", "workitems"], "")).toEqual([{ name: "12345", detail: "Bug - Login fails - Active", leaf: true }]);
        expect(calls.find(call => call.url.includes("wiql"))?.body).toEqual({ query: expect.stringContaining("[System.AssignedTo] = @Me") });
        expect((await service.references(">ado>mine>workitems>12345")).lines[0]).toContain("ADO Bug 12345 in contoso/Web App");

        expect(await service.search(["ado", "mine", "builds"], "")).toEqual([{ name: "9", detail: "Web-CI - 20261113.1 - succeeded - main", leaf: true }]);
        expect(calls.some(call => call.url.includes("requestedFor=me-1"))).toBe(true);
        expect((await service.references(">ado>mine>builds>9")).lines[0]).toContain("ADO build run 9 (20261113.1) of \"Web-CI\" in contoso/Web App - succeeded");
    });

    it("names an ADO item with its project when more than one project is in reach", async () => {

        const config: ConnectorsConfig = {
            ado: { reach: [{ org: "contoso", project: "Web App" }, { org: "contoso", project: "Shop" }], sources: adoSources({ pulls: "read" }) }
        };
        const pull = {
            pullRequestId: 41, title: "Fix login", status: "active", sourceRefName: "refs/heads/fix", targetRefName: "refs/heads/main",
            repository: { id: "r1", name: "web" }, creationDate: "2026-11-12T00:00:00Z"
        };
        const { service } = connectors(config, [
            [/connectionData/, { authenticatedUser: { id: "me-1" } }],
            [/Web%20App\/_apis\/git\/pullrequests\?/, { value: [pull] }],
            [/Shop\/_apis\/git\/pullrequests\?/, { value: [] }],
            [/Web%20App\/_apis\/git\/pullrequests\/41\?/, pull]
        ]);

        expect((await service.search(["ado"], ""))[0]).toEqual(expect.objectContaining({ name: "mine" }));
        expect(await service.search(["ado", "mine", "pulls"], "")).toEqual([{ name: "contoso/Web-App#41", detail: "web - Fix login - mine, review", leaf: true }]);
        expect((await service.references(">ado>mine>pulls>contoso/Web-App#41")).lines[0]).toContain("ADO pull request 41 in contoso/Web App");
        expect((await service.references(">ado>mine>pulls>41")).note).toContain("write it as org/project#id");
    });
});
