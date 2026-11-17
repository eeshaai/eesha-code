import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readCommandList } from "../../commandListFile";

import {
    AcpActiveSession, AcpAgentContext, AcpAgentSession, AcpConfigOption, AcpConnection, AcpSessionMessage,
    applyAgentMode, blockedCommandIn
} from "../AcpProvider";
import { ACP_EXTENSIONS } from "../acpExtensions";
import { claudeCliExtension } from "../claudeCliAcpExtension";
import {
    COPILOT_AGENT, COPILOT_AUTOPILOT, COPILOT_PATH_REQUEST, copilotCliExtension, copilotPathRequest
} from "../copilotCliAcpExtension";
import { copilotRequestPaths, copilotRequestWrites, createJail } from "../pathJail";
import { AgentEvent } from "../../AgentSession";
import { BUILT_IN_ACP_AGENTS } from "../../../settings/engineSettings";

/*
 * What keeps Copilot CLI and claude-agent-acp from running tools the
 * folder boundary never sees - their modes and switches that stop them
 * asking, typed commands that do the same, Copilot's path request, and
 * the ghcp provider's shell and path requests.
 */

/** claude-agent-acp 0.73.0's mode option, as a no-prompt probe returned it. */
const claudeModes: AcpConfigOption = {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
    options: [
        { value: "default", name: "Manual" },
        { value: "acceptEdits", name: "Accept edits" },
        { value: "plan", name: "Plan" },
        { value: "auto", name: "Auto" },
        { value: "bypassPermissions", name: "Bypass permissions" }
    ]
};

/** Copilot CLI 1.0.89's, and its allow-all switch. */
const copilotModes: AcpConfigOption = {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: COPILOT_AGENT,
    options: [
        { value: COPILOT_AGENT, name: "Agent" },
        { value: "https://agentclientprotocol.com/protocol/session-modes#plan", name: "Plan" },
        { value: COPILOT_AUTOPILOT, name: "Autopilot" }
    ]
};

const allowAll = (currentValue: string): AcpConfigOption => ({
    id: "allow_all", name: "Allow All", category: "permissions", type: "select", currentValue,
    options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }]
});

function harness(options: AcpConfigOption[]) {

    const calls: unknown[] = [];
    const lines: string[] = [];

    const ctx = {
        request(method: string, params?: unknown) {

            calls.push({ method, params });

            return Promise.resolve({});
        }
    } as unknown as AcpAgentContext;

    const session = { sessionId: "S", newSessionResponse: { configOptions: options } } as unknown as AcpActiveSession;

    return { ctx, session, calls, lines, log: (text: string) => { lines.push(text); } };
}

describe("built-in ACP agents", () => {

    it("runs copilot-cli and claude-cli with their guards, and Copilot out of the temp folder", () => {

        expect(BUILT_IN_ACP_AGENTS["copilot-cli"]).toEqual({
            command: "copilot", args: ["--acp", "--stdio", "--disallow-temp-dir"], extensions: ["copilot-cli"]
        });
        expect(BUILT_IN_ACP_AGENTS["claude-cli"]).toEqual({ command: "claude-agent-acp", extensions: ["claude-cli"] });
        expect(ACP_EXTENSIONS["copilot-cli"]).toBe(copilotCliExtension);
        expect(ACP_EXTENSIONS["claude-cli"]).toBe(claudeCliExtension);
    });

    it("keeps Copilot's allow-all off", () => {

        expect(copilotCliExtension.permissionOption).toEqual({ id: "allow_all", value: "off" });
    });
});

describe("applyAgentMode with a mode guard", () => {

    it("puts a Claude session that opened in Bypass permissions back in Manual", async () => {

        const h = harness([{ ...claudeModes, currentValue: "bypassPermissions" }]);

        expect(await applyAgentMode(h.ctx, h.session, undefined, h.log, undefined, claudeCliExtension.modeGuard)).toBe("default");

        expect(h.calls).toEqual([{
            method: "session/set_config_option",
            params: { sessionId: "S", configId: "mode", value: "default" }
        }]);
        expect(h.lines[0]).toContain("opened in Bypass permissions, which runs tools without asking - switching to Manual");
    });

    it("sets the fallback instead of a held-back mode that was picked before, without failing", async () => {

        const h = harness([copilotModes]);

        expect(await applyAgentMode(h.ctx, h.session, COPILOT_AUTOPILOT, h.log, undefined, copilotCliExtension.modeGuard))
            .toBe(COPILOT_AGENT);

        // Already in Agent: nothing to send.
        expect(h.calls).toEqual([]);
        expect(h.lines[0]).toContain("Autopilot is not offered");
    });

    it("leaves a mode that asks alone", async () => {

        const h = harness([claudeModes]);

        expect(await applyAgentMode(h.ctx, h.session, "plan", h.log, undefined, claudeCliExtension.modeGuard)).toBe("plan");
        expect(h.calls).toHaveLength(1);
    });
});

