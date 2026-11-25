import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, type Eesha, openSection, SESSION_ADDRESS, startEesha } from "./eesha";

/*
 * The Git and File explorer sections of the workspace panel, on a
 * session in a workspace whose folder is a git repository.
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

/** Starts an empty session in the workspace. */
async function openSession(page: Page): Promise<void> {

    await page.goto(eesha.url);
    await page.locator("select").filter({ has: page.locator("option", { hasText: "No workspace" }) }).selectOption({ label: "work" });
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(SESSION_ADDRESS);
}

test("the Git section lists a new file, shows its diff, and commits it", async ({ page }) => {

    fs.writeFileSync(path.join(eesha.work, "hello.txt"), "Hello from the test.\n");

    await openSession(page);
    await openSection(page, "Git");

    const file = page.getByRole("button", { name: /hello\.txt/ }).first();

    await expect(file).toBeVisible();

    await file.click();
    await expect(page.getByText("Hello from the test.").first()).toBeVisible();

    await page.getByRole("textbox", { name: "Commit message for work" }).fill("Add hello");
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    await page.getByRole("dialog", { name: "Confirm" }).getByRole("button", { name: "Stage all and commit" }).click();

    await expect.poll(() => execFileSync("git", ["log", "-1", "--format=%s"], { cwd: eesha.work, encoding: "utf8" }).trim()).toBe("Add hello");

    // Nothing is left to commit, and the section says so.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: eesha.work, encoding: "utf8" })).toBe("");
    await expect(page.getByText("Staged")).toHaveCount(0);
});

test("the file explorer opens a file", async ({ page }) => {

    await openSession(page);
    await openSection(page, "Files");

    await page.getByText("readme.txt", { exact: true }).first().click();

    await expect(page.getByText("A test repository.").first()).toBeVisible();
});
