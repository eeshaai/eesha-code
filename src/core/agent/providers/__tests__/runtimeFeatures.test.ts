import { describe, expect, it } from "vitest";

import { compactByCommand } from "../acpCommands";
import { AcpExtensionSession, AcpExtensionTurn } from "../acpExtensions";
import { ENGINE_FEATURES } from "../acpNotes";
import { CLAUDE_MODES, claudeMode, ClaudeProvider } from "../ClaudeProvider";
import { COPILOT_MODES, CopilotProvider, exitPlanAction } from "../CopilotProvider";
import {
    COPILOT_FEED_EVENTS, COPILOT_SESSION_EVENT, copilotCliExtension, copilotTurnUsage, readCopilotEvent
} from "../copilotCliAcpExtension";
import { claudeCliExtension } from "../claudeCliAcpExtension";
import type { Spend } from "../../../models/run";

/*
 * The runtime features: Copilot CLI's event feed,
 * per-turn tokens and Compact; claude-cli's Compact; ghcp's and claude's
 * Plan mode, and ghcp's plan exit held off autopilot.
 */

function turn(notes: Record<string, unknown> = {}) {

    const kept = new Map(Object.entries(notes));
    const charged: Spend[][] = [];
    const calls: (number | undefined)[] = [];

    const view: AcpExtensionTurn = {
        charge: (spend, _note, count) => { charged.push([...spend]); calls.push(count); },
        note: (key, value) => { kept.set(key, value); },
        noted: key => kept.get(key)
    };

    return { view, charged, calls };
}

describe("Copilot CLI's event feed", () => {

    it("asks for the events it reads, on the channel it reads them from", () => {

        expect(copilotCliExtension.clientMeta).toEqual({ "github.com/copilot": { events: COPILOT_FEED_EVENTS } });
        expect(Object.keys(copilotCliExtension.notifications ?? {})).toEqual([COPILOT_SESSION_EVENT]);
    });

    it("puts a model call's credits on the turn's bill, premium requests only when the flag is off", () => {

        const data = { copilotUsage: { totalNanoAiu: 500_000_000 }, cost: 1 };

        const hidden = turn();
        expect(readCopilotEvent({ type: "assistant.usage", data }, hidden.view)).toBeUndefined();
        expect(hidden.charged).toEqual([[{ amount: 0.5, unit: "credits" }]]);

        const shown = turn({ [ENGINE_FEATURES]: { hideCopilotPremiumRequests: false } });
        readCopilotEvent({ type: "assistant.usage", data }, shown.view);
        expect(shown.charged).toEqual([[{ amount: 0.5, unit: "credits" }, { amount: 1, unit: "premium requests" }]]);
    });

    it("counts each usage event as one model call, even one that priced nothing", () => {

        const t = turn();

        readCopilotEvent({ type: "assistant.usage", data: { copilotUsage: { totalNanoAiu: 500_000_000 } } }, t.view);
        readCopilotEvent({ type: "assistant.usage", data: {} }, t.view);

        expect(t.calls).toEqual([1, 1]);
        expect(t.charged).toEqual([[{ amount: 0.5, unit: "credits" }], []]);
    });

    it("says when Copilot compacted by itself, or failed to", () => {

        const t = turn();

        expect(readCopilotEvent({ type: "session.compaction_complete", data: { success: true, messagesRemoved: 12, tokensRemoved: 40000 } }, t.view))
            .toMatchObject({ kind: "notice", text: "Conversation compacted - 12 messages, 40000 tokens removed." });
        expect(readCopilotEvent({ type: "session.compaction_complete", data: { success: false, error: "too short" } }, t.view))
            .toMatchObject({ kind: "error", message: "Compaction failed: too short" });
        expect(readCopilotEvent({ type: "session.compaction_complete", data: { success: true, messagesRemoved: 3, tokensRemoved: -601 } }, t.view))
            .toMatchObject({ text: "Conversation compacted - 3 messages removed. The summary is 601 tokens longer than what it replaced." });
        expect(readCopilotEvent({ type: "session.skills_loaded", data: {} }, t.view)).toBeUndefined();
    });
});

