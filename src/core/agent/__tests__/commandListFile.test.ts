import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
    commandListPath, commandNameIn, commandsFrom, keepCommandList, offeredCommands, readCommandList, refusedCommandText
} from "../commandListFile";

/*
 * Each runtime's slash commands, kept in a file so the compose box lists
 * them at once in a new chat, with nothing fetched and nothing waited for.
 */

function temporaryRoot(): string {

    return fs.mkdtempSync(path.join(os.tmpdir(), "eesha-commands-"));
}

describe("commandsFrom", () => {

    it("reads the ACP shape, with the hint from its input", () => {

        expect(commandsFrom([
            { name: "compact", description: " Shrink the chat ", input: { hint: "<instructions>" } },
            { name: "clear", description: "", input: null }
        ])).toEqual([
            { name: "compact", description: "Shrink the chat", hint: "<instructions>" },
            { name: "clear" }
        ]);
    });

    it("reads Claude's shape, and bare names", () => {

        expect(commandsFrom([{ name: "review", description: "Review", argumentHint: "<pr>" }, "init"]))
            .toEqual([{ name: "review", description: "Review", hint: "<pr>" }, { name: "init" }]);
    });

    it("drops a leading slash, and skips what has no usable name", () => {

        expect(commandsFrom(["/compact", { name: "two words" }, { description: "no name" }, null, 7, ""]))
            .toEqual([{ name: "compact" }]);
    });

    it("gives nothing for anything that is not a list", () => {

        expect(commandsFrom(undefined)).toEqual([]);
        expect(commandsFrom({ name: "compact" })).toEqual([]);
    });
});

describe("offeredCommands", () => {

    it("leaves out the refused ones in any case, keeps each name once, A to Z", () => {

        expect(offeredCommands(
            [{ name: "review" }, { name: "Permissions" }, { name: "compact", description: "first" }, { name: "compact", description: "again" }],
            ["permissions"]
        )).toEqual([{ name: "compact", description: "first" }, { name: "review" }]);
    });
});

describe("commandNameIn", () => {

    it("names the command a message starts with, in lower case", () => {

        expect(commandNameIn("/Add-Dir C:\\")).toBe("add-dir");
        expect(commandNameIn("  /compact")).toBe("compact");
    });

    it("names nothing for a slash later in the text, or a path", () => {

        expect(commandNameIn("please run /permissions")).toBeUndefined();
        expect(commandNameIn("//server/share")).toBeUndefined();
    });

    it("says why a refused one was not sent", () => {

        expect(refusedCommandText("permissions")).toContain("'/permissions' was not sent");
        expect(refusedCommandText("remote", "it does something else.")).toBe("'/remote' was not sent: it does something else.");
    });
});

describe("the kept list", () => {

    it("is written once, read back, and not written again for the same list", async () => {

        const root = temporaryRoot();
        const commands = [{ name: "compact", description: "Shrink the chat", hint: "<instructions>" }];

        await keepCommandList("claude", commands, root);

        const file = commandListPath("claude", root);

        expect(await readCommandList("claude", root)).toEqual(commands);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).about).toContain("edits here do not last");

        const before = fs.statSync(file).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 20));
        await keepCommandList("claude", commands, root);

        expect(fs.statSync(file).mtimeMs).toBe(before);
        expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    });

    it("is replaced by a different list, and kept as it was when an empty one comes", async () => {

        const root = temporaryRoot();

        await keepCommandList("kiro-cli", [{ name: "a" }], root);
        await keepCommandList("kiro-cli", [{ name: "b" }], root);
        await keepCommandList("kiro-cli", [], root);

        expect(await readCommandList("kiro-cli", root)).toEqual([{ name: "b" }]);
    });

    it("is empty for a runtime that never sent one, and for a broken file", async () => {

        const root = temporaryRoot();

        expect(await readCommandList("copilot-cli", root)).toEqual([]);

        fs.mkdirSync(path.dirname(commandListPath("copilot-cli", root)), { recursive: true });
        fs.writeFileSync(commandListPath("copilot-cli", root), "{ not json");

        expect(await readCommandList("copilot-cli", root)).toEqual([]);
    });

    it("never throws when it cannot be written", async () => {

        const root = temporaryRoot();
        const blocker = path.join(root, "a-file");

        fs.writeFileSync(blocker, "not a folder");

        await expect(keepCommandList("claude", [{ name: "compact" }], path.join(blocker, "inside"))).resolves.toBeUndefined();
    });
});
