import * as fs from "fs";
import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, consoleErrors, type Eesha, startEesha } from "./eesha";

/*
 * A spec run end to end on the fake runtime: every drafting phase runs
 * in a chat of its own, asks its one question there, and writes its
 * document; the implement phase ticks the plan's tasks. The spec shows
 * as a tab beside the chat.
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

/** The spec folder of `name`. */
function specFolder(name: string): string {

    return path.join(eesha.work, ".eesha", "specs", name);
}

/** Makes a spec through the New spec window and opens it. */
async function newSpec(page: Page, name: string): Promise<void> {

    // The workspace's menu in the session list opens its specs page,
    // with the Spec explorer on the right.
    await page.goto(eesha.url);
    await page.getByRole("button", { name: "AI sessions" }).click();

    // Its buttons show on hover.
    const heading = page.locator(".ee-session-list__group-head", { hasText: path.basename(eesha.work) }).first();

    await heading.hover();
    await heading.getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Specs", exact: true }).click();

    const panel = page.getByRole("region", { name: "Spec explorer" });

    await panel.getByRole("button", { name: "New spec" }).first().click();

    const dialog = page.getByRole("dialog");

    await dialog.getByRole("textbox", { name: "The ask" }).fill("Add a greeting");
    await dialog.getByRole("textbox", { name: "Spec name" }).fill(name);
    await dialog.getByRole("button", { name: "Create" }).click();

    // The spec opens as a tab, and the address carries it.
    await expect(page).toHaveURL(new RegExp(`[?&]spec=${name}`));
}

/** The spec's tab, beside the page or the chat. */
function specTab(page: Page) {

    return page.getByRole("region", { name: "Editor" });
}

/** Picks what every phase of the spec runs on, in the spec tab's header. */
async function pickSpecRuntime(page: Page, runtime: string): Promise<void> {

    await specTab(page).getByRole("button", { name: /^Runtime:/ }).click();
    await page.getByRole("menuitemradio", { name: runtime, exact: true }).click();
    await expect(specTab(page).getByRole("button", { name: `Runtime: ${runtime}` })).toBeVisible();
}

/**
 * Presses Next for a phase. The page moves to the new chat the phase
 * runs in - the spec tab beside it - which the page title names.
 */
async function next(page: Page, spec: string, phase: string, chat = phase): Promise<void> {

    await specTab(page).getByRole("button", { name: new RegExp(`^Next: ${phase}`) }).click();
    await expect(page).toHaveTitle(new RegExp(`${spec} · ${chat}`));
    await expect(page).toHaveURL(new RegExp(`\\?chat=[^&]+&spec=${spec}`));
}

/** Sets the Permissions level of the chat's runtime, in the chat's box. */
async function setLevel(page: Page, level: RegExp): Promise<void> {

    await page.getByRole("button", { name: /^Permissions:/ }).click();
    await page.getByRole("menuitemradio", { name: level }).click();
}

/** Answers the fake's one question with Answer A. */
async function answerQuestion(page: Page): Promise<void> {

    await page.getByRole("radio", { name: "Answer A" }).check();
    await page.getByRole("button", { name: "Submit" }).click();
}

