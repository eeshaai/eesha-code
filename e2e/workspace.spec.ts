import * as path from "path";

import { expect, test } from "@playwright/test";

import { addWorkspace, consoleErrors, type Eesha, startEesha } from "./eesha";

/*
 * A workspace's own page: opened from its name in the session list, it
 * survives a reload, starts a session in the workspace, makes a spec,
 * lists it under Recent specs, and Spec explorer opens on the right.
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

test("the workspace's name opens its page, which survives a reload", async ({ page }) => {

    const errors = consoleErrors(page);
    const name = path.basename(eesha.work);

    await page.goto(eesha.url);
    await page.getByRole("button", { name: "AI sessions" }).click();

    const list = page.getByRole("navigation", { name: "Sessions" });

    // The arrow opens and closes the list; it does not leave the page.
    const arrow = list.getByRole("button", { name: new RegExp(`^(Open|Close) ${name}$`) }).first();
    const before = await arrow.getAttribute("aria-expanded");

    await arrow.click();
    await expect(arrow).not.toHaveAttribute("aria-expanded", before ?? "");
    await expect(page).not.toHaveURL(/\/workspace/);

    await list.getByRole("link", { name, exact: true }).first().click();
    await expect(page).toHaveURL(/\/workspace\?workspace=/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByRole("region", { name: "Recent specs" })).toContainText("No specs here yet.");
    await expect(page.getByRole("region", { name: "Recent sessions" })).toContainText("No sessions here yet.");

    expect(errors).toEqual([]);
});

test("a spec made from the page shows under Recent specs, and Spec explorer opens on the right", async ({ page }) => {

    const name = path.basename(eesha.work);

    await page.goto(eesha.url);
    await page.getByRole("button", { name: "AI sessions" }).click();
    await page.getByRole("navigation", { name: "Sessions" }).getByRole("link", { name, exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    await page.getByRole("button", { name: /New spec/ }).click();

    const dialog = page.getByRole("dialog");

    await dialog.getByRole("textbox", { name: "The ask" }).fill("Add a greeting");
    await dialog.getByRole("textbox", { name: "Spec name" }).fill("greeting");
    await dialog.getByRole("button", { name: "Create" }).click();

    // The spec opens as a tab beside the page, and the address carries it.
    await expect(page).toHaveURL(/[?&]spec=greeting/);
    await expect(page.getByRole("region", { name: "Editor" }).getByRole("tab", { name: /greeting/ })).toBeVisible();
    // No chat has started yet: its link opens the spec as a tab on this
    // page, not through the older spec address.
    await expect(page.getByRole("region", { name: "Recent specs" }).getByRole("link", { name: /greeting/ }))
        .toHaveAttribute("href", /^\/workspace\?workspace=[^&]+&spec=greeting$/);

    await page.getByRole("button", { name: /Spec explorer/ }).first().click();
    await expect(page.getByRole("region", { name: "Spec explorer" })).toBeVisible();

    // Maximize: the spec takes the row and the page hides, until Show the page.
    const heading = page.getByRole("heading", { level: 1, name });

    await page.getByRole("region", { name: "Editor" }).getByRole("button", { name: "Maximize the editor" }).click();
    await expect(heading).toBeHidden();

    await page.getByRole("button", { name: "Show the page" }).click();
    await expect(heading).toBeVisible();
});

test("the box starts a session in the workspace", async ({ page }) => {

    const name = path.basename(eesha.work);

    await page.goto(eesha.url);
    await page.getByRole("button", { name: "AI sessions" }).click();
    await page.getByRole("navigation", { name: "Sessions" }).getByRole("link", { name, exact: true }).first().click();
    await expect(page.getByText(`New session in ${name}`)).toBeVisible();

    await page.getByRole("textbox", { name: "What do you want to do?" }).fill("hello");
    await page.getByRole("button", { name: "Start session" }).click();

    await expect(page).toHaveURL(/\?chat=/);
    await expect(page.locator(".eesha-crumb-folder")).toContainText(name);
});
