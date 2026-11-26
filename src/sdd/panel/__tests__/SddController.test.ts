import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentSessions } from "../../../core/agent";
import type { PluginHost } from "../../../core/plugins/PluginHost";
import { resetLogSink, setLogSinks } from "../../../core/logging/logger";
import type { ToSddView } from "../../../shared/sddMessages";
import { SddController } from "../SddController";
import type { SddHost } from "../sddHost";

/**
 * The controller against a host with nothing behind it but memory - no
 * server. What this checks is the seam: everything the spec
 * logic needs from the app around it goes through `SddHost`, and
 * the workspace folder is the one it was handed. The behaviour itself -
 * waves, Stop, Resume, review, handover - is covered in
 * SddController.flows.test.ts.
 */

const resources = path.resolve(__dirname, "..", "..", "..", "..", "resources");

const SPEC = "demo";

let workspace: string;

beforeEach(() => {

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-controller-"));

    const folder = path.join(workspace, ".eesha", "specs", SPEC);

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "idea.md"), "---\ntype: feature\n---\n\n# The ask\n", "utf8");

    // Quiet: a failure is logged as well as shown, and this file makes some.
    setLogSinks({ emit: () => undefined, flush: () => Promise.resolve() });
});

afterEach(() => {

    resetLogSink();

    fs.rmSync(workspace, { recursive: true, force: true });
});

/** A host that writes down what it was asked to do. */
function fakeHost() {

    const saved = (): SddHost["store"] => {

        const values = new Map<string, unknown>();

        return {
            get: <T>(key: string) => values.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {

                if (value === undefined)
                    values.delete(key);
                else
                    values.set(key, value);
            }
        };
    };

    const done = {
        opened: [] as string[],
        errors: [] as string[],
        infos: [] as string[],
        watched: [] as string[],
        released: 0
    };

    const sessions = new AgentSessions();

    const host: SddHost = {
        store: saved(),
        profileStore: saved(),
        ai: { workspaceFolder: () => workspace, warn: () => undefined },
        resources,
        permissions: {
            levels: () => ({}),
            setLevel: async () => undefined,
            saved: () => [],
            remove: () => false,
            forget: () => undefined
        },
        plugins: () => ({}) as PluginHost,
        sessions: () => sessions,
        pluginApps: () => ({ apps: [], sandboxed: false }),
        answerPluginRequest: async request => ({ id: request.id, ok: true, value: undefined }),
        watch: folder => {

            done.watched.push(folder);

            return { dispose: () => undefined };
        },
        folderOf: () => undefined,
        typedMessage: async text => ({ message: text as never, attachments: [] }),
        searchFiles: async () => [],
        openFile: file => { done.opened.push(file); },
        openSession: async () => undefined,
        newPhaseChat: async () => "chat-1",
        phaseChat: () => undefined,
        resumeChanged: () => undefined,
        sendToTerminal: () => undefined,
        runInTerminal: async () => undefined,
        runWorkflow: async () => undefined,
        choose: async () => undefined,
        showError: text => { done.errors.push(text); },
        showInfo: text => { done.infos.push(text); },
        announceAsk: () => undefined,
        showSpec: async () => undefined,
        released: () => { done.released++; }
    };

    return { host, done };
}

function surface() {

    const posted: ToSddView[] = [];

    return { posted, post: (message: ToSddView) => { posted.push(message); }, reveal: () => undefined };
}

describe("the spec controller and its host", () => {

    it("draws the spec from the workspace it was handed, and watches that spec's folder", async () => {

        const { host, done } = fakeHost();
        const page = surface();

        const controller = new SddController(host, workspace, SPEC);

        controller.attach(page);

        await controller.refresh();

        const spec = page.posted.find(message => message.type === "spec");

        expect(spec?.type === "spec" && spec.spec.name).toBe(SPEC);
        expect(done.watched).toEqual([path.join(workspace, ".eesha", "specs", SPEC)]);
        expect(done.errors).toEqual([]);
    });

    it("opens a file through the host", () => {

        const { host, done } = fakeHost();

        const controller = new SddController(host, workspace, SPEC);

        controller.attach(surface());
        controller.receive({ type: "open", path: "C:/somewhere/requirements.md" });

        expect(done.opened).toEqual(["C:/somewhere/requirements.md"]);
    });

    it("says through the host, and on the page, when the spec has gone", async () => {

        const { host, done } = fakeHost();
        const page = surface();

        const controller = new SddController(host, workspace, SPEC);

        controller.attach(page);

        fs.rmSync(path.join(workspace, ".eesha", "specs", SPEC), { recursive: true, force: true });

        await controller.refresh();

        expect(done.errors).toEqual([`${SPEC}: '${SPEC}' is no longer under the spec root.`]);
        expect(page.posted).toContainEqual({ type: "error", text: `'${SPEC}' is no longer under the spec root.` });
    });

    it("lets the host go of it when its page closes with nothing running", () => {

        const { host, done } = fakeHost();

        const controller = new SddController(host, workspace, SPEC);

        controller.attach(surface());

        expect(controller.attached).toBe(true);

        controller.detach();

        expect(controller.attached).toBe(false);
        expect(done.released).toBe(1);
    });
});
