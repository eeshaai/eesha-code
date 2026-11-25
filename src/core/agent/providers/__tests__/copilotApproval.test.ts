import { describe, expect, it } from "vitest";

import { approvalPermission } from "../copilotApproval";
import { sessionConfig } from "../CopilotProvider";

describe("approvalPermission", () => {

    it("names the tool and what it would be given", () => {

        expect(approvalPermission({ kind: "shell", fullCommandText: "npm test" } as never)).toEqual({ tool: "shell", input: "npm test" });
        expect(approvalPermission({ kind: "read", path: "C:/repo/a.ts" } as never)).toEqual({ tool: "read", input: "C:/repo/a.ts" });
        expect(approvalPermission({ kind: "mcp", toolTitle: "Search", args: { q: 1 } } as never).tool).toBe("Search");
    });
});

describe("the permission handler with no check of our own", () => {

    const BASE = { workingDirectory: "C:/repo", env: {} };

    it("allows once without asking", async () => {

        const handler = sessionConfig({ ...BASE, interactive: true }).onPermissionRequest!;

        expect(await handler({ kind: "read", path: "C:/repo/src/app.ts", intention: "" } as never, { sessionId: "s" }))
            .toEqual({ kind: "approve-once" });
    });

    it("refuses a path outside the folders", async () => {

        const handler = sessionConfig({ ...BASE, interactive: true }).onPermissionRequest!;

        const decision = await handler({ kind: "read", path: "C:/elsewhere/keys.txt" } as never, { sessionId: "s" });

        expect((decision as { kind: string }).kind).toBe("reject");
    });
});
