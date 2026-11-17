import { describe, expect, it } from "vitest";
import { effortChoiceOf, modelOptionsOf, pickWith, providerPartsOf } from "../ChatView";

/* The compose box's Effort picker, and a runtime's own price beside a model. */

const choice = {
    providers: ["claude-cli"],
    models: {
        "claude-cli": [
            { id: "default", name: "Default", efforts: ["low", "high", "max"] },
            { id: "sonnet", name: "Sonnet", efforts: ["low", "high"], price: "$2/$10" },
            { id: "haiku", name: "Haiku", price: "$1/$5" }
        ]
    }
};

const on = (model: string) => ({ provider: "claude-cli", model }) as never;

describe("effortChoiceOf", () => {

    it("offers Default then the model's own levels", () => {

        expect(effortChoiceOf(on("sonnet"), choice)).toEqual({
            options: [
                { id: "default", label: "Default effort" },
                { id: "low", label: "Effort: low" },
                { id: "high", label: "Effort: high" }
            ],
            value: "default"
        });
    });

    it("hides the picker on auto, and for a model with no levels", () => {

        expect(effortChoiceOf(on("auto"), choice)).toBeUndefined();
        expect(effortChoiceOf(on("haiku"), choice)).toBeUndefined();
    });

    it("shows the pick when this model has it, and Default when it does not", () => {

        expect(effortChoiceOf(on("default"), { ...choice, pick: { provider: "claude-cli", effort: "max" } })?.value).toBe("max");
        expect(effortChoiceOf(on("sonnet"), { ...choice, pick: { provider: "claude-cli", effort: "max" } })?.value).toBe("default");
    });
});

/* A spec's phase chat: the spec picks the AI, so the box only shows it. */
describe("providerPartsOf in a phase chat", () => {

    const parts = (held: boolean) => providerPartsOf(
        { current: on("sonnet"), choice: choice as never, onPick: () => undefined, locked: true, ...(held ? { held: true } : {}) },
        { running: false, onHandover: () => undefined });

    const disabled = (list: ReturnType<typeof parts>) => Object.fromEntries(list.map(part => [part.id, part.disabled === true]));

    it("locks the model and the effort as well as the runtime", () => {

        expect(disabled(parts(true))).toEqual({ runtime: true, model: true, effort: true });
    });

    it("leaves the model and the effort open in a started chat of your own", () => {

        expect(disabled(parts(false))).toEqual({ runtime: true, model: false, effort: false });
    });
});

describe("pickWith and effort", () => {

    it("keeps the picked effort when the model changes, and drops it when set back to Default", () => {

        const picked = { ...choice, pick: { provider: "claude-cli", model: "default", effort: "high" } };

        expect(pickWith(on("default"), picked, { model: "sonnet" })).toEqual({ provider: "claude-cli", model: "sonnet", effort: "high" });
        expect(pickWith(on("default"), picked, { effort: undefined })).toEqual({ provider: "claude-cli", model: "default" });
    });
});

describe("modelOptionsOf and price", () => {

    it("shows the runtime's price where it has no multiplier", () => {

        const options = modelOptionsOf(on("default"), choice);

        expect(options.find(option => option.id === "sonnet")?.costMultiplier).toBe("$2/$10");
        expect(options.find(option => option.id === "default")?.costMultiplier).toBeUndefined();
    });
});
