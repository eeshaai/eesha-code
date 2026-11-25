import * as fs from "fs";
import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, consoleErrors, type Eesha, newSpec, pickPlaceItem, pickRuntime, SESSION_ADDRESS, sessionWithSpec, startEesha } from "./eesha";

/*
 * The spec page, on the fake runtime: the spec as a tab with its phase
 * chat narrow beside it, the box over the document that says what waits
 * for you, the ⋯ menu with the spec's chats, the line over a chat whose
 * spec is not beside it, and `>spec` in the message box - its lists, its
 * actions, and a normal chat tied to a spec.
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

function specFolder(name: string): string {

    return path.join(eesha.work, ".eesha", "specs", name);
}

/** The spec's tab, beside the page or the chat. */
function specTab(page: Page) {

    return page.getByRole("region", { name: "Editor" });
}

/**
 * Types an action's whole path and runs it. With the path typed out the
 * list still offers its row, so the first Enter picks the row and the
 * second runs it - as after picking it from the list by hand.
 */
async function runAction(page: Page, text: string): Promise<void> {

    const reply = page.getByRole("textbox", { name: /^Reply/ });

    await reply.fill(text);
    await expect(page.getByRole("option", { name: new RegExp(`^${text.split(">").pop()}`) })).toBeVisible();

    // Until the box is empty: the action ran. An Enter that comes while
    // the list is still settling does nothing, so it is pressed again.
    for (let press = 0; press < 4; press++) {

        await reply.press("Enter");
        await page.waitForTimeout(400);

        if (await reply.inputValue().catch(() => "") === "")
            return;
    }

    throw new Error(`'${text}' did not run.`);
}

/** Answers the fake's one question with Answer A. */
async function answerQuestion(page: Page): Promise<void> {

    await page.getByRole("radio", { name: "Answer A" }).check();
    await page.getByRole("button", { name: "Submit" }).click();
}

test("a phase chat opens beside its spec, and the box and the ⋯ menu say what waits", async ({ page }) => {

    test.setTimeout(180_000);

    const errors = consoleErrors(page);
    const reply = page.getByRole("textbox", { name: /^Reply/ });

    await page.goto(eesha.url);
    await newSpec(page, "greeting");

    // What every phase runs on, picked in the spec tab's header.
    await specTab(page).getByRole("button", { name: /^Runtime:/ }).click();
    await page.getByRole("menuitemradio", { name: "fake", exact: true }).click();
    await expect(specTab(page).getByRole("button", { name: "Runtime: fake" })).toBeVisible();

    // The first phase starts from the spec's main button.
    await specTab(page).getByRole("button", { name: /^Next: Requirements/ }).click();
    await expect(page).toHaveTitle(/greeting · Requirements/);

    // The fake asks a question: the box says so, and its button puts the
    // cursor on the question card, which takes the message box's place.
    const toQuestion = specTab(page).getByRole("button", { name: "Go to the question" });

    await expect(toQuestion).toBeVisible();
    await toQuestion.click();
    await expect(page.getByRole("radio", { name: "Answer A" })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("spec-page.png") });

    await answerQuestion(page);

    // Its document is written: the box says so, and what comes next.
    await expect(specTab(page).getByText(/requirements\.md is written\./)).toBeVisible({ timeout: 30_000 });
    await expect(specTab(page).getByText(/start Design with the button at the top/)).toBeVisible();

    // The main button starts Design in a new chat, the spec beside it.
    await specTab(page).getByRole("button", { name: /^Next: Design/ }).click();
    await expect(page).toHaveTitle(/greeting · Design/);
    await expect(page).toHaveURL(sessionWithSpec("greeting"));

    await answerQuestion(page);
    await expect(specTab(page).getByRole("button", { name: /^Next: Tasks/ })).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(path.join(specFolder("greeting"), "design.md"))).toBe(true);

    // The ⋯ menu lists the spec's chats by phase and day, newest first; one goes to that chat.
    await specTab(page).getByRole("button", { name: "More of this spec" }).click();
    await expect(page.getByRole("menuitem", { name: /^design · / })).toContainText("this chat");
    await page.getByRole("menuitem", { name: /^requirements · / }).click();
    await expect(page).toHaveTitle(/greeting · Requirements/);

    // A phase chat opened with no spec in its address opens its spec by
    // itself: `/<workspace>/<spec>/<session>` made `/<workspace>/<session>`.
    const address = new URL(page.url());
    const [place, , session] = address.pathname.split("/").filter(Boolean);

    address.pathname = `/${place}/${session}`;
    await page.goto(address.toString());
    await expect(specTab(page).getByRole("tab", { name: /greeting/ })).toBeVisible();
    await expect(page.getByText("Phase chat of spec")).toHaveCount(0);

    // With the spec not beside it, the chat gets its line, and Open spec brings the spec back.
    await page.getByRole("button", { name: "Hide editor" }).click();
    await expect(page.getByText("Phase chat of spec")).toBeVisible();
    await page.getByRole("button", { name: "Open spec" }).click();
    await expect(specTab(page).getByRole("tab", { name: /greeting/ })).toBeVisible();
    await expect(page.getByText("Phase chat of spec")).toHaveCount(0);

    // >spec>new in the message box opens New spec with the text, and sends nothing.
    await reply.fill(">spec>new Say goodbye too");
    await reply.press("Enter");

    const dialog = page.getByRole("dialog");

    await expect(dialog.getByRole("textbox", { name: "The ask" })).toHaveValue("Say goodbye too");
    await expect(page.getByRole("main").getByText(">spec>new Say goodbye too")).toHaveCount(0);

    await dialog.getByRole("textbox", { name: "Spec name" }).fill("goodbye");
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/goodbye\/[^/?]+(\?|$)|[?&]spec=goodbye/);
    expect(fs.readFileSync(path.join(specFolder("goodbye"), "idea.md"), "utf8")).toContain("Say goodbye too");

    expect(errors).toEqual([]);
});

