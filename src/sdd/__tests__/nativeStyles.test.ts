import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";
import { refusedWrite } from "../../core/agent/providers/AcpProvider";
import { configFromSettings } from "../config/sddConfig";
import { discover } from "../discovery/discover";
import { SpecFiles } from "../discovery/specFiles";
import { ideaOf, lockOf, pipeline } from "../model/style";
import { parseStyle } from "../parser/parseStyle";
import { assemble, PhaseInput } from "../phase/assemble";
import { StyleRegistry } from "../registry/StyleRegistry";
import { StyleFiles } from "../registry/styleFiles";

/**
 * A native style - Kiro's spec mode, Spec Kit's commands - run through
 * the same parser, walk and assembly as an Eesha one. What differs: no
 * Idea phase, no files attached, the stage's own `command:` is the
 * whole message, and the session may not write another phase's
 * document.
 */

const stylesDir = path.resolve(__dirname, "..", "..", "..", "resources", "styles");

const kiro = parseStyle(fs.readFileSync(path.join(stylesDir, "kiro", "style.yml"), "utf8"), "kiro");
const speckit = parseStyle(fs.readFileSync(path.join(stylesDir, "speckit", "style.yml"), "utf8"), "speckit");

/** Native phases never read a style file, so a registry with nothing in it serves. */
const empty = new StyleRegistry({} as StyleFiles);

function input(over: Partial<PhaseInput> = {}): PhaseInput {

    return {
        style: kiro,
        config: configFromSettings(undefined),
        specDir: ".kiro/specs/rate-limits",
        specType: "feature",
        stageId: "design",
        contents: ["requirements.md"],
        ...over
    };
}

const NATIVE = (extra: string) => `
schema: 1
id: n
name: N
desc: A native style written for the test.
native: kiro
specTypes:
  - id: f
    label: F
    stages: [one, two]
stages:
  - id: one
    command: Write one.
${extra}`;

