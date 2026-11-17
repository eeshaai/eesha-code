import { addModelSpend, addSpend, type ModelSpend, type Spend } from "../core/models/run";

/**
 * The figures behind the usage card's tables: one cell per runtime and
 * model, and the columns a set of rows needs.
 *
 * Kept apart from ChatView so the adding up can be tested without
 * drawing anything.
 */

/**
 * One row of the spec's Totals table - a phase, or one chat of a phase
 * (`lane`) drawn under it. `cost` and `models` are everything the row
 * charged, the drafts a re-run took off the screen included.
 */
export interface UsageLine {
    label: string;

    /** A chat inside the phase above it - Wave 2, Task 1.4 - drawn indented. */
    lane?: boolean;

    cost: Spend[];

    models: ModelSpend[];
}

/** One column of a table: a model on a runtime. `model` is empty for charges the runtime did not split by model. */
export interface UsageColumn {
    runtime?: string;
    model: string;
}

/**
 * One cell per runtime and model: the models as reported, plus, for a
 * runtime whose models carry no cost of their own, its charges in a
 * cell with no model name.
 *
 * Kiro is the reason. It sends what a turn charged and never which
 * model it was for. Its bills carry the session's model (see
 * `AcpEventTranslator.model`), but an agent that lists no models has
 * no model to sit under. Copilot and
 * Claude put the cost on each model as well as on the turn, so for
 * them the turn's charges are the same money again and are left out.
 */
export function usageCells(cost: readonly Spend[], models: readonly ModelSpend[]): ModelSpend[] {

    const cells = models.map(model => ({ ...model }));

    const runtimes = new Set(cost.map(spend => spend.runtime));

    for (const runtime of runtimes) {

        const priced = models.some(model => model.runtime === runtime && model.cost?.length);

        if (priced)
            continue;

        const charges = cost.filter(spend => spend.runtime === runtime);

        cells.push({ model: "", runtime, cost: addSpend([], charges) });
    }

    return cells;
}

/**
 * The columns every row needs, grouped by runtime: runtimes in the
 * order they first appear, and each runtime's models in the order they
 * first appear. The column with no model name comes last in its group.
 */
export function usageColumns(rows: readonly (readonly ModelSpend[])[]): UsageColumn[] {

    const runtimes: (string | undefined)[] = [];
    const models = new Map<string | undefined, string[]>();

    for (const cells of rows) {

        for (const cell of cells) {

            if (!models.has(cell.runtime)) {

                runtimes.push(cell.runtime);
                models.set(cell.runtime, []);
            }

            const names = models.get(cell.runtime)!;

            if (!names.includes(cell.model))
                names.push(cell.model);
        }
    }

    return runtimes.flatMap(runtime => {

        const names = models.get(runtime)!;

        const ordered = [...names.filter(name => name !== ""), ...names.filter(name => name === "")];

        return ordered.map(model => ({ runtime, model }));
    });
}

/** The cell a row has for a column, or nothing when that model did not run there. */
export function usageCell(cells: readonly ModelSpend[], column: UsageColumn): ModelSpend | undefined {

    return cells.find(cell => cell.runtime === column.runtime && cell.model === column.model);
}

/** Several cells added into one - a runtime's total, or the spec's row. */
export function sumCells(cells: readonly ModelSpend[], model = "", runtime?: string): ModelSpend {

    return addModelSpend([], cells.map(cell => ({ ...cell, model, runtime })))[0] ?? { model, runtime };
}

/** What one owner of a spec's lines - a phase, or one of its chats - holds. */
export interface OwnerLog {
    lines: readonly { cost?: Spend[]; models?: ModelSpend[] }[];

    /** What earlier runs charged - the drafts a re-run or New Session took off the screen. */
    spent?: readonly Spend[];

    spentModels?: readonly ModelSpend[];
}

/**
 * The Totals table's rows for a spec: every phase in pipeline order,
 * run or not, each with its chats (`implement@wave:2`) under it. An
 * owner whose phase is no longer in the style keeps a row of its own at
 * the end - a style edit must not hide what was spent.
 *
 * Each owner counts what it hides (`spent`) plus what is on screen, so
 * a phase's row is every run of it, not just the one open now.
 */
export function phaseLines(
    stages: readonly { name: string; label?: string }[],
    logs: Readonly<Record<string, OwnerLog>>,
    laneLabel: (owner: string) => string
): UsageLine[] {

    const spentBy = (owner: string) => {

        const log = logs[owner];

        let cost: Spend[] = log?.spent?.length ? addSpend([], log.spent) : [];
        let models: ModelSpend[] = log?.spentModels?.length ? addModelSpend([], log.spentModels) : [];

        for (const line of log?.lines ?? []) {

            if (line.cost?.length)
                cost = addSpend(cost, line.cost);

            if (line.models?.length)
                models = addModelSpend(models, line.models);
        }

        return { cost, models };
    };

    const stageOf = (owner: string) => owner.includes("@") ? owner.slice(0, owner.indexOf("@")) : owner;

    const names = [
        ...stages.map(stage => stage.name),
        ...Object.keys(logs).map(stageOf).filter((name, index, all) => all.indexOf(name) === index && !stages.some(stage => stage.name === name))
    ];

    return names.flatMap(name => {

        const lanes = Object.keys(logs).filter(owner => owner.startsWith(`${name}@`));

        const parts = [name, ...lanes].map(spentBy);

        const row: UsageLine = {
            label: stages.find(stage => stage.name === name)?.label ?? name,
            cost: parts.reduce<Spend[]>((total, part) => addSpend(total, part.cost), []),
            models: parts.reduce<ModelSpend[]>((total, part) => addModelSpend(total, part.models), [])
        };

        return [row, ...lanes.map(owner => ({ label: laneLabel(owner), lane: true, ...spentBy(owner) }))];
    });
}

/** Every row's cells added up per runtime and model - the Spec row. */
export function totalCells(rows: readonly (readonly ModelSpend[])[]): ModelSpend[] {

    return rows.reduce<ModelSpend[]>((total, cells) => addModelSpend(total, cells), []);
}