describe("blockedCommandIn", () => {

    const copilot = [copilotCliExtension];

    it("names a command that switches Copilot's asking off or widens its folders", () => {

        expect(blockedCommandIn("/allow-all on", copilot)).toBe("allow-all");
        expect(blockedCommandIn("  /YOLO", copilot)).toBe("yolo");
        expect(blockedCommandIn("/add-dir C:\\anything", copilot)).toBe("add-dir");
        expect(blockedCommandIn("/autopilot on", copilot)).toBe("autopilot");
    });

    it("names a command that takes Copilot's chat out of this machine", () => {

        expect(blockedCommandIn("/share gist", copilot)).toBe("share");
        expect(blockedCommandIn("/export html", copilot)).toBe("export");
        expect(blockedCommandIn("/remote on", copilot)).toBe("remote");
    });

    it("names the commands claude-agent-acp is never sent - the same as the Claude runtime's", () => {

        expect(blockedCommandIn("/permissions", [claudeCliExtension])).toBe("permissions");
        expect(blockedCommandIn("/add-dir D:\\other", [claudeCliExtension])).toBe("add-dir");
        expect(blockedCommandIn("/sandbox", [claudeCliExtension])).toBe("sandbox");
    });

    it("lets everything else through", () => {

        expect(blockedCommandIn("/compact", copilot)).toBeUndefined();
        expect(blockedCommandIn("please run /allow-all", copilot)).toBeUndefined();
        expect(blockedCommandIn("/allow-all on", [claudeCliExtension])).toBeUndefined();
        expect(blockedCommandIn("/compact", [claudeCliExtension])).toBeUndefined();
    });
});

describe("copilotPathRequest", () => {

    const request = {
        toolCallId: "call-1",
        title: COPILOT_PATH_REQUEST,
        kind: "read",
        rawInput: { path: "D:\\ws\\a.txt, C:\\Users\\me\\.ssh\\id_rsa" },
        locations: [{ path: "D:\\ws\\a.txt, C:\\Users\\me\\.ssh\\id_rsa" }]
    };

    it("splits the joined paths and takes the kind of the call that needs them", () => {

        const rewritten = copilotPathRequest(request, { toolCallId: "call-1", kind: "edit", title: "Edit file" });

        expect(rewritten?.kind).toBe("edit");
        expect(rewritten?.locations).toEqual([{ path: "D:\\ws\\a.txt" }, { path: "C:\\Users\\me\\.ssh\\id_rsa" }]);
        expect(rewritten?.rawInput).toEqual({ paths: ["D:\\ws\\a.txt", "C:\\Users\\me\\.ssh\\id_rsa"] });
    });

    it("counts a call it never saw as a write", () => {

        expect(copilotPathRequest(request, undefined)?.kind).toBe("other");
    });

    it("leaves every other request alone", () => {

        expect(copilotPathRequest({ title: "Edit a.txt", kind: "edit" }, undefined)).toBeUndefined();
    });

    it("does not let an outside path through behind an inside one", () => {

        const root = path.join(os.tmpdir(), "eesha-guard-root");
        const outside = path.join(os.homedir(), ".ssh", "id_rsa");
        const joined = `${path.join(root, "a.txt")}, ${outside}`;
        const jail = createJail(root);

        // Read whole, the string starts inside the root.
        expect(jail.escape({ locations: [{ path: joined }] }, undefined, true)).toBeUndefined();

        const rewritten = copilotPathRequest({ title: COPILOT_PATH_REQUEST, kind: "read", rawInput: { path: joined } }, { kind: "read" });

        expect(jail.escape(rewritten, undefined, false)?.asked).toBe(outside);
    });
});

