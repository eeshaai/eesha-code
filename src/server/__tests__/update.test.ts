// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { isNewerVersion } from "../protocol";
import { isVersion } from "../update";

describe("isVersion", () => {

    it("takes what npm installs", () => {

        expect(isVersion("0.1.7")).toBe(true);
        expect(isVersion("1.20.300")).toBe(true);
        expect(isVersion("1.2.3-beta.1")).toBe(true);
    });

    it("refuses anything that could add to the install command", () => {

        expect(isVersion("1.2")).toBe(false);
        expect(isVersion("latest")).toBe(false);
        expect(isVersion("1.2.3 && del x")).toBe(false);
        expect(isVersion("1.2.3;x")).toBe(false);
        expect(isVersion(undefined)).toBe(false);
        expect(isVersion(123)).toBe(false);
    });
});

describe("isNewerVersion", () => {

    it("compares the numbers, not the text", () => {

        expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
        expect(isNewerVersion("0.2.0", "0.1.99")).toBe(true);
        expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
        expect(isNewerVersion("0.1.7", "0.1.7")).toBe(false);
        expect(isNewerVersion("0.1.6", "0.1.7")).toBe(false);
    });

    it("puts a release after its pre-release", () => {

        expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
        expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
        expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
    });
});
