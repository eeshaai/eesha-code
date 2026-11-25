import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, consoleErrors, type Eesha, headerPlace, newSpec, pickPlaceItem, SESSION_ADDRESS, sessions, startEesha } from "./eesha";

/*
 * A workspace's own page: opened from the workspace picker in the
 * header, it survives a reload and starts a session in the workspace. It
 * has no heading of its own: the header names the workspace. A spec made
 * from it opens beside the page, which then keeps only the box and
 * Resume, and the spec shows in the Sessions section.
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

/** The workspace page's box. */
const box = (page: Page) => page.getByRole("region", { name: "Start a session" });

test("the header's workspace menu opens its page, which survives a reload", async ({ page }) => {

    const errors = consoleErrors(page);
    const name = path.basename(eesha.work);

    await page.goto(eesha.url);

    // The header names the only workspace, and the panel lists it.
    await expect(headerPlace(page)).toContainText(name);
    await expect(sessions(page).getByText("No specs here yet.")).toBeVisible();

    await pickPlaceItem(page, "Workspace page");
    // A workspace page is the workspace's name alone: one part, no session.
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/[a-z0-9-]+(\?|$)/);
    await expect(box(page)).toContainText(`New session in ${name}`);

    await page.reload();
    await expect(box(page)).toBeVisible();
    await expect(headerPlace(page)).toContainText(name);

    // No heading, no Edit or Archive: the header has them. No lists: the panel has them.
    await expect(page.getByRole("heading", { level: 1, name })).toHaveCount(0);
    await expect(page.locator(".eesha-main").getByRole("button", { name: "Edit workspace" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Recent sessions" })).toHaveCount(0);
    await expect(page.locator(".eesha-main").getByRole("button", { name: /^New spec/ })).toBeVisible();
    await expect(page.locator(".eesha-main").getByRole("button", { name: /^Next work item/ })).toBeVisible();

    expect(errors).toEqual([]);
});

test("a spec made from the page opens beside it, and shows in the Sessions section", async ({ page }) => {

    await page.goto(eesha.url);
    await pickPlaceItem(page, "Workspace page");
    await expect(box(page)).toBeVisible();

    await newSpec(page, "greeting");

    // The spec opens as a tab; the page stays beside it, with only the box
    // (and Resume, once there is a session), and the panel stays too.
    await expect(page.getByRole("region", { name: "Editor" }).getByRole("tab", { name: /greeting/ })).toBeVisible();
    await expect(box(page)).toBeVisible();
    await expect(page.locator(".eesha-main").getByRole("button", { name: /^Next work item/ })).toHaveCount(0);
    await expect(page.locator(".eesha-main").getByRole("button", { name: /^New spec/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show the page" })).toHaveCount(0);
    await expect(sessions(page)).toBeVisible();

    // No chat has started yet: the Sessions section's link opens the spec
    // as a tab on this page, not through the older spec address.
    await expect(sessions(page).getByRole("link", { name: /^greeting/ }))
        .toHaveAttribute("href", /^\/workspace\?workspace=[^&]+&spec=greeting$/);

    // Maximize: the page and the panel hide, until Show the page.
    await page.getByRole("region", { name: "Editor" }).getByRole("button", { name: "Maximize the editor" }).click();
    await expect(box(page)).toBeHidden();
    await expect(sessions(page)).toBeHidden();

    await page.getByRole("button", { name: "Show the page" }).click();
    await expect(box(page)).toBeVisible();
    await expect(sessions(page)).toBeVisible();
});

test("the box starts a session in the workspace", async ({ page }) => {

    const name = path.basename(eesha.work);

    await page.goto(eesha.url);
    await pickPlaceItem(page, "Workspace page");
    await expect(page.getByText(`New session in ${name}`)).toBeVisible();

    await page.getByRole("textbox", { name: "What do you want to do?" }).fill("hello");
    await box(page).getByRole("button", { name: "Send", exact: true }).click();

    await expect(page).toHaveURL(SESSION_ADDRESS);
    await expect(headerPlace(page)).toContainText(name);
});
