import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { PermissionLevel } from "../../../models/permissionCard";
import type { AskPermission } from "../../../models/run";
import type { AgentSessionConfig, AskRequest } from "../../AgentSession";
import { AnswerBook, createPermissionGate, UNANSWERED_NOTE, UNANSWERED_TEXT } from "../../permissions";
import { sessionOptions } from "../ClaudeProvider";

/*
 * Our own permission check, wired into a Claude session. The `PreToolUse` hook decides every call; "ask" goes on to
 * `canUseTool`, which puts the card to the person. `gate.test.ts` proves
 * the decisions; this file proves the SDK is handed them.
 */

type HookResult = { continue?: boolean; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
type Hook = (input: unknown) => Promise<HookResult>;
type CanUseTool = (tool: string, input: unknown, options: unknown) => Promise<{ behavior: string; message?: string }>;

function setUp(level: PermissionLevel, answer?: string) {

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-claude-gate-")));
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-claude-home-")));

    const book = new AnswerBook(path.join(root, "..", `${path.basename(root)}-permissions.json`));

    const gate = createPermissionGate({
        provider: "claude", acp: false, chatId: "chat-1", workingFolder: root, level: () => level,
        book, addFolder: () => undefined, home
    });

    const told: { permission: AskPermission; callId?: string }[] = [];
    const asked: AskRequest[] = [];

    const ask = answer === undefined
        ? undefined
        : (request: AskRequest) => {

            asked.push(request);

            return { askId: "ask-1", answer: Promise.resolve(answer) };
        };

    const options = sessionOptions(
        { workingDirectory: root, env: {} } as AgentSessionConfig,
        "sid", {}, new AbortController(), undefined, undefined, undefined, undefined,
        false, undefined, undefined,
        (permission, _raw, callId) => told.push({ permission, ...(callId ? { callId } : {}) }),
        { gate, ...(ask ? { ask } : {}) });

    const hook = (options.hooks as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0].hooks[0];
    const canUseTool = options.canUseTool as CanUseTool;

    return { root, home, book, told, asked, hook, canUseTool };
}

describe("the Claude session with our own permission check", () => {

    it("the hook hands a call that needs a card on to canUseTool as 'ask'", async () => {

        const { hook } = setUp("semi");

        const result = await hook({ tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1" });

        expect(result.hookSpecificOutput).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: "claude wants to run a command" });
    });

    it("the hook lets an allowed call through with no decision, and puts the note on its row", async () => {

        const { hook, told, root } = setUp("manual");

        const result = await hook({ tool_name: "Read", tool_input: { file_path: path.join(root, "a.ts") }, tool_use_id: "t2" });

        expect(result).toEqual({ continue: true });
        expect(told).toEqual([{
            permission: expect.objectContaining({ tool: "Read", note: "ran without asking: a read inside the chat's folders" }),
            callId: "t2"
        }]);
    });

    it("the hook refuses a protected path with no card, and the row says why", async () => {

        const { hook, told, home } = setUp("auto");

        const result = await hook({ tool_name: "Read", tool_input: { file_path: path.join(home, ".ssh", "id_rsa") }, tool_use_id: "t3" });

        expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
        expect(told[0].permission).toMatchObject({ note: "refused: ~/.ssh is never allowed, in any mode", refused: true });
    });

    it("canUseTool shows the card, saves the answer, and allows the call", async () => {

        const { canUseTool, asked, told, book } = setUp("semi", "This session: npm test *");

        const decision = await canUseTool("Bash", { command: "npm test -- --run" }, { toolUseID: "t4" });

        expect(decision.behavior).toBe("allow");
        expect(asked[0].permission?.card).toMatchObject({ type: "command", shown: "npm test -- --run" });
        expect(book.list()).toMatchObject([{ pattern: "npm test *", scope: "session", chatId: "chat-1" }]);
        expect(told.at(-1)?.permission.note).toBe("allowed by your answer `npm test *` (this session)");
    });

    it("a Deny with a reason is handed to the agent", async () => {

        const { canUseTool } = setUp("semi", "Deny: use pnpm");

        expect(await canUseTool("Bash", { command: "npm test" }, {}))
            .toEqual({ behavior: "deny", message: "The person denied this tool call and said: use pnpm" });
    });

    it("with nobody watching, a card that is due is allowed once - but never a path outside the folders", async () => {

        const { canUseTool } = setUp("semi");

        expect(await canUseTool("Bash", { command: "npm test" }, {})).toEqual({ behavior: "allow" });

        const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-claude-other-")));

        expect((await canUseTool("Read", { file_path: path.join(other, "x") }, {})).behavior).toBe("deny");
    });

    it("a card closed without an answer - the turn stopped - does not run the call", async () => {

        const { root, home } = setUp("semi");

        const gate = createPermissionGate({
            provider: "claude", acp: false, chatId: "chat-1", workingFolder: root, level: () => "semi",
            book: new AnswerBook(path.join(home, "p.json")), addFolder: () => undefined, home
        });

        const told: AskPermission[] = [];

        const options = sessionOptions(
            { workingDirectory: root, env: {} } as AgentSessionConfig,
            "sid", {}, new AbortController(), undefined, undefined, undefined, undefined,
            false, undefined, undefined, permission => told.push(permission),
            { gate, ask: () => ({ askId: "a", answer: Promise.reject(new Error("turn stopped")) }) });

        expect(await (options.canUseTool as CanUseTool)("Bash", { command: "npm test" }, {}))
            .toEqual({ behavior: "deny", message: UNANSWERED_TEXT });

        // The card is not drawn in the thread: the row says it was not answered.
        expect(told).toEqual([expect.objectContaining({ note: UNANSWERED_NOTE, refused: true })]);
    });

    it("a path the SDK flagged is checked too", async () => {

        const { canUseTool, asked } = setUp("auto", "Allow once");

        const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-claude-other-")));

        const decision = await canUseTool("Bash", { command: "cat x" }, { blockedPath: path.join(other, "x") });

        expect(decision.behavior).toBe("allow");
        expect(asked[0].permission?.card?.type).toBe("outside");
    });
});