describe("ghcp permission request paths", () => {

    it("reads a shell request's possible paths, with the home directory expanded", () => {

        expect(copilotRequestPaths({
            kind: "shell",
            possiblePaths: ["log", "~/.copilot/mcp-config.json", "$env:USERPROFILE\\.ssh\\id_rsa", 3]
        })).toEqual([
            "log",
            `${os.homedir()}/.copilot/mcp-config.json`,
            `${os.homedir()}\\.ssh\\id_rsa`
        ]);
    });

    it("splits a read request's joined paths, and leaves a single path to the usual scan", () => {

        expect(copilotRequestPaths({ kind: "read", path: "D:\\a.txt, C:\\b.txt" })).toEqual(["D:\\a.txt", "C:\\b.txt"]);
        expect(copilotRequestPaths({ kind: "read", path: "D:\\a.txt" })).toEqual([]);
        expect(copilotRequestPaths({ kind: "write", fileName: "D:\\a.txt" })).toEqual([]);
    });

    it("counts a shell request as a write unless every command is read-only and nothing is redirected", () => {

        expect(copilotRequestWrites({ kind: "shell", commands: [{ readOnly: true }] })).toBe(false);
        expect(copilotRequestWrites({ kind: "shell", commands: [{ readOnly: true }, { readOnly: false }] })).toBe(true);
        expect(copilotRequestWrites({ kind: "shell", commands: [{ readOnly: true }], hasWriteFileRedirection: true })).toBe(true);
        expect(copilotRequestWrites({ kind: "shell", commands: [] })).toBe(true);
        expect(copilotRequestWrites({ kind: "read" })).toBe(false);
    });
});

