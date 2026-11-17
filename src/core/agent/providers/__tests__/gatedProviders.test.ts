import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { PermissionLevel } from "../../../models/permissionCard";
import type { AskPermission } from "../../../models/run";
import type { AgentSessionConfig, AskRequest } from "../../AgentSession";
import { AnswerBook, createPermissionGate, PermissionGate, UNANSWERED_NOTE } from "../../permissions";
import { createJail } from "../pathJail";
import { AcpAgentSession, gatedAcpAnswer } from "../AcpProvider";
import { sessionConfig } from "../CopilotProvider";

/*
 * Our own permission check, wired into a Copilot session and an ACP
 * agent's permission requests. The decisions
 * are `gate.test.ts`'s; this file proves each provider acts on them.
 */

function temporaryFolder(prefix: string): string {

    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gateFor(provider: string, acp: boolean, level: PermissionLevel): { gate: PermissionGate; root: string; home: string; book: AnswerBook } {

    const root = temporaryFolder("eesha-gated-root-");
    const home = temporaryFolder("eesha-gated-home-");
    const book = new AnswerBook(path.join(home, "permissions.json"));

    const gate = createPermissionGate({
        provider, acp, chatId: "chat-1", workingFolder: root, level: () => level, book, addFolder: () => undefined, home
    });

    return { gate, root, home, book };
}

/** A question answered at once with `answer`, and the requests it was asked. */
function answering(answer: string) {

    const asked: AskRequest[] = [];

    return { asked, ask: (request: AskRequest) => { asked.push(request); return { askId: "a1", answer: Promise.resolve(answer) }; } };
}

describe("a Copilot session with our own permission check", () => {

    type PreToolUse = (input: { toolName: string; toolArgs: unknown }) => { permissionDecision?: string } | undefined;
    type Handler = (request: unknown) => Promise<{ kind: string; feedback?: string }>;

    function copilot(level: PermissionLevel, answer?: string) {

        const { gate, root, home, book } = gateFor("ghcp", false, level);

        const told: AskPermission[] = [];
        const questions = answer === undefined ? undefined : answering(answer);

        const options = sessionConfig(
            { workingDirectory: root, env: {}, interactive: questions !== undefined } as unknown as AgentSessionConfig,
            undefined, undefined, questions?.ask, false, undefined,
            permission => told.push(permission),
            gate) as unknown as { hooks: { onPreToolUse: PreToolUse }; onPermissionRequest: Handler };

        return { options, told, asked: questions?.asked ?? [], root, home, book };
    }

    it("the pre-tool hook forces a request for a call that needs a card, and lets the rest through", () => {

        const { options } = copilot("semi");

        expect(options.hooks.onPreToolUse({ toolName: "powershell", toolArgs: { command: "npm test" } })).toEqual({ permissionDecision: "ask" });
        expect(options.hooks.onPreToolUse({ toolName: "view", toolArgs: { path: "a.ts" } })).toBeUndefined();
    });

    it("the pre-tool hook refuses a protected path", () => {

        const { options, home } = copilot("auto");

        expect(options.hooks.onPreToolUse({ toolName: "view", toolArgs: { path: path.join(home, ".ssh", "id_rsa") } }))
            .toMatchObject({ permissionDecision: "deny" });
    });

    it("the request shows our card and saves our answer - never the runtime's own", async () => {

        const { options, asked, told, book } = copilot("semi", "This folder: npm test *");

        const result = await options.onPermissionRequest({ kind: "shell", fullCommandText: "npm test -- --run", toolCallId: "c1" });

        expect(result).toEqual({ kind: "approve-once", approvedInteractively: true });
        expect(asked[0].permission?.card?.title).toBe("copilot wants to run a command");
        expect(book.list()).toMatchObject([{ scope: "folder", pattern: "npm test *", agent: "ghcp" }]);
        expect(told.at(-1)?.note).toBe("allowed by your answer `npm test *` (this folder)");
    });

    it("a Deny reaches the agent with the reason", async () => {

        const { options } = copilot("semi", "Deny: not now");

        expect(await options.onPermissionRequest({ kind: "shell", fullCommandText: "npm test" }))
            .toEqual({ kind: "reject", feedback: "The person denied this tool call and said: not now" });
    });

    it("a card closed without an answer does not run the call, and the row says so", async () => {

        const { gate, root } = gateFor("ghcp", false, "semi");
        const told: AskPermission[] = [];

        const options = sessionConfig(
            { workingDirectory: root, env: {}, interactive: true } as unknown as AgentSessionConfig,
            undefined, undefined, () => ({ askId: "a1", answer: Promise.reject(new Error("turn stopped")) }),
            false, undefined, permission => told.push(permission), gate) as unknown as { onPermissionRequest: Handler };

        expect(await options.onPermissionRequest({ kind: "shell", fullCommandText: "npm test", toolCallId: "c1" }))
            .toEqual({ kind: "user-not-available" });
        expect(told).toEqual([expect.objectContaining({ note: UNANSWERED_NOTE, refused: true })]);
    });

    it("asking to run outside the sandbox is a once-only card", async () => {

        const { options, asked } = copilot("semi", "Allow once");

        await options.onPermissionRequest({ kind: "shell", fullCommandText: "npm i", requestSandboxBypass: true });

        expect(asked[0].permission?.card?.type).toBe("once");
    });
});

describe("an ACP agent's request with our own permission check", () => {

    const OPTIONS = [
        { optionId: "a1", kind: "allow_once", name: "Yes" },
        { optionId: "a2", kind: "allow_always", name: "Always" },
        { optionId: "r1", kind: "reject_once", name: "No" }
    ];

    async function acp(level: PermissionLevel, toolCall: Record<string, unknown>, answer?: string, options = OPTIONS) {

        const { gate, root, home, book } = gateFor("kiro", true, level);

        const told: AskPermission[] = [];
        const questions = answer === undefined ? undefined : answering(answer);

        const session = { allowedWithoutAsking: (permission: AskPermission) => told.push(permission) } as unknown as AcpAgentSession;

        const outcome = await gatedAcpAnswer({
            gate,
            jail: createJail(root),
            toolCall: toolCall as never,
            requested: toolCall as never,
            options,
            answer: undefined,
            params: {},
            session,
            ask: questions?.ask
        });

        return { outcome, told, asked: questions?.asked ?? [], root, home, book };
    }

    it("Agent's Choice shows a card for every request, and a yes is the agent's allow once", async () => {

        const { outcome, asked } = await acp("agent", { kind: "read", title: "Read a.ts", locations: [] }, "Allow once");

        expect(asked).toHaveLength(1);
        expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    });

    it("never picks the agent's 'always' answer, even when it is the only yes", async () => {

        const { outcome } = await acp("auto", { kind: "execute", rawInput: { command: "ls" } }, undefined,
            [{ optionId: "a2", kind: "allow_always", name: "Always" }, { optionId: "r1", kind: "reject_once", name: "No" }]);

        expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
    });

    it("a no is the agent's reject once, and the row says who denied it", async () => {

        const { outcome, told } = await acp("semi", { kind: "execute", rawInput: { command: "rm -rf x" } }, "Deny");

        expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
        expect(told.at(-1)).toMatchObject({ note: "denied by you", refused: true });
    });

    it("a card closed without an answer cancels the call, and the row says so", async () => {

        const { gate, root } = gateFor("kiro", true, "semi");
        const told: AskPermission[] = [];
        const session = { allowedWithoutAsking: (permission: AskPermission) => told.push(permission) } as unknown as AcpAgentSession;
        const toolCall = { kind: "execute", rawInput: { command: "rm -rf x" } };

        const outcome = await gatedAcpAnswer({
            gate,
            jail: createJail(root),
            toolCall: toolCall as never,
            requested: toolCall as never,
            options: OPTIONS,
            answer: undefined,
            params: {},
            session,
            ask: () => ({ askId: "a1", answer: Promise.reject(new Error("turn stopped")) })
        });

        expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
        expect(told).toEqual([expect.objectContaining({ note: UNANSWERED_NOTE, refused: true })]);
    });

    it("Semi Auto lets an edit through without a card, and says so on the row", async () => {

        // Relative: read against the session's working folder.
        const { outcome, asked, told } = await acp("semi", { kind: "edit", title: "Edit", locations: [{ path: "a.ts" }] }, "Deny");

        expect(asked).toHaveLength(0);
        expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
        expect(told[0].note).toBe("auto-allowed (Semi Auto)");
    });
});
