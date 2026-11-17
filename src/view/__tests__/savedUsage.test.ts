import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { EventWriter } from "../../core/events/EventWriter";
import { currentEvents, isControl, lineFrom, parseEvents } from "../../core/events/runEvents";
import { LogLine } from "../../core/models/run";
import { usageFrom } from "../ChatView";

/*
 * A run's usage as it was saved, read back the way the panel
 * reads any run.
 *
 * The file under fixtures/ is frozen: it is what the event writer wrote
 * for one run - charges, per-model figures, context windows and account
 * usage, plus one account in a shape the panel does not draw and one
 * charge with no runtime recorded. Never edit it to make a test pass.
 *
 * If one of these fails, a change has made saved records read differently.
 * The rule: a saved field is only ever added,
 * never renamed or removed, and a new one is always optional.
 */

const FIXTURE = path.join(__dirname, "fixtures", "saved-run.jsonl");

function savedLines(): LogLine[] {

    return currentEvents(parseEvents(fs.readFileSync(FIXTURE, "utf8")))
        .map(event => lineFrom(event))
        .filter((line): line is LogLine => line !== undefined);
}

describe("usage read back from a saved run", () => {

    const usage = usageFrom(savedLines());

    it("adds the charges up per runtime, and keeps an unnamed one apart", () => {

        expect(usage.session).toEqual([
            { amount: 1.25, unit: "credits", runtime: "ghcp" },
            { amount: 0.1, unit: "credits" },
            { amount: 0.5, unit: "credits", runtime: "kiro-cli" }
        ]);
    });

    it("adds the per-model figures up, each model on its own runtime", () => {

        expect(usage.sessionModels.map(one => [one.model, one.runtime, one.inputTokens, one.outputTokens])).toEqual([
            ["gpt-5", "ghcp", 120000, 8000],
            ["claude-haiku-4-5", "ghcp", 30000, 2000],
            ["claude-sonnet-5", "kiro-cli", 50000, 10000]
        ]);
    });

    it("takes the newest charge as the last turn's", () => {

        expect(usage.last).toEqual([{ amount: 0.5, unit: "credits", runtime: "kiro-cli" }]);
        expect(usage.lastModels?.map(one => one.model)).toEqual(["claude-sonnet-5"]);
    });

    it("takes the newest context window", () => {

        expect(usage.context).toEqual({ used: 120000, size: 967000 });
    });

    it("reads the account with rows and skips the one without", () => {

        expect(usage.accounts).toHaveLength(1);
        expect(usage.accounts[0].runtime).toBe("kiro-cli");
        expect(usage.accounts[0].rows.map(row => row.key)).toEqual(["Plan", "Credits used", "Overage charge"]);
    });
});

describe("the writer writes what the saved run holds", () => {

    const made: string[] = [];

    afterEach(() => {

        for (const dir of made.splice(0))
            fs.rmSync(dir, { recursive: true, force: true });
    });

    /*
     * The same lines, written again by the writer. Every field of every
     * saved line must come out under the same name with the same value - a
     * field renamed in the writer shows up here as a difference.
     */
    it("writes every saved log line back field for field", () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-saved-"));
        made.push(dir);

        const writer = new EventWriter(path.join(dir, "events.jsonl"), "sdd:.eesha/specs/demo");

        for (const line of savedLines())
            writer.log(line);

        const written = writer.read().filter(event => !isControl(event));
        const saved = parseEvents(fs.readFileSync(FIXTURE, "utf8")).filter(event => !isControl(event));

        expect(written).toEqual(saved);
    });
});
