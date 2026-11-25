import * as fs from "fs";
import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, consoleErrors, type Eesha, pickRuntime, SESSION_ADDRESS, startEesha } from "./eesha";

/*
 * Memory: the Memory page, the Memory block under Connectors, and
 * `>memory` in the message box.
 *
 * The fake runtime calls no tool, so a save by the agent is not covered
 * here - the unit tests cover the tools.
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

/** The saved memory choices, read again from the settings file. */
function savedChoices(): { access?: string; askOnSave?: boolean; claudeMemoryOff?: boolean } {

    const settings = JSON.parse(fs.readFileSync(path.join(eesha.home, ".eesha", "settings.json"), "utf8")) as { eesha?: { memory?: object } };

    return settings.eesha?.memory ?? {};
}

async function openMemoryPage(page: Page): Promise<void> {

    await page.goto(eesha.url);
    await page.goto(`${eesha.origin}/settings/memory`);
    await expect(page.getByRole("button", { name: "Add a memory" })).toBeVisible();
}

/** Adds a memory in the Add window. `level` is the label of the level to pick; `folder` is typed for a folder memory. */
async function addMemory(page: Page, title: string, text: string, level?: "A workspace" | "A folder", folder?: string): Promise<void> {

    await page.getByRole("button", { name: "Add a memory" }).click();

    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Text").fill(text);

    if (level)
        await dialog.getByText(level, { exact: true }).click();

    if (folder)
        await dialog.getByLabel("Folder").fill(folder);

    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
}

test("the Memory page adds a memory, moves it to a workspace, and deletes it", async ({ page }) => {

    const errors = consoleErrors(page);
    const workspace = path.basename(eesha.work);

    await openMemoryPage(page);
    await addMemory(page, "Go code uses tabs", "Always tabs, never spaces, in Go code.");

    const global = page.getByRole("region", { name: "Global", exact: true });

    await expect(global).toContainText("Go code uses tabs");
    await expect(global).toContainText("written by you");
    await expect(global).toContainText("Always tabs, never spaces, in Go code.");
    await expect(page.getByText("1 memory saved.")).toBeVisible();

    // Edit: a new title, and the workspace level.
    await page.getByRole("button", { name: "Edit Go code uses tabs" }).click();

    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("Title").fill("Go code uses tabs only");
    await dialog.getByText("A workspace", { exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("region", { name: `Workspace: ${workspace}`, exact: true })).toContainText("Go code uses tabs only");
    await expect(global).not.toContainText("Go code uses tabs");

    // It is still there after a reload.
    await page.reload();
    await expect(page.getByRole("region", { name: `Workspace: ${workspace}`, exact: true })).toContainText("Go code uses tabs only");

    await page.getByRole("button", { name: "Delete Go code uses tabs only" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.getByText("0 memories saved.")).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Go code uses tabs only");

    expect(errors).toEqual([]);
});

test("\"Folder moved\" gives a folder's memory to another folder", async ({ page }) => {

    const errors = consoleErrors(page);
    const moved = path.join(eesha.home, "moved");

    fs.mkdirSync(moved, { recursive: true });

    await openMemoryPage(page);
    await addMemory(page, "This folder uses pnpm", "Use pnpm here, never npm.", "A folder", eesha.work);

    const before = page.getByRole("region", { name: /^Folder: .*work$/ });

    await expect(before).toContainText("This folder uses pnpm");

    await before.getByRole("button", { name: "Folder moved…" }).click();

    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("New folder").fill(moved);
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("region", { name: /^Folder: .*moved$/ })).toContainText("This folder uses pnpm");
    await expect(page.getByRole("region", { name: /^Folder: .*work$/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Delete This folder uses pnpm" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("0 memories saved.")).toBeVisible();

    expect(errors).toEqual([]);
});

test("the Memory block under Connectors saves what the agent may do", async ({ page }) => {

    const errors = consoleErrors(page);

    await page.goto(eesha.url);
    await page.goto(`${eesha.origin}/settings/connectors`);

    const memory = page.getByRole("region", { name: "Memory", exact: true });
    const ask = memory.locator("[aria-labelledby=\"eesha-memory-ask\"]");

    await expect(memory).toContainText("Ask me before the agent saves, changes or deletes a memory");

    // The switch is drawn over a hidden checkbox, so it is clicked as an event.
    await ask.dispatchEvent("click");
    await expect.poll(() => savedChoices().askOnSave).toBe(true);

    await memory.getByText("Read", { exact: true }).click();
    await expect.poll(() => savedChoices().access).toBe("read");

    // Asking is only about changes, so it cannot be set while the agent may only read.
    await expect(ask).toBeDisabled();

    await memory.getByText("Off", { exact: true }).click();
    await expect.poll(() => savedChoices().access).toBe("off");

    await memory.getByText("Read and write", { exact: true }).click();
    await expect.poll(() => savedChoices().access).toBe("write");

    await ask.dispatchEvent("click");
    await expect.poll(() => savedChoices().askOnSave).toBe(false);

    expect(errors).toEqual([]);
});

test("`>memory` in the message box lists a memory and sends it with the message", async ({ page }) => {

    const errors = consoleErrors(page);

    await openMemoryPage(page);
    await addMemory(page, "Releases are on Friday", "This team releases every Friday.");

    await page.goto(eesha.url);
    await page.locator("select").filter({ has: page.locator("option", { hasText: "No workspace" }) }).selectOption({ label: "No workspace" });
    await pickRuntime(page, "fake");

    await page.getByRole("textbox", { name: "What do you want to do?" }).fill("hello");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(SESSION_ADDRESS);

    const reply = page.getByRole("textbox", { name: /^Reply/ });

    await expect(reply).toHaveValue("hello\n");
    await reply.press("Control+End");
    await reply.pressSequentially(">memory>");

    // A session with no workspace and no folder reaches only global.
    await expect(page.getByText("Every session - 1 saved")).toBeVisible();
    await expect(page.getByText("This session is in no workspace", { exact: false })).toBeVisible();

    await reply.pressSequentially("global>");
    await expect(page.getByText("Releases are on Friday")).toBeVisible();

    await reply.press("Enter");
    await expect(reply).toHaveValue(/>memory>global>\d+/);

    await page.getByRole("button", { name: "Send message" }).click();

    const main = page.getByRole("main");

    await expect(main.getByText("Fake runtime, turn 1. No model is called.")).toBeVisible();
    await expect(main.getByText("Also sent to the agent")).toBeVisible();

    expect(errors).toEqual([]);
});