describe("parsing a native style", () => {

    it("has no Idea phase", () => {

        expect(ideaOf(kiro)).toBeUndefined();
        expect(pipeline(kiro, "feature").map(stage => stage.id)).toEqual(["requirements", "design", "tasks", "implement"]);
        expect(pipeline(speckit, "feature").map(stage => stage.id)).toEqual(["specify", "plan", "tasks", "implement"]);
    });

    it("attaches no instruction file to any stage", () => {

        expect(kiro.stages.every(stage => stage.instructions === undefined)).toBe(true);
    });

    it("needs a command on every stage", () => {

        expect(() => parseStyle(NATIVE(""), "n")).toThrow(/'two' has no 'command:'/);
    });

    it("refuses a command on an Eesha style", () => {

        expect(() => parseStyle(`
schema: 1
id: e
name: E
desc: d
specTypes:
  - id: f
    label: F
    stages: [one]
stages:
  - id: one
    command: Write one.
`, "e")).toThrow(/only a native style sends/);
    });

    it("refuses instructions on a native stage", () => {

        expect(() => parseStyle(NATIVE(`  - id: two
    command: Write two.
    instructions: docs/x.md
`), "n")).toThrow(/sends only its 'command:'/);
    });

    it("refuses a phase variable outside a command", () => {

        expect(() => parseStyle(NATIVE(`  - id: two
    label: \${{ phase.target }}
    command: Write two.
`), "n")).toThrow(/outside a stage's 'command:' or 'revise:'/);
    });

    it("refuses a tool it does not know", () => {

        expect(() => parseStyle(NATIVE("  - id: two\n    command: x\n").replace("native: kiro", "native: cursor"), "n"))
            .toThrow(/'kiro' and 'speckit'/);
    });
});

describe("a native phase's message", () => {

    it("is the stage's command, with the documents on disk named", async () => {

        const request = await assemble(input(), empty);

        expect(request.prompt).toContain('Continue working on the "rate-limits" spec. The existing documents are: requirements.md.');
        expect(request.prompt).toContain("Write the design document, design.md, and nothing else");
        expect(request.attachments).toEqual([]);
        expect(request.verbatim).toBe(true);
        expect(request.targets).toEqual([".kiro/specs/rate-limits/design.md"]);
    });

    it("puts the typed text after the command, as typed", async () => {

        const request = await assemble(input({ stageId: "requirements", contents: [], note: "Limit **failed** logins." }), empty);

        expect(request.prompt).toMatch(/^Start a new spec called "rate-limits"\. Create the \.kiro\/specs\/rate-limits\/ directory/);
        expect(request.prompt.trimEnd().endsWith("\n\nLimit **failed** logins.")).toBe(true);
    });

    it("sends a slash command typed in the revise box alone", async () => {

        const request = await assemble({
            ...input({ style: speckit, specDir: "specs/001-login", stageId: "specify", contents: ["spec.md"] }),
            revise: true,
            note: "/speckit.clarify"
        }, empty);

        expect(request.prompt).toBe("/speckit.clarify\n");
    });

    it("asks a revise to change only this phase's document", async () => {

        const request = await assemble(input({ contents: ["requirements.md", "design.md"], revise: true, note: "Use Redis." }), empty);

        expect(request.prompt).toContain('Update `design.md` of the "rate-limits" spec.');
        expect(request.prompt).toContain("Use Redis.");
    });

    it("hands the implement phase its tasks", async () => {

        const request = await assemble(input({
            stageId: "implement",
            contents: ["requirements.md", "design.md", "tasks.md"],
            tasks: [{ id: "1.1", text: "Add the counter" }]
        }), empty);

        expect(request.prompt).toContain("- 1.1 Add the counter");
    });

    it("may not write another phase's document", async () => {

        expect((await assemble(input(), empty)).refuseWrites).toEqual([
            ".kiro/specs/rate-limits/requirements.md",
            ".kiro/specs/rate-limits/tasks.md"
        ]);
    });

    it("leaves the plan writable while implementing, so Kiro ticks its boxes", async () => {

        const request = await assemble(input({
            stageId: "implement",
            contents: ["requirements.md", "design.md", "tasks.md"],
            tasks: [{ id: "1.1", text: "Add the counter" }]
        }), empty);

        expect(request.refuseWrites).toEqual([
            ".kiro/specs/rate-limits/requirements.md",
            ".kiro/specs/rate-limits/design.md"
        ]);
    });
});

describe("the runtime a Kiro phase runs on", () => {

    it("is Kiro in Spec mode, whatever the compose box picked", async () => {

        const config = configFromSettings(undefined, { provider: "ghcp", model: "gpt-5", mode: "agent" });

        const request = await assemble(input({ config }), empty);

        expect(request.ai.args.provider).toBe("kiro-cli-v3");
        expect(request.ai.args.agentMode).toBe("spec");
        expect(request.ai.args.model).not.toBe("gpt-5");
    });

    it("keeps the model picked for Kiro", async () => {

        const config = configFromSettings(undefined, { provider: "kiro-cli-v3", model: "claude-sonnet-4.5", mode: "vibe" });

        const request = await assemble(input({ config }), empty);

        expect(request.ai.args.model).toBe("claude-sonnet-4.5");
        expect(request.ai.args.agentMode).toBe("spec");
    });

    it("is not locked for Spec Kit", () => {

        expect(lockOf(kiro)).toEqual({ provider: "kiro-cli-v3", agentMode: "spec" });
        expect(lockOf(speckit)).toBeUndefined();
    });
});

describe("finding native specs", () => {

    const files = (folders: Record<string, string[]>): SpecFiles => ({
        specs: async () => Object.keys(folders),
        contents: async name => folders[name] ?? [],
        read: async () => undefined,
        modified: async () => 0
    });

    const config = configFromSettings(undefined);

    it("counts every folder under Kiro's own root, empty ones too", async () => {

        const found = await discover(
            { config, styles: [kiro, speckit], root: "/repo/.kiro/specs", label: ".kiro/specs", owner: "kiro" },
            files({ "rate-limits": ["requirements.md"], "just-made": [] }));

        expect(found.map(one => [one.name, one.detection.style, one.state?.next?.id]))
            .toEqual([["just-made", "kiro", "requirements"], ["rate-limits", "kiro", "design"]]);
    });

    it("counts a Spec Kit folder only once it holds one of its documents", async () => {

        const found = await discover(
            { config, styles: [kiro, speckit], root: "/repo/specs", label: "specs", owner: "speckit" },
            files({ "001-login": ["spec.md"], "fixtures": ["a.json"] }));

        expect(found.map(one => one.name)).toEqual(["001-login"]);
    });
});

describe("refusing a write", () => {

    const call = (file: string) => ({ toolCallId: "1", title: "Write File", locations: [{ path: file }] });

    it("names the refused file a request writes", () => {

        expect(refusedWrite(call("/repo/.kiro/specs/x/tasks.md"), ["/repo/.kiro/specs/x/tasks.md"], "/repo", false))
            .toBe("/repo/.kiro/specs/x/tasks.md");
    });

    it("reads a relative path against the working folder", () => {

        expect(refusedWrite(call(".kiro/specs/x/tasks.md"), ["/repo/.kiro/specs/x/tasks.md"], "/repo", false))
            .toBe(".kiro/specs/x/tasks.md");
    });

    it("lets every other file through", () => {

        expect(refusedWrite(call("/repo/.kiro/specs/x/design.md"), ["/repo/.kiro/specs/x/tasks.md"], "/repo", false))
            .toBeUndefined();
        expect(refusedWrite(call("/repo/a.md"), [], "/repo", false)).toBeUndefined();
    });
});