describe("copilotTurnUsage", () => {

    it("takes this turn's share of the running total, with the cache reads kept apart from ACP's cache field", () => {

        const t = turn();

        expect(copilotTurnUsage({ inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cachedReadTokens: 800 }, t.view))
            .toEqual({ inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cachedInsideTokens: 800 });

        expect(copilotTurnUsage({ inputTokens: 2500, outputTokens: 80, totalTokens: 2580, cachedReadTokens: 2000 }, t.view))
            .toEqual({ inputTokens: 1500, outputTokens: 30, totalTokens: 1530, cachedInsideTokens: 1200 });
    });

    it("takes a total smaller than the last as the turn's own - a new process under a resumed chat", () => {

        const t = turn();

        copilotTurnUsage({ inputTokens: 9000, outputTokens: 90, totalTokens: 9090 }, t.view);

        expect(copilotTurnUsage({ inputTokens: 700, outputTokens: 10, totalTokens: 710 }, t.view))
            .toEqual({ inputTokens: 700, outputTokens: 10, totalTokens: 710 });
    });
});

describe("compactByCommand", () => {

    const session = (prompt?: (text: string) => Promise<string>) =>
        ({ sessionId: "S", request: async () => undefined, prompt, ...turn().view }) as AcpExtensionSession;

    it("sends the agent's own /compact as a turn", async () => {

        const sent: string[] = [];

        expect(await compactByCommand(session(async text => { sent.push(text); return "Compacted conversation history."; }), "Copilot"))
            .toEqual({ ok: true });
        expect(sent).toEqual(["/compact"]);
    });

    it("says no when the agent's own answer says it did not compact", async () => {

        // claude-agent-acp 0.73.0 on a one-turn chat, observed.
        expect(await compactByCommand(session(async () => "Compacting...\n\nCompacting failed: Not enough messages to compact."), "Claude"))
            .toEqual({ ok: false, reason: "Claude did not compact: Compacting... Compacting failed: Not enough messages to compact." });
    });

    it("says why when the turn fails, or there is no chat to run it in", async () => {

        expect(await compactByCommand(session(async () => { throw new Error("offline"); }), "Claude"))
            .toEqual({ ok: false, reason: "Claude could not compact: offline" });
        expect((await compactByCommand(session(), "Claude")).ok).toBe(false);
    });

    it("is what both CLI runtimes compact with", () => {

        expect(copilotCliExtension.compact).toBeTypeOf("function");
        expect(claudeCliExtension.compact).toBeTypeOf("function");
    });
});

describe("Plan mode on ghcp and claude", () => {

    it("offers Agent and Plan, never autopilot or a mode that skips asking", async () => {

        expect((await new CopilotProvider().modes())?.modes.map(mode => mode.id)).toEqual(["interactive", "plan"]);
        expect((await new ClaudeProvider().modes())?.modes.map(mode => mode.id)).toEqual(["default", "plan"]);
        expect(COPILOT_MODES.map(mode => mode.name)).toEqual(["Agent", "Plan"]);
        expect(CLAUDE_MODES.map(mode => mode.name)).toEqual(["Agent", "Plan"]);
    });

    it("reads a Claude pick it does not offer as the default, and says so", () => {

        const lines: string[] = [];

        expect(claudeMode("plan")).toBe("plan");
        expect(claudeMode(undefined)).toBe("default");
        expect(claudeMode("bypassPermissions", text => lines.push(text))).toBe("default");
        expect(lines[0]).toContain("'bypassPermissions' is not offered");
    });
});

describe("exitPlanAction", () => {

    const all = ["autopilot", "autopilot_fleet", "interactive", "exit_only"];

    it("never leaves plan mode on autopilot", () => {

        expect(exitPlanAction({ actions: all, recommendedAction: "autopilot" })).toBe("interactive");
        expect(exitPlanAction({ actions: all, recommendedAction: "autopilot_fleet" })).toBe("interactive");
        expect(exitPlanAction({ actions: ["autopilot", "exit_only"], recommendedAction: "autopilot" })).toBe("exit_only");
    });

    it("goes with the recommendation when it keeps asking, and refuses when nothing does", () => {

        expect(exitPlanAction({ actions: all, recommendedAction: "exit_only" })).toBe("exit_only");
        expect(exitPlanAction({ actions: ["autopilot"], recommendedAction: "autopilot" })).toBeUndefined();
    });
});
