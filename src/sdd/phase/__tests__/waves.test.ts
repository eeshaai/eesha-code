import { describe, expect, it } from "vitest";
import { conflicts, splitWave, wavesOf } from "../waves";

const task = (id: string, wave?: number) => ({ id, text: id, wave });

describe("wavesOf", () => {

    it("groups by wave, waves in ascending order whatever order the tasks came in", () => {

        const waves = wavesOf([task("3.1", 1), task("1.1", 0), task("1.3", 0), task("2.1", 1)]);

        expect(waves.map(wave => wave.map(one => one.id))).toEqual([["1.1", "1.3"], ["3.1", "2.1"]]);
    });

    /* A plan with no graph: one wave, in the order handed - Next hands the agent all of it, not one task. */
    it("makes a plan with no graph one wave", () => {

        const waves = wavesOf([task("1.1"), task("1.2"), task("2.1")]);

        expect(waves.map(wave => wave.map(one => one.id))).toEqual([["1.1", "1.2", "2.1"]]);
    });

    /* A task the graph left out is worked after the graphed ones, alone. */
    it("puts the ungraphed tasks after the graphed ones", () => {

        const waves = wavesOf([task("9.9"), task("1.1", 0), task("2.1", 1)]);

        expect(waves.map(wave => wave.map(one => one.id))).toEqual([["1.1"], ["2.1"], ["9.9"]]);
    });

    /* The no-graph wave still stops at a task that is not the agent's: N runs to the first Run: or by-hand task. */
    it("cuts a no-graph plan's chat at its first Run: task", () => {

        const tasks: { id: string; wave?: number; run?: unknown }[] =
            [task("1.1"), task("1.2"), { ...task("1.3"), run: { kind: "manual" } }, task("2.1")];

        const steps = wavesOf(tasks).flatMap(wave => splitWave(wave));

        expect(steps.map(step => step.map(one => one.id))).toEqual([["1.1", "1.2"], ["1.3"], ["2.1"]]);
    });

    it("is empty for nothing", () => {

        expect(wavesOf([])).toEqual([]);
    });
});

describe("splitWave", () => {

    const agent = (id: string): { id: string; run?: unknown } => ({ id });
    const run = (id: string) => ({ id, run: { kind: "manual" } });

    it("keeps a wave of agent tasks as one chat", () => {

        expect(splitWave([agent("1.1"), agent("1.2")]).map(step => step.map(task => task.id)))
            .toEqual([["1.1", "1.2"]]);
    });

    it("gives each Run: task a step of its own, in the plan's order", () => {

        expect(splitWave([run("2.1"), agent("2.2"), agent("2.3"), run("2.4")]).map(step => step.map(task => task.id)))
            .toEqual([["2.1"], ["2.2", "2.3"], ["2.4"]]);
    });

    it("splits agent tasks a Run: task sits between into two chats", () => {

        expect(splitWave([agent("3.1"), run("3.2"), agent("3.3")]).map(step => step.map(task => task.id)))
            .toEqual([["3.1"], ["3.2"], ["3.3"]]);
    });

    it("is empty for an empty wave", () => {

        expect(splitWave([])).toEqual([]);
    });
});

describe("conflicts", () => {

    const files: Record<string, string[]> = {
        "1.1": ["src/a.ts", "src/shared.ts"],
        "1.2": ["src/b.ts", "src/shared.ts"],
        "1.3": ["src/c.ts"],
        "1.4": []
    };

    const filesOf = (id: string) => files[id] ?? [];

    it("names every path two tasks of the wave both touch, and who touches it", () => {

        expect(conflicts([task("1.1"), task("1.2"), task("1.3")], filesOf))
            .toEqual([{ path: "src/shared.ts", tasks: ["1.1", "1.2"] }]);
    });

    it("is empty when every task names different files", () => {

        expect(conflicts([task("1.1"), task("1.3")], filesOf)).toEqual([]);
    });

    /* Nothing said is nothing to check - the grammar's own rule puts such a task alone. */
    it("does not count a task with no Files line against anything", () => {

        expect(conflicts([task("1.1"), task("1.4")], filesOf)).toEqual([]);
    });
});
