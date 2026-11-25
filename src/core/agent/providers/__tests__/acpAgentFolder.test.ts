import { describe, expect, it } from "vitest";

import { extraFolders, loadSession, AcpAgentContext } from "../AcpProvider";

/* The chat's other folders an ACP agent is told about. Kiro fails every edit to a file outside all of them. */
describe("extraFolders", () => {

    it("gives every other folder but the working one", () => {

        expect(extraFolders("C:\\workspace\\app_v1", ["C:\\workspace\\app_v1", "C:\\workspace\\app_v2", "D:\\shared"], true))
            .toEqual(["C:\\workspace\\app_v2", "D:\\shared"]);
    });

    it("treats a folder that differs only in case or a trailing slash as the working one on Windows", () => {

        expect(extraFolders("C:\\workspace\\app_v1", ["c:\\workspace\\app_v1\\", "c:\\workspace\\APP_V2", "C:\\workspace\\app_v2"], true))
            .toEqual(["c:\\workspace\\APP_V2"]);
    });

    it("drops empty and relative entries", () => {

        expect(extraFolders("C:\\a", ["", "relative\\b"], true)).toEqual([]);
    });
});

describe("loadSession", () => {

    const context = () => {

        const sent: unknown[] = [];

        const ctx = {
            request: async (_method: string, params: unknown) => {

                sent.push(params);

                return {};
            },
            attachSession: (response: unknown) => response
        } as unknown as AcpAgentContext;

        return { ctx, sent };
    };

    it("sends the other open folders with the load", async () => {

        const { ctx, sent } = context();

        await loadSession(ctx, "sess-1", "C:\\a", [], ["C:\\b"]);

        expect(sent).toEqual([{ sessionId: "sess-1", cwd: "C:\\a", additionalDirectories: ["C:\\b"], mcpServers: [] }]);
    });

    it("sends no folder list when there are none", async () => {

        const { ctx, sent } = context();

        await loadSession(ctx, "sess-1", "C:\\a", []);

        expect(sent).toEqual([{ sessionId: "sess-1", cwd: "C:\\a", mcpServers: [] }]);
    });
});
