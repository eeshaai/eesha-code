import { expect, type Page, test } from "@playwright/test";

import { consoleErrors, type Eesha, startEesha } from "./eesha";

/*
 * The Evaluator's pages on the fake runtime: the create form sends, the
 * live page only watches, Stop ends one variant, and the report says how
 * each one ended.
 */

let eesha: Eesha;

test.beforeAll(async () => {

    eesha = await startEesha({ features: { fakeRuntime: true, evals: true } });
});

test.afterAll(async () => {

    await eesha?.stop();
});

/** Opens the list and its form. The key is given on the start page first: it sets the cookie. */
async function openList(page: Page): Promise<void> {

    await page.goto(eesha.url);
    await page.goto(`${eesha.origin}/eval`);

    await expect(page.getByRole("heading", { name: "New evaluation" })).toBeVisible();
}

/** The common message box on the create form. */
function commonMessage(page: Page) {

    return page.locator("label", { hasText: "Common message, for every variant" }).locator("textarea");
}

/** One variant's fields on the create form, by its place. */
function variantForm(page: Page, index: number) {

    return page.locator(".evals__variant").nth(index);
}

/** Fills the create form: a name, the test repository, and every variant on the fake runtime with its own text. */
async function fillForm(page: Page, name: string, common: string, own: string[]): Promise<void> {

    await page.getByPlaceholder("login-refactor").fill(name);
    await page.getByPlaceholder("The full path of the folder to work on").fill(eesha.work);
    await commonMessage(page).fill(common);

    // The form starts with two variants.
    await expect(page.locator(".evals__variant")).toHaveCount(2);

    for (const [index, text] of own.entries()) {

        await variantForm(page, index).locator("select").first().selectOption("fake");
        await variantForm(page, index).locator("textarea").fill(text);
    }
}

/** A variant's column on the live page. */
function column(page: Page, variant: string) {

    return page.getByRole("region", { name: variant, exact: true });
}

/** What a variant's column frame shows: its chat. */
function columnChat(page: Page, variant: string) {

    return page.frameLocator(`iframe[title="${variant}: its chat"]`);
}

test("Create and send gives every variant its message, and the live page only watches", async ({ page }) => {

    const errors = consoleErrors(page);

    await openList(page);
    await fillForm(page, "first", "hello variants", ["", "Be short."]);

    await page.getByRole("button", { name: "Create and send" }).click();

    await expect(page).toHaveURL(/\/eval\/first$/);

    // Both ran: the fake answered each one.
    for (const variant of ["first-1", "first-2"]) {

        await expect(column(page, variant).getByText("Done")).toBeVisible();
        await expect(columnChat(page, variant).getByText("Fake runtime, turn 1. No model is called.")).toBeVisible();
    }

    // The common message for both; the own text under it for the second only.
    await expect(columnChat(page, "first-1").getByText("hello variants")).toBeVisible();
    await expect(columnChat(page, "first-2").getByText(/hello variants\s+Be short\./)).toBeVisible();
    await expect(columnChat(page, "first-1").getByText("Be short.")).toHaveCount(0);

    // Nothing to type on this page: the kept message is read only, and a column has no box and no picker.
    const kept = page.locator("label", { hasText: "Common message, as it was sent to every variant" }).locator("textarea");

    await expect(kept).toHaveValue("hello variants");
    await expect(kept).not.toBeEditable();

    for (const variant of ["first-1", "first-2"])
        await expect(columnChat(page, variant).locator("textarea, input, select")).toHaveCount(0);

    // The message went when it was made: nothing left to send.
    await expect(page.getByRole("button", { name: /^Send to/ })).toHaveCount(0);

    expect(errors).toEqual([]);
});

test("a variant added later gets the kept message with Send to new variants", async ({ page }) => {

    await page.goto(eesha.url);
    await page.goto(`${eesha.origin}/eval/first`);

    await page.getByRole("button", { name: "Add variant" }).click();

    const form = page.getByRole("group", { name: "New variant" });

    await form.locator("select").first().selectOption("fake");
    await form.getByRole("button", { name: "Add variant" }).click();

    await expect(column(page, "first-3").getByText("Not started")).toBeVisible();

    await page.getByRole("button", { name: "Send to new variants 1" }).click();

    await expect(column(page, "first-3").getByText("Done")).toBeVisible();
    await expect(columnChat(page, "first-3").getByText("hello variants")).toBeVisible();

    // The others got nothing more.
    await expect(columnChat(page, "first-1").getByText("Fake runtime, turn 2")).toHaveCount(0);
});

test("picking a saved task asks before it replaces words you typed", async ({ page }) => {

    await openList(page);

    const task = page.locator(".evals__task select");
    const ask = page.getByRole("alertdialog", { name: "Replace your message" });

    await commonMessage(page).fill("my own words");

    // Keep mine: the words stay, the task stays picked.
    await task.selectOption("find-cache");
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Keep mine" }).click();

    await expect(ask).toBeHidden();
    await expect(commonMessage(page)).toHaveValue("my own words");
    await expect(task).toHaveValue("find-cache");

    // Replace: the task's text goes in.
    await task.selectOption("find-security");
    await ask.getByRole("button", { name: "Replace" }).click();

    await expect(commonMessage(page)).toHaveValue(/security problems/);

    // The box holds a task's own text now: another task replaces it without asking.
    await task.selectOption("find-cache");

    await expect(ask).toBeHidden();
    await expect(commonMessage(page)).toHaveValue(/cache problems/);
});

test("Stop ends one variant's turn, and the report says so and gives it no green", async ({ page }) => {

    const errors = consoleErrors(page);

    // Held a moment on its way, so the page's Stopping state can be seen.
    await page.route("**/api/eval/stop", async route => {

        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.continue();
    });

    await openList(page);
    await fillForm(page, "stop", "", ["fake slow", "Answer at once."]);

    await page.getByRole("button", { name: "Create and send" }).click();

    await expect(page).toHaveURL(/\/eval\/stop$/);
    await expect(column(page, "stop-2").getByText("Done")).toBeVisible();

    const stop = column(page, "stop-1").getByRole("button", { name: "Stop" });

    await expect(column(page, "stop-1").getByText("Working")).toBeVisible();

    await stop.click();

    // Off, and says so, until the variant stopped.
    const stopping = column(page, "stop-1").getByRole("button", { name: "Stopping…" });

    await expect(stopping).toBeVisible();
    await expect(stopping).toBeDisabled();

    await expect(column(page, "stop-1").getByText("Done")).toBeVisible();
    await expect(column(page, "stop-1").getByRole("button", { name: /^Stop/ })).toHaveCount(0);

    // The report: how each one ended, and no green - the stopped one is not compared, and one value alone has nothing to beat.
    await page.getByRole("button", { name: "Report", exact: true }).click();

    const ended = page.locator(".evals__table--numbers tbody tr", { hasText: "How it ended" }).locator("td");

    await expect(ended).toHaveText(["stopped", "finished"]);

    const totalTime = page.locator(".evals__table--numbers tbody tr", { hasText: "Total time" });

    await expect(totalTime.locator("td")).toHaveCount(2);
    await expect(totalTime.locator("td.evals__lowest")).toHaveCount(0);

    expect(errors).toEqual([]);
});
