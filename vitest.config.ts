import * as fs from "fs";
import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({

    // SDD's prompt files, compiled in by build.js; the tests need the same.
    define: {

        __SDD_PROMPTS__: JSON.stringify(
            Object.fromEntries(["first", "first-note", "rewrite", "rewrite-note", "implement"].map(mode =>
                [mode, fs.readFileSync(path.resolve(__dirname, "resources/styles/custom/prompts", mode + ".md"), "utf8")])))
    },

    resolve: {

        dedupe: ["react", "react-dom"]
    },

    test: {

        testTimeout: 30_000,

        include: ["src/**/*.test.{ts,tsx}"],

        // Gives every test file a throwaway home folder, so no test touches
        // the real profile of whoever runs the suite.
        setupFiles: ["src/__tests__/setup.ts"],

        coverage: {

            provider: "v8",

            reporter: ["text-summary", "html", "json-summary", "lcov"],

            reportsDirectory: "coverage",

            include: ["src/**/*.{ts,tsx}"],

            exclude: [
                "src/**/__tests__/**",
                "src/**/__mocks__/**",
                "src/**/*.d.ts"
            ]
        }
    }
});