test("a spec runs every phase on the fake runtime", async ({ page }) => {

    test.setTimeout(180_000);

    const errors = consoleErrors(page);

    await newSpec(page, "greeting");
    await pickSpecRuntime(page, "fake");

    // Requirements: started by Next, in a chat of its own.
    await next(page, "greeting", "Requirements");

    await answerQuestion(page);
    await expect(specTab(page).getByRole("button", { name: /^Next: Design/ })).toBeVisible();

    const requirements = fs.readFileSync(path.join(specFolder("greeting"), "requirements.md"), "utf8");

    expect(requirements).toContain("### Requirement 1: Sample behaviour");
    expect(requirements).toContain("The person answered the fake question: Answer A.");

    // Design and Tasks: each started by Next, each asks once. Next moves
    // the page to the new chat of the phase it starts, so its question
    // shows with no click on anything.
    for (const [title, after] of [["Design", /^Next: Tasks/], ["Tasks", /^Next: Implementation/]] as const) {

        await next(page, "greeting", title);
        await answerQuestion(page);
        await expect(specTab(page).getByRole("button", { name: after })).toBeVisible();
    }

    expect(fs.existsSync(path.join(specFolder("greeting"), "design.md"))).toBe(true);
    expect(fs.readFileSync(path.join(specFolder("greeting"), "tasks.md"), "utf8")).toContain("## Task Dependency Graph");

    // Implementation: both waves run, one after the other, each in a chat
    // of its own, and tick their tasks. The page moves to the first.
    await next(page, "greeting", "Implementation", "Wave 0");

    const tasks = path.join(specFolder("greeting"), "tasks.md");

    await expect.poll(() => fs.readFileSync(tasks, "utf8"), { timeout: 90_000 }).toContain("- [x] 2. Last sample task");

    const ticked = fs.readFileSync(tasks, "utf8");

    expect(ticked).toContain("- [x] 1.1 First sample task");
    expect(ticked).toContain("- [x] 1.2 Second sample task");

    // A message typed into a finished wave's chat runs there - once the
    // spec has stopped working: while a wave runs, SDD refuses it.
    await expect(specTab(page).getByRole("button", { name: "Stop", exact: true })).toBeHidden({ timeout: 30_000 });

    // The wave chat runs on the spec's AI: its box shows the model but cannot change it.
    await expect(page.getByRole("main").getByRole("button", { name: /^Model:/ })).toBeDisabled();

    const reply = page.getByRole("textbox", { name: /^Reply/ });

    await reply.fill("hello");
    await reply.press("Enter");

    await expect(page.getByText("No tasks were handed over")).toBeVisible();

    // The session list folds the spec's chats under it, and the wave
    // chats once more under Implementation - open, since a wave chat is
    // the one on screen.
    await page.getByRole("button", { name: "AI sessions" }).click();

    const list = page.locator(".ee-session-list");
    const implementation = list.getByRole("link", { name: "Implementation", exact: true });

    await expect(implementation).toBeVisible();
    await expect(implementation.locator("xpath=ancestor::li[1]")).toHaveClass(/ee-session-list__row--nested/);
    await expect(list.getByRole("link", { name: "Wave 0", exact: true }).locator("xpath=ancestor::li[1]")).toHaveClass(/ee-session-list__row--deep/);

    // The Spec explorer's link to the spec goes straight to a phase chat
    // with the spec as a tab, not through the older spec address.
    await page.getByRole("button", { name: "Spec explorer" }).click();
    await expect(page.getByRole("region", { name: "Spec explorer" }).getByRole("link", { name: "greeting", exact: true }))
        .toHaveAttribute("href", /^\/\?chat=[^&]+&spec=greeting$/);

    // Maximize: the spec takes the row - the chat, the session list and
    // the Spec explorer hide - until the session row's Show the chat, or
    // the same button, gives them back as they were.
    const sessions = page.locator(".eesha-nav-panel");
    const explorer = page.getByRole("region", { name: "Spec explorer" });

    await expect(sessions).toBeVisible();
    await expect(explorer).toBeVisible();

    await specTab(page).getByRole("button", { name: "Maximize the editor" }).click();
    await expect(reply).toBeHidden();
    await expect(sessions).toBeHidden();
    await expect(explorer).toBeHidden();
    await page.screenshot({ path: test.info().outputPath("maximized.png") });

    await page.getByRole("button", { name: "Show the chat" }).click();
    await expect(reply).toBeVisible();
    await expect(sessions).toBeVisible();
    await expect(explorer).toBeVisible();

    await specTab(page).getByRole("button", { name: "Maximize the editor" }).click();
    await specTab(page).getByRole("button", { name: "Restore the editor" }).click();
    await expect(reply).toBeVisible();
    await expect(page.getByRole("button", { name: "Show the chat" })).toBeHidden();

    // A panel's button while maximized ends it and shows that panel -
    // here the File explorer, in place of the Spec explorer.
    await specTab(page).getByRole("button", { name: "Maximize the editor" }).click();
    await page.getByRole("button", { name: /^File explorer/ }).click();
    await expect(reply).toBeVisible();
    await expect(sessions).toBeVisible();
    await expect(explorer).toBeHidden();

    expect(errors).toEqual([]);
});

test("at Agent's Choice a phase's write asks with a card in the phase chat", async ({ page }) => {

    test.setTimeout(120_000);

    await newSpec(page, "asking");
    await pickSpecRuntime(page, "fake");

    // Requirements at Auto: it writes with no card.
    await next(page, "asking", "Requirements");
    await answerQuestion(page);
    await expect(specTab(page).getByRole("button", { name: /^Next: Design/ })).toBeVisible();

    // The level is per runtime, for every session on the server: set in
    // this phase chat's box, it holds for the next phase's chat too.
    await setLevel(page, /^Agent's Choice/);
    await expect(page.getByRole("button", { name: /^Permissions: Agent's Choice/ })).toBeVisible();

    await next(page, "asking", "Design");
    await answerQuestion(page);

    const allow = page.getByRole("button", { name: "Allow once" });

    await expect(allow).toBeVisible();
    expect(fs.existsSync(path.join(specFolder("asking"), "design.md"))).toBe(false);

    await allow.click();

    await expect(specTab(page).getByRole("button", { name: /^Next: Tasks/ })).toBeVisible();
    expect(fs.existsSync(path.join(specFolder("asking"), "design.md"))).toBe(true);

    // Back to Auto, for whatever runs on this server next.
    await setLevel(page, /^Auto/);
});
