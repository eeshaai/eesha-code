import * as fs from "fs";
import * as path from "path";
import { PluginDatabase } from "../../core/plugins/PluginDatabase";
import { PluginHost } from "../../core/plugins/PluginHost";
import { RegisteredApp } from "../../core/plugins/PluginRegistry";
import { Workflow } from "../../core/models/workflowTypes";
import { messageOf } from "../../core/logging/logger";
import { PluginAppMessage, PluginReplyMessage, PluginRequestMessage } from "../../shared/runMessages";
import { EESHA_BASE_STYLE, EESHA_CLIENT } from "./eeshaClient";

/**
 * The host side of a plugin's app, shared by the run panel and the spec
 * panel: turns each app's page into something an iframe can show, and
 * answers what the page asks for.
 */

/**
 * Every app's page, assembled - or, given `only`, just the apps whose
 * plugin ref is in that set. The run panel passes the refs its workflow
 * file `uses:`, so a run shows no tab for a plugin it never calls.
 *
 * The page goes into a `srcdoc` iframe, which inherits the panel's CSP.
 * That policy allows scripts by nonce only, so every script tag gets the
 * panel's nonce - which also means a `<script src="app.js">` next to
 * the page cannot load by URL and is pulled inline instead, as is a
 * stylesheet. An unreadable page becomes a page saying so, not a broken
 * tab.
 */
export function pluginApps(host: PluginHost, nonce: string, only?: ReadonlySet<string>): PluginAppMessage[] {

    return host.plugins.apps()
        .filter(app => only === undefined || only.has(app.ref))
        .map(app => ({
            ref: app.ref,
            id: app.plugin.id,
            label: app.plugin.ui!.label,
            surface: app.plugin.ui!.surface,
            html: assemble(app, nonce)
        }));
}

/**
 * The plugin refs a definition `uses:`, across every stage and the
 * inline task library. Aliases are already resolved by the parser, so
 * each is a registry key. Undefined when there is no definition yet, so
 * the caller shows every app rather than none.
 */
export function pluginRefsOf(workflow: Workflow | undefined): ReadonlySet<string> | undefined {

    if (!workflow)
        return undefined;

    const tasks = [...workflow.tasks, ...workflow.stages.flatMap(stage => stage.tasks)];

    return new Set(tasks.map(task => task.plugin).filter((ref): ref is string => ref !== undefined));
}

function assemble(app: RegisteredApp, nonce: string): string {

    const entry = path.join(app.folder, app.plugin.ui!.entry);

    let page: string;

    try {

        page = fs.readFileSync(entry, "utf8");

    } catch (error) {

        return problemPage(nonce, `Plugin '${app.ref}' declares a ui at '${entry}', which could not be read: ${messageOf(error)}`);
    }

    const folder = path.dirname(entry);

    const inlined = page
        // <script src="rel"></script> -> the file's text, nonced.
        .replace(/<script\b([^>]*?)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (whole, before: string, src: string, after: string) => {

            if (isRemote(src))
                return `<!-- ${escape(src)}: a plugin's page cannot load scripts by URL; put the file next to the page -->`;

            const file = read(folder, src);

            return file === undefined
                ? `<!-- ${escape(src)}: not found next to the page -->`
                : `<script${withoutNonce(before)}${withoutNonce(after)} nonce="${nonce}">\n${file}\n</script>`;
        })
        // <link rel="stylesheet" href="rel"> -> <style>.
        .replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, whole => {

            const href = /\bhref=["']([^"']+)["']/i.exec(whole)?.[1];

            if (!href || isRemote(href))
                return `<!-- ${escape(href ?? "stylesheet")}: a plugin's page cannot load styles by URL; put the file next to the page -->`;

            const file = read(folder, href);

            return file === undefined ? `<!-- ${escape(href)}: not found next to the page -->` : `<style>\n${file}\n</style>`;
        })
        // Every remaining script gets the nonce, or the policy drops it.
        .replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi, (whole, attrs: string) => `<script${attrs} nonce="${nonce}">`);

    const prelude = `<script nonce="${nonce}">${EESHA_CLIENT}</script>\n<style>${EESHA_BASE_STYLE}</style>\n`;

    // In front of the plugin's own head content, so `window.eesha` exists
    // before any of its scripts run and its styles win over the base.
    return /<head\b[^>]*>/i.test(inlined)
        ? inlined.replace(/<head\b[^>]*>/i, match => `${match}\n${prelude}`)
        : `${prelude}${inlined}`;
}

/** A relative path under the page's folder, read - or nothing when it is not there or climbs out. */
function read(folder: string, relative: string): string | undefined {

    const resolved = path.resolve(folder, relative.split("?")[0]);

    const inside = path.relative(folder, resolved);

    if (inside.startsWith("..") || path.isAbsolute(inside))
        return undefined;

    try {

        return fs.readFileSync(resolved, "utf8");

    } catch {

        return undefined;
    }
}

function isRemote(url: string): boolean {

    return /^(https?:)?\/\//i.test(url) || /^data:/i.test(url);
}

/** A page whose author already wrote a nonce gets ours instead - theirs cannot match. */
function withoutNonce(attrs: string): string {

    return attrs.replace(/\snonce=["'][^"']*["']/i, "");
}

function escape(text: string): string {

    return text.replace(/--/g, "- -").replace(/</g, "&lt;");
}

function problemPage(nonce: string, message: string): string {

    return `<!doctype html><html><head><script nonce="${nonce}">${EESHA_CLIENT}</script><style>${EESHA_BASE_STYLE}</style></head>`
        + `<body><p style="color: var(--eesha-error-text)">${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></body></html>`;
}

/** What a panel supplies to answer a `run` request - it decides what a target means on its surface. */
export interface PluginAppDeps {

    /** The folder a `handle` runs in. */
    cwd: string;

    /** The definition's own folder - `ctx.root`. */
    root: string;

    run(target: string | undefined, params?: Record<string, unknown>): Promise<void>;
}

/**
 * One request from a plugin's app, answered. Never throws: the page
 * gets `ok: false` and the message, and decides what to show.
 */
export async function answerPluginRequest(
    request: PluginRequestMessage,
    host: PluginHost,
    database: PluginDatabase | undefined,
    deps: PluginAppDeps
): Promise<PluginReplyMessage> {

    try {

        return { id: request.id, ok: true, value: await answer(request, host, database, deps) };

    } catch (error) {

        return { id: request.id, ok: false, error: messageOf(error) };
    }
}

async function answer(
    request: PluginRequestMessage,
    host: PluginHost,
    database: PluginDatabase | undefined,
    deps: PluginAppDeps
): Promise<unknown> {

    switch (request.kind) {

        case "call":
            return normalise(await host.handle(request.ref, { name: request.name, payload: request.payload }, deps));

        case "db": {

            if (!database)
                throw new Error("This server has no plugin database - run history is in memory only.");

            const id = request.ref.split("@")[0];

            return normalise(await database.for(id)[request.op](request.sql, request.params));
        }

        case "run":
            await deps.run(request.target, request.params);
            return null;
    }
}

/** Whatever `postMessage` cannot carry - a bigint rowid, undefined - made plain. */
function normalise(value: unknown): unknown {

    if (value === undefined)
        return null;

    return JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? Number(v) : v));
}
