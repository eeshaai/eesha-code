import * as fs from "fs";
import * as path from "path";

import { expect, test } from "@playwright/test";

import { consoleErrors, type Eesha, startEesha } from "./eesha";

/*
 * The settings pages. Only what is saved in the throwaway home is
 * changed. The Connect windows are not opened: they would sign in with
 * this machine's real az and gh accounts.
 */

let eesha: Eesha;

test.beforeAll(async () => {

    eesha = await startEesha();
});

test.afterAll(async () => {

    await eesha?.stop();
});

/** The saved settings file, read again. */
function saved(): { eesha?: { theme?: string; fontSize?: number } } {

    return JSON.parse(fs.readFileSync(path.join(eesha.home, ".eesha", "settings.json"), "utf8"));
}

test("General saves the look and the text size", async ({ page }) => {

    const errors = consoleErrors(page);

    await page.goto(eesha.url);
    await page.goto(`${eesha.origin}/settings/general`);

    await page.getByText("Light", { exact: true }).click();
    await expect.poll(() => saved().eesha?.theme).toBe("light");

    await page.getByText("A+", { exact: true }).click();
    await expect.poll(() => saved().eesha?.fontSize).toBe(17);

    await page.getByText("Reset to 16px").click();
    await expect.poll(() => saved().eesha?.fontSize ?? 16).toBe(16);

    expect(errors).toEqual([]);
});

test("every settings section opens", async ({ page }) => {

    test.setTimeout(120_000);

    const errors = consoleErrors(page);

    await page.goto(eesha.url);
    await page.goto(`${eesha.origin}/settings/general`);

    for (const [link, address] of [
        ["Runtimes", "/settings/runtimes"],
        ["Features (Experimental)", "/settings/features"],
        ["Storage", "/settings/storage"],
        ["Connectors", "/settings/connectors"]
    ] as const) {

        await page.getByRole("link", { name: link, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${address}$`));
        await expect(page.getByRole("main").getByText(link === "Features (Experimental)" ? /Features/ : link).first()).toBeVisible();
    }

    // The connectors page checks the az and gh sign-ins first, which can take a while.
    await expect(page.getByRole("main").getByText("Azure DevOps").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("main").getByText("GitHub").first()).toBeVisible({ timeout: 60_000 });

    expect(errors).toEqual([]);
});
