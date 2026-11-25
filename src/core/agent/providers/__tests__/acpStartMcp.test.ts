import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { localMcpServers, startMcpFile } from "../AcpProvider";
import { extensionsFor } from "../acpExtensions";
import type { AcpLocalMcpServer } from "../acpExtensions";
import { copilotCliExtension, copilotMcpConfig } from "../copilotCliAcpExtension";

/*
 * Copilot CLI over ACP refuses a local tool server sent at `session/new`.
 * It gets them in a file when it starts instead - see
 * `AcpExtension.startMcpServers`.
 */

const SERVER: AcpLocalMcpServer = {
    type: "stdio",
    name: "eesha-connectors",
    command: "C:\\node\\node.exe",
    args: ["C:\\eesha\\cli.js", "mcp", "--chat", "chat-1"],
    env: [{ name: "TOKEN", value: "abc" }]
};

const made: string[] = [];

afterEach(() => {

    for (const folder of made.splice(0))
        fs.rmSync(folder, { recursive: true, force: true });
});

describe("localMcpServers", () => {

    it("keeps the servers that are programs and leaves out the ones reached over the web", () => {

        const servers = localMcpServers({
            servers: {
                ado: { command: "npx", args: ["ado"] },
                remote: { type: "http", url: "https://example.com" },
                feed: { type: "sse", url: "https://example.com/feed" }
            }
        }, "", false);

        expect(servers).toEqual([{ type: "stdio", name: "ado", command: "npx", args: ["ado"], env: [] }]);
    });
});

describe("copilotMcpConfig", () => {

    it("writes the servers in the shape of Copilot's own mcp-config.json", () => {

        expect(JSON.parse(copilotMcpConfig([SERVER]))).toEqual({
            mcpServers: {
                "eesha-connectors": {
                    type: "local",
                    command: "C:\\node\\node.exe",
                    args: ["C:\\eesha\\cli.js", "mcp", "--chat", "chat-1"],
                    env: { TOKEN: "abc" },
                    tools: ["*"]
                }
            }
        });
    });

    it("names the file with Copilot's start option", () => {

        expect(copilotCliExtension.startMcpServers?.([SERVER]).args("C:\\temp\\mcp-config.json"))
            .toEqual(["--additional-mcp-config", "@C:\\temp\\mcp-config.json"]);
    });
});

describe("startMcpFile", () => {

    it("writes the file for Copilot and says the arguments that name it", async () => {

        const start = await startMcpFile(extensionsFor(["copilot-cli"]), [SERVER]);

        expect(start).toBeDefined();
        made.push(start!.folder);

        const file = path.join(start!.folder, "mcp-config.json");

        expect(path.dirname(start!.folder)).toBe(os.tmpdir());
        expect(start!.args).toEqual(["--additional-mcp-config", `@${file}`]);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["eesha-connectors"].command).toBe("C:\\node\\node.exe");
    });

    it("writes nothing with no local server", async () => {

        expect(await startMcpFile(extensionsFor(["copilot-cli"]), [])).toBeUndefined();
    });

    it("writes nothing for a runtime that takes its servers at session/new", async () => {

        expect(await startMcpFile(extensionsFor(["kiro-v3"]), [SERVER])).toBeUndefined();
        expect(await startMcpFile(extensionsFor(["claude-cli"]), [SERVER])).toBeUndefined();
        expect(await startMcpFile([], [SERVER])).toBeUndefined();
    });
});
