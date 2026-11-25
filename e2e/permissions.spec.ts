import * as fs from "fs";
import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, type Eesha, pickRuntime, SESSION_ADDRESS, startEesha } from "./eesha";

/*
 * Permission cards on the fake runtime. A message with "fake write"
 * makes it write fake-note.txt in the workspace folder, through the same
 * permission check a real runtime's edit goes through.
 */

let eesha: Eesha;

test.beforeAll(async ({ browser }) => {

    eesha = await startEesha();

    const page = await browser.newPage();

    await page.goto(eesha.url);
    await addWorkspace(page, eesha.work);
    await page.close();
});

test.afterAll(async () => {

    await eesha?.stop();
});

test.beforeEach(() => {

    fs.rmSync(path.join(eesha.work, "fake-note.txt"), { force: true });
});

/** Opens a fake session in the workspace at `level`, and sends "fake write". */
async function fakeWrite(page: Page, level: string): Promise<void> {

    await page.goto(eesha.url);

    await page.locator("select").filter({ has: page.locator("option", { hasText: "No workspace" }) }).selectOption({ label: "work" });
    await pickRuntime(page, "fake");

    await page.getByRole("button", { name: /^Permissions:/ }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${level}`) }).click();
    await expect(page.getByRole("button", { name: `Permissions: ${level}` })).toBeVisible();

    await page.getByRole("textbox", { name: "What do you want to do?" }).fill("fake write");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(SESSION_ADDRESS);

    await page.getByRole("button", { name: "Send message" }).click();
}

test("at Auto the write runs with no card", async ({ page }) => {

    await fakeWrite(page, "Auto");

    await expect(page.getByRole("main").getByText("Wrote fake-note.txt.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

    expect(fs.existsSync(path.join(eesha.work, "fake-note.txt"))).toBe(true);
});

test("at Agent's Choice a card asks, and Allow once writes the file", async ({ page }) => {

    await fakeWrite(page, "Agent's Choice");

    await page.getByRole("button", { name: "Allow once" }).click();

    await expect(page.getByRole("main").getByText("Wrote fake-note.txt.")).toBeVisible();

    expect(fs.existsSync(path.join(eesha.work, "fake-note.txt"))).toBe(true);
});

test("at Agent's Choice, Deny writes nothing", async ({ page }) => {

    await fakeWrite(page, "Agent's Choice");

    await page.getByRole("button", { name: "Deny" }).click();

    await expect(page.getByRole("main").getByText(/Did not write fake-note\.txt/)).toBeVisible();

    expect(fs.existsSync(path.join(eesha.work, "fake-note.txt"))).toBe(false);
});