/** An `AcpAgentSession` on a fake agent that records every request, running the given extensions. */
function guardedSession(extensions = [copilotCliExtension], options: AcpConfigOption[] = [copilotModes, allowAll("off")], runtime?: string) {

    const queue: AcpSessionMessage[] = [];
    let waiter: ((message: AcpSessionMessage) => void) | undefined;

    const requests: { method: string; params: unknown }[] = [];
    const prompts: unknown[] = [];

    const active: AcpActiveSession = {
        sessionId: "S",
        newSessionResponse: { configOptions: options },
        prompt(prompt) {

            prompts.push(prompt);

            return new Promise(() => undefined);
        },
        nextUpdate: () => queue.length
            ? Promise.resolve(queue.shift()!)
            : new Promise(resolve => { waiter = resolve; }),
        dispose() { /* nothing */ }
    };

    const ctx = {
        request: (method: string, params: unknown) => { requests.push({ method, params }); return Promise.resolve({}); },
        notify: () => Promise.resolve(),
        buildSession: () => { throw new Error("not needed"); }
    } as unknown as AcpAgentContext;

    const connection = { agent: ctx, close() { /* nothing */ } } as AcpConnection;

    const s = new AcpAgentSession({ kill() { /* nothing */ } } as never, connection, ctx, active, undefined, undefined, undefined, extensions, runtime);

    const events: AgentEvent[] = [];
    s.on(event => events.push(event));

    return {
        s, events, requests, prompts,
        push(message: AcpSessionMessage) {

            if (waiter) {

                const wake = waiter;
                waiter = undefined;
                wake(message);

            } else
                queue.push(message);
        }
    };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("AcpAgentSession guard", () => {

    it("refuses a blocked command before anything reaches the agent", async () => {

        const g = guardedSession();

        await g.s.send({ prompt: "/allow-all on" });
        await expect(g.s.sendAndWait({ prompt: "/add-dir C:\\" })).rejects.toThrow("'/add-dir' was not sent");

        expect(g.prompts).toEqual([]);
        expect(g.events.filter(event => event.kind === "error")).toHaveLength(2);
        expect(g.events.some(event => event.kind === "idle")).toBe(true);
    });

    it("refuses /share and /remote with their own reason, not the asking-and-folders one", async () => {

        const g = guardedSession();

        await expect(g.s.sendAndWait({ prompt: "/share gist" }))
            .rejects.toThrow("'/share' was not sent: it can publish this chat as a GitHub gist, or save it to a file outside this session's folders.");
        await expect(g.s.sendAndWait({ prompt: "/remote on" }))
            .rejects.toThrow("'/remote' was not sent: it lets this session be used from GitHub.com and GitHub Mobile, outside this chat.");

        expect(g.prompts).toEqual([]);
    });

    it("leaves /share, /export and /remote out of Copilot's kept list", async () => {

        // The test's home is a throwaway folder - see src/__tests__/setup.ts.
        const g = guardedSession([copilotCliExtension], [copilotModes, allowAll("off")], "copilot-cli-guard-test");

        g.push({
            kind: "session_update",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                    { name: "share", description: "Share the session" },
                    { name: "export", description: "Export the session" },
                    { name: "remote", description: "Remote access" },
                    { name: "compact", description: "Shrink the chat" }
                ]
            }
        } as AcpSessionMessage);

        await vi.waitFor(async () => expect(await readCommandList("copilot-cli-guard-test")).toEqual([
            { name: "compact", description: "Shrink the chat" }
        ]));
    });

    it("keeps the commands the agent sends at session start, with the refused ones left out, before any message", async () => {

        // The test's home is a throwaway folder - see src/__tests__/setup.ts.
        const g = guardedSession([claudeCliExtension], [claudeModes], "claude-cli-guard-test");

        g.push({
            kind: "session_update",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                    { name: "review", description: "Review a pull request", input: { hint: "<pr>" } },
                    { name: "permissions", description: "Change what runs without asking" },
                    { name: "compact", description: "Shrink the chat" }
                ]
            }
        } as AcpSessionMessage);

        await vi.waitFor(async () => expect(await readCommandList("claude-cli-guard-test")).toEqual([
            { name: "compact", description: "Shrink the chat" },
            { name: "review", description: "Review a pull request", hint: "<pr>" }
        ]));

        expect(g.prompts).toEqual([]);
    });

    it("switches Copilot out of Autopilot and turns allow-all back off, and says so once a message went out", async () => {

        const g = guardedSession();

        await g.s.send({ prompt: "hello" });

        g.push({
            kind: "session_update",
            update: { sessionUpdate: "config_option_update", configOptions: [{ ...copilotModes, currentValue: COPILOT_AUTOPILOT }, allowAll("on")] }
        } as AcpSessionMessage);

        await tick(); await tick(); await tick();

        expect(g.requests).toEqual([
            { method: "session/set_config_option", params: { sessionId: "S", configId: "mode", value: COPILOT_AGENT } },
            { method: "session/set_config_option", params: { sessionId: "S", configId: "allow_all", value: "off" } }
        ]);

        const notices = g.events.filter(event => event.kind === "notice").map(event => (event as { text: string }).text);

        expect(notices).toContain("The agent switched itself to Autopilot mode, which runs tools without asking - switched back to Agent.");
        expect(notices.some(text => text.includes("Allow All switch to 'on'"))).toBe(true);
        expect(g.s.agentMode).toBe(COPILOT_AGENT);
    });

    it("puts Claude back in Manual after a plan was accepted into Bypass permissions", async () => {

        const g = guardedSession([claudeCliExtension], [claudeModes]);

        await g.s.send({ prompt: "hello" });

        g.push({ kind: "session_update", update: { sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" } } as AcpSessionMessage);

        await tick(); await tick();

        expect(g.requests).toEqual([
            { method: "session/set_config_option", params: { sessionId: "S", configId: "mode", value: "default" } }
        ]);
        expect(g.s.agentMode).toBe("default");
    });

    it("tracks a mode change that asks, without touching it", async () => {

        const g = guardedSession([claudeCliExtension], [claudeModes]);

        g.push({ kind: "session_update", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } as AcpSessionMessage);

        await tick();

        expect(g.requests).toEqual([]);
        expect(g.s.agentMode).toBe("plan");
    });

    it("sets a stale switch again quietly before the first message", async () => {

        const g = guardedSession();

        g.push({ kind: "session_update", update: { sessionUpdate: "config_option_update", configOptions: [copilotModes, allowAll("on")] } } as AcpSessionMessage);

        await tick(); await tick();

        expect(g.requests).toHaveLength(1);
        expect(g.events.filter(event => event.kind === "notice")).toEqual([]);
    });
});
