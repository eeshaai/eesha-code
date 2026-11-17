import { defineConfig } from "@playwright/test";

/**
 * Browser tests of Eesha Code's own page.
 *
 * Each test file starts the built server (`dist/cli.js run`) on a
 * throwaway home folder, with the fake runtime turned on, so no model is
 * called and no real profile is touched. See e2e/eesha.ts.
 *
 * Build first: `npm run test:e2e` does.
 */
export default defineConfig({

    testDir: "e2e",

    // One server per test file; files run one after another, so two
    // servers never fight over the machine.
    workers: 1,

    fullyParallel: false,

    timeout: 60_000,

    expect: { timeout: 10_000 },

    use: {

        // Kept on failure only.
        trace: "retain-on-failure",
        screenshot: "only-on-failure"
    },

    reporter: [["list"]]
});