test(">spec in a normal chat lists the specs, runs their actions, and ties the chat to a spec", async ({ page }) => {

    test.setTimeout(120_000);

    const errors = consoleErrors(page);

    // A normal session in the workspace, on the fake runtime.
    await page.goto(eesha.url);
    await pickPlaceItem(page, "Workspace page");
    await page.getByRole("textbox", { name: "What do you want to do?" }).fill("hello");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(SESSION_ADDRESS);
    await pickRuntime(page, "fake");

    const normal = page.url();
    const reply = page.getByRole("textbox", { name: /^Reply/ });
    const tied = page.getByText("Tied to spec");

    // Not tied to a spec yet: no line.
    await expect(tied).toHaveCount(0);

    // The list: spec at the first level, then the specs, then one spec's rows.
    await reply.fill(">spec>");

    const list = page.getByRole("listbox").last();

    await expect(list.getByRole("option", { name: /^new/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /^greeting/ })).toBeVisible();

    await reply.fill(">spec>greeting>");
    await expect(list.getByRole("option", { name: /^requirements/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /^resume/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("picker.png") });
    await reply.press("Escape");

    // watch: the chat is tied, and its line says so. Nothing is sent.
    await runAction(page, ">spec>greeting>watch");

    await expect(tied).toBeVisible();
    await expect(page.getByRole("main").getByText(">spec>greeting>watch")).toHaveCount(0);

    // It is still tied after a reload, and has no untie button.
    await page.reload();
    await expect(tied).toBeVisible();
    await expect(page.getByRole("button", { name: "Untie this chat from the spec" })).toHaveCount(0);

    // open: the spec as a tab beside this chat - tied again, so the line
    // shows once the spec is not beside the chat.
    await runAction(page, ">spec>greeting>open");
    await expect(specTab(page).getByRole("tab", { name: /greeting/ })).toBeVisible();
    await expect(tied).toHaveCount(0);
    await page.getByRole("button", { name: "Hide editor" }).click();
    await expect(tied).toBeVisible();

    // A document goes to the agent with the message.
    await reply.fill("Read >spec>greeting>design and say hello");
    await reply.press("Enter");
    await expect(page.getByRole("main").getByText("Read >spec>greeting>design and say hello")).toBeVisible();

    // resume: the page goes to the spec's newest phase chat.
    await expect(reply).toBeEnabled({ timeout: 30_000 });
    await runAction(page, ">spec>greeting>resume");
    await expect(page).toHaveTitle(/greeting · Requirements|greeting · Design/);
    expect(page.url()).not.toBe(normal);

    expect(errors).toEqual([]);
});
