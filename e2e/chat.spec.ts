import { expect, test } from "@playwright/test";

import { consoleErrors, type Eesha, pickRuntime, SESSION_ADDRESS, startEesha } from "./eesha";

/*
 * The start page and a chat on the fake runtime.
 */

let eesha: Eesha;

test.beforeAll(async () => {

    eesha = await startEesha();
});

test.afterAll(async () => {

    await eesha?.stop();
});

test("the start page loads with no console errors", async ({ page }) => {

    const errors = consoleErrors(page);

    await page.goto(eesha.url);

    await expect(page.getByRole("textbox", { name: "What do you want to do?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
    await expect(page.getByText("No sessions yet.")).toBeVisible();

    expect(errors).toEqual([]);
});

test("Start session opens a session with the text in the box, and Send gets the fake's reply", async ({ page }) => {

    const errors = consoleErrors(page);

    await page.goto(eesha.url);
    await pickRuntime(page, "fake");

    await page.getByRole("textbox", { name: "What do you want to do?" }).fill("hello fake");
    await page.getByRole("button", { name: "Start session" }).click();

    await expect(page).toHaveURL(SESSION_ADDRESS);

    const reply = page.getByRole("textbox", { name: /^Reply/ });

    // Added text ends with a new line, so more can be typed under it.
    await expect(reply).toHaveValue("hello fake\n");
    await page.getByRole("button", { name: "Send message" }).click();

    const main = page.getByRole("main");

    await expect(main.getByText("Fake runtime, turn 1. No model is called.")).toBeVisible();
    await expect(main.getByText(/Nothing was written, because this session names no file/)).toBeVisible();
    await expect(page).toHaveTitle(/^\(Done\) hello fake/);

    // A second turn in the same session.
    await reply.fill("again");
    await reply.press("Enter");

    await expect(main.getByText("Fake runtime, turn 2. No model is called.")).toBeVisible();

    expect(errors).toEqual([]);
});

test("the session is listed on the start page", async ({ page }) => {

    await page.goto(eesha.url);

    await expect(page.getByRole("link", { name: /hello fake/ }).first()).toBeVisible();
});
