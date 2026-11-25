// eslint-disable-next-line import/no-unassigned-import
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { oneLine } from "../runtimeVersion";

describe("runtimeVersion", () => {

    it("takes the first line with text of what a program printed, cut short", () => {

        expect(oneLine("2.1.4 (Claude Code)\n")).toBe("2.1.4 (Claude Code)");
        expect(oneLine("\r\n  \r\nkiro-cli 1.20.0\r\nmore")).toBe("kiro-cli 1.20.0");
        expect(oneLine("x".repeat(200))).toHaveLength(80);
        expect(oneLine("  \n ")).toBeUndefined();
    });
});
