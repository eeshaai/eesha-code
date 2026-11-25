import { describe, expect, it } from "vitest";

import {
    AcpActiveSession, AcpAgentContext, AcpAgentSession, AcpConnection, agentTitle, loadSession, offersSystemPrompt, prefaceOf,
    sessionSetupRequest, systemPromptOf, turnedOffTool, withToolName
} from "../AcpProvider";
import { claudeCliExtension, claudeCliSessionMeta, claudeCliToolName } from "../claudeCliAcpExtension";
import { withToolsOff } from "../ClaudeProvider";
import { copilotCliExtension, copilotLaunchArgs } from "../copilotCliAcpExtension";
import { kiroV3Extension, kiroV3SessionMeta, kiroV3ToolName, KIRO_V3_STEERING_NAME } from "../kiroV3AcpExtension";

/*
 * Standing instructions and tools turned off, on each runtime: Kiro v3
 * gets them as steering, claude-agent-acp as its system prompt and
 * blocked list, Copilot CLI as a start argument,
 * and any other ACP runtime in front of its first message.
 */

const setup = (instructions: string, toolsOff: string[] = []) => ({ instructions, toolsOff });

describe("Kiro v3", () => {

    it("sends the instructions as one always-on steering file", () => {

        expect(kiroV3SessionMeta(setup("Use tabs."))).toEqual({
            kiro: { steering: [{ name: KIRO_V3_STEERING_NAME, inclusion: "always", content: "Use tabs." }] }
        });
    });

    it("sends nothing for empty instructions - turned-off tools are refused at the permission request instead", () => {

        expect(kiroV3SessionMeta(setup("  ", ["str_replace"]))).toEqual({});
    });

    it("names str_replace by its input, whatever the title says", () => {

        expect(kiroV3ToolName({ title: "Editing a.ts", rawInput: { path: "a.ts", oldStr: "x", newStr: "y" } })).toBe("str_replace");
    });

    it("names a tool by its own Kiro title", () => {

        expect(kiroV3ToolName({ title: "Write File", rawInput: { path: "a.ts" } })).toBe("fs_write");
        expect(kiroV3ToolName({ title: "Replace in File" })).toBe("str_replace");
        expect(kiroV3ToolName({ title: "Run a command" })).toBeUndefined();
        expect(kiroV3ToolName(undefined)).toBeUndefined();
    });
});

describe("claude-agent-acp", () => {

    it("adds the instructions to Claude Code's own prompt and the tools to its blocked list", () => {

        expect(claudeCliSessionMeta(setup("Use tabs.", ["WebFetch"]))).toEqual({
            systemPrompt: { append: "Use tabs." },
            claudeCode: { options: { disallowedTools: ["WebFetch"] } }
        });
    });

    it("sends nothing when there is nothing to send", () => {

        expect(claudeCliSessionMeta(setup(""))).toEqual({});
    });

    it("reads Claude's own tool name off the call's _meta, not its title", () => {

        expect(claudeCliToolName({ _meta: { claudeCode: { toolName: "Read" } } })).toBe("Read");
        expect(claudeCliToolName({ _meta: { claudeCode: {} } })).toBeUndefined();
        expect(claudeCliToolName({})).toBeUndefined();
        expect(claudeCliToolName(undefined)).toBeUndefined();
    });

    it("refuses a turned-off tool by that name, though the title carries a path", () => {

        const call = { title: "Read C:\\a.ts", _meta: { claudeCode: { toolName: "Read" } } };

        expect(turnedOffTool(call, [claudeCliExtension], ["read"])).toBe("read");
    });
});

describe("withToolName - the runtime's own name on a tool call's log line", () => {

    const start = { name: "tool_call", raw: {}, kind: "tool.start" as const, tool: "Read C:\\a.ts" };

    it("adds the name an extension reads off the call", () => {

        expect(withToolName(start, { title: "Read C:\\a.ts", _meta: { claudeCode: { toolName: "Read" } } }, [claudeCliExtension]))
            .toEqual({ ...start, toolName: "Read" });
        expect(withToolName({ ...start, tool: "Replace in File" }, { title: "Replace in File" }, [kiroV3Extension]))
            .toEqual({ ...start, tool: "Replace in File", toolName: "str_replace" });
    });

    it("leaves the event alone when no extension can tell", () => {

        expect(withToolName(start, { title: "Viewing a.ts" }, [copilotCliExtension])).toBe(start);
        expect(withToolName(start, { title: "Read C:\\a.ts" }, [])).toBe(start);
    });
});

