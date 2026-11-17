import { describe, expect, it } from "vitest";

import { coreProviders } from "../index";

/**
 * The real registration this build does: `ghcp` and `claude` static,
 * everything else a possible `ai.acpAgents.<id>`. Backs the documented
 * rule that an `ai.acpAgents` entry named `ghcp` or `claude` can never
 * be reached.
 */
describe("coreProviders", () => {

    it("registers ghcp and claude as static factories", () => {

        const providers = coreProviders();

        expect(providers.has("ghcp")).toBe(true);
        expect(providers.has("claude")).toBe(true);
    });

    it("has no static factory under any other id - everything else is a possible acpAgents entry", () => {

        const providers = coreProviders();

        expect(providers.has("kiro")).toBe(false);
        expect(providers.has("claude-acp")).toBe(false);
        expect(providers.has("ghcp-acp")).toBe(false);
    });

    // `has()` answers for the static map only. `get()` consults the
    // fallback only when `has()` says false, so a static id can never
    // fall through to the ACP fallback.
    it("never falls through to the ACP fallback for ghcp or claude, whatever settings.json might declare", async () => {

        const providers = coreProviders({ workspaceFolder: () => undefined });

        expect(providers.has("ghcp")).toBe(true);
        expect(providers.has("claude")).toBe(true);
    });

    it("reports what is registered when an unknown id resolves to nothing, real fallback included", async () => {

        // A name no ai.acpAgents will declare. The fallback runs for
        // real (reads real settings) and still says "not registered".
        await expect(coreProviders({ workspaceFolder: () => undefined }).get("no-such-agent-9f3c2a"))
            .rejects.toThrow(/No agent provider 'no-such-agent-9f3c2a' is registered.*Available: claude, fake, ghcp/s);
    });
});
