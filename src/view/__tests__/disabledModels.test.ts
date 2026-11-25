import { describe, expect, it } from "vitest";
import { modelOptionsOf } from "../ChatView";

describe("modelOptionsOf with models the account cannot run", () => {

    const choice = {
        providers: ["ghcp"],
        models: { ghcp: [{ id: "gpt-5", name: "GPT-5", multiplier: 1 }, { id: "o-max", name: "O Max", multiplier: 10, disabled: true }] }
    };

    it("shows them greyed out, and says why", () => {

        const off = modelOptionsOf({ provider: "ghcp", model: "gpt-5" } as never, choice).find(option => option.id === "o-max");

        expect(off).toMatchObject({ disabled: true, description: "Not enabled for your account", costMultiplier: "10x" });
    });

    it("keeps the one in effect pickable, so the button still says what will run", () => {

        const current = modelOptionsOf({ provider: "ghcp", model: "o-max" } as never, choice).find(option => option.id === "o-max");

        expect(current?.disabled).toBeUndefined();
    });
});