describe("Copilot CLI", () => {

    it("takes tools away with --excluded-tools, last on the command line", () => {

        expect(copilotLaunchArgs(setup("", ["shell", "write"]))).toEqual(["--excluded-tools", "shell", "write"]);
        expect(copilotLaunchArgs(setup("Use tabs."))).toEqual([]);
    });

    it("has no session meta, so its instructions go in front of the first message", () => {

        expect(copilotCliExtension.sessionMeta).toBeUndefined();
        expect(claudeCliExtension.sessionMeta).toBeDefined();
        expect(kiroV3Extension.sessionMeta).toBeDefined();
    });
});

describe("turnedOffTool", () => {

    it("matches the extension's name for the call, ignoring case", () => {

        const call = { title: "Editing a.ts", rawInput: { path: "a.ts", oldStr: "x", newStr: "y" } };

        expect(turnedOffTool(call, [kiroV3Extension], ["STR_REPLACE"])).toBe("STR_REPLACE");
    });

    it("matches the request's title when no extension names it", () => {

        expect(turnedOffTool({ title: "write" }, [copilotCliExtension], ["write"])).toBe("write");
    });

    it("lets everything else through", () => {

        expect(turnedOffTool({ title: "Read File", kind: "read" }, [kiroV3Extension], ["str_replace"])).toBeUndefined();
        expect(turnedOffTool({ title: "str_replace" }, [], [])).toBeUndefined();
    });
});

describe("withToolsOff (Claude SDK)", () => {

    it("adds to the blocked list and keeps what is there", () => {

        const options: Record<string, unknown> = { disallowedTools: ["AskUserQuestion"] };

        withToolsOff(options, ["WebFetch", "AskUserQuestion"]);

        expect(options.disallowedTools).toEqual(["AskUserQuestion", "WebFetch"]);
    });

    it("leaves the options alone with nothing to turn off", () => {

        const options: Record<string, unknown> = {};

        withToolsOff(options, []);

        expect(options).toEqual({});
    });
});

function session() {

    const prompts: unknown[] = [];

    const active: AcpActiveSession = {
        sessionId: "S",
        newSessionResponse: {},
        prompt(prompt) {

            prompts.push(prompt);

            return Promise.resolve({ stopReason: "end_turn" }) as never;
        },
        nextUpdate: () => new Promise(() => undefined),
        dispose() { /* nothing */ }
    };

    const ctx = {
        request: () => Promise.resolve({}),
        notify: () => Promise.resolve(),
        buildSession: () => { throw new Error("not needed"); }
    } as unknown as AcpAgentContext;

    const connection = { agent: ctx, close() { /* nothing */ } } as AcpConnection;

    const s = new AcpAgentSession({ kill() { /* nothing */ } } as never, connection, ctx, active, undefined, undefined, undefined, []);

    return { s, prompts };
}

/** A prompt goes as plain text when it has no files. */
const texts = (prompts: unknown[]) => prompts.map(prompt => typeof prompt === "string"
    ? prompt
    : (prompt as { text?: string }[]).map(block => block.text ?? "").join(""));

describe("the preface - instructions in front of the first message", () => {

    it("goes in front of the first message only", async () => {

        const { s, prompts } = session();

        s.preface = prefaceOf("Use tabs.");

        await s.send({ prompt: "first" });
        await s.send({ prompt: "second" });

        const [first, second] = texts(prompts);

        expect(first).toContain("<system-instructions>");
        expect(first).toContain("Use tabs.");
        expect(first).toContain("after the conversation is compacted");
        expect(first.endsWith("first")).toBe(true);
        expect(second).toBe("second");
    });

    it("waits for the message after a slash command", async () => {

        const { s, prompts } = session();

        s.preface = prefaceOf("Use tabs.");

        await s.send({ prompt: "/compact" });
        await s.send({ prompt: "next" });

        const [command, next] = texts(prompts);

        expect(command).toBe("/compact");
        expect(next).toContain("Use tabs.");
    });
});

describe("ACP's own system prompt", () => {

    // What claude-agent-acp 0.109.0 answers on `initialize`, as far as this reads it.
    const offered = { sessionCapabilities: { systemPrompt: { mode: { override: {} } } } };

    it("goes by what the agent said on initialize", () => {

        expect(offersSystemPrompt(offered)).toBe(true);
        expect(offersSystemPrompt({ sessionCapabilities: { systemPrompt: {} } })).toBe(true);
        expect(offersSystemPrompt({ sessionCapabilities: { systemPrompt: null } })).toBe(false);
        expect(offersSystemPrompt({ sessionCapabilities: { list: {} } })).toBe(false);
        expect(offersSystemPrompt({ sessionCapabilities: null })).toBe(false);
        expect(offersSystemPrompt({})).toBe(false);
        expect(offersSystemPrompt(undefined)).toBe(false);
    });

    it("is one text block added to the agent's own instructions", () => {

        expect(systemPromptOf("Use tabs.")).toEqual({ mode: "append", content: [{ type: "text", text: "Use tabs." }] });
    });

    it("carries the instructions when the agent takes it, and the extension then sends the tools alone", () => {

        expect(sessionSetupRequest(setup("Use tabs.", ["WebFetch"]), offered, [claudeCliExtension])).toEqual({
            systemPrompt: { mode: "append", content: [{ type: "text", text: "Use tabs." }] },
            meta: { claudeCode: { options: { disallowedTools: ["WebFetch"] } } },
            instructionsGo: "systemPrompt"
        });

        expect(sessionSetupRequest(setup("Use tabs."), offered, [kiroV3Extension])).toEqual({
            systemPrompt: { mode: "append", content: [{ type: "text", text: "Use tabs." }] },
            instructionsGo: "systemPrompt"
        });
    });

    it("is used by an agent with no extension at all", () => {

        expect(sessionSetupRequest(setup("Use tabs."), offered, []).instructionsGo).toBe("systemPrompt");
    });

    it("is never sent to an agent that did not offer it - the extension's way, or the first message, as before", () => {

        expect(sessionSetupRequest(setup("Use tabs."), {}, [claudeCliExtension])).toEqual({
            meta: { systemPrompt: { append: "Use tabs." } },
            instructionsGo: "meta"
        });

        expect(sessionSetupRequest(setup("Use tabs."), { sessionCapabilities: { list: {} } }, [copilotCliExtension]))
            .toEqual({ instructionsGo: "preface" });
    });

    it("is not sent with no instructions", () => {

        expect(sessionSetupRequest(setup("", ["WebFetch"]), offered, [claudeCliExtension])).toEqual({
            meta: { claudeCode: { options: { disallowedTools: ["WebFetch"] } } },
            instructionsGo: "none"
        });
    });

    it("is sent again on session/load", async () => {

        const sent: unknown[] = [];

        const ctx = {
            request: (_method: string, params: unknown) => { sent.push(params); return Promise.resolve({}); },
            attachSession(response: unknown) { return response; }
        } as unknown as AcpAgentContext;

        await loadSession(ctx, "S1", "C:\\work", [], [], undefined, systemPromptOf("Use tabs."));
        await loadSession(ctx, "S2", "C:\\work", []);

        expect(sent[0]).toMatchObject({ sessionId: "S1", systemPrompt: { mode: "append", content: [{ type: "text", text: "Use tabs." }] } });
        expect(sent[0]).not.toHaveProperty("_meta");
        expect(sent[1]).not.toHaveProperty("systemPrompt");
    });
});

describe("loadSession", () => {

    it("sends the extensions' _meta on session/load too", async () => {

        const sent: unknown[] = [];

        const ctx = {
            request: (_method: string, params: unknown) => { sent.push(params); return Promise.resolve({}); },
            attachSession(response: unknown) { return response; }
        } as unknown as AcpAgentContext;

        await loadSession(ctx, "S1", "C:\\work", [], [], { kiro: { steering: [] } });
        await loadSession(ctx, "S2", "C:\\work", []);

        expect(sent[0]).toMatchObject({ sessionId: "S1", _meta: { kiro: { steering: [] } } });
        expect(sent[1]).not.toHaveProperty("_meta");
    });
});

describe("a title the agent made from the instructions", () => {

    it("is left out, so the chat keeps the person's first message as its title", () => {

        // Copilot CLI 1.0.110 names the conversation after the start of the first message.
        expect(agentTitle("<system-instructions> Follow these instructions for this whole conversation, as…")).toBe("");
        expect(agentTitle("<system-instructions>")).toBe("");
        expect(agentTitle(prefaceOf("Use tabs.").slice(0, 60))).toBe("");
    });

    it("keeps every other title, trimmed", () => {

        expect(agentTitle("  Save Go Tab Preference ")).toBe("Save Go Tab Preference");
        expect(agentTitle("Notes on <system-instructions>")).toBe("Notes on <system-instructions>");
    });

    it("is empty for no title", () => {

        expect(agentTitle(undefined)).toBe("");
        expect(agentTitle(7)).toBe("");
        expect(agentTitle("   ")).toBe("");
    });
});
