import * as fs from "fs";
import * as path from "path";

import { expect, type Page, test } from "@playwright/test";

import { addWorkspace, consoleErrors, type Eesha, newSpec, openSection, sessions, sessionWithSpec, startEesha } from "./eesha";

/*
 * A spec run end to end on the fake runtime: every drafting phase runs
 * in a chat of its own, asks its one question there, and writes its
 * document; the implement phase ticks the plan's tasks. The spec shows
 * as a tab beside the chat, with the box over its document that says
 * what waits for you.
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
    await expect(page).toHaveURL(sessionWithSpec(spec));
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

    await page.goto(eesha.url);
    await newSpec(page, "greeting");
    await pickSpecRuntime(page, "fake");

    // Requirements: started by Next, in a chat of its own.
    await next(page, "greeting", "Requirements");

    // The spec is beside its phase chat, so the chat has no line of its
    // own; the box over the document says a question waits.
    await expect(page.getByText("Phase chat of spec")).toHaveCount(0);
    await expect(specTab(page).getByRole("button", { name: "Go to the question" })).toBeVisible();

    await answerQuestion(page);
    await expect(specTab(page).getByRole("button", { name: /^Next: Design/ })).toBeVisible();
    await expect(specTab(page).getByText(/requirements\.md is written\./)).toBeVisible();

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

    // Implementation: both waves run, one after the other, in the one
    // Implementation chat, and tick their tasks. The page moves to it.
    await next(page, "greeting", "Implementation");

    const tasks = path.join(specFolder("greeting"), "tasks.md");

    await expect.poll(() => fs.readFileSync(tasks, "utf8"), { timeout: 90_000 }).toContain("- [x] 2. Last sample task");

    const ticked = fs.readFileSync(tasks, "utf8");

    expect(ticked).toContain("- [x] 1.1 First sample task");
    expect(ticked).toContain("- [x] 1.2 Second sample task");

    // A message typed into the Implementation chat runs there - once the
    // spec has stopped working: while a wave runs, SDD refuses it.
    await expect(specTab(page).getByRole("button", { name: "Stop", exact: true })).toBeHidden({ timeout: 30_000 });

    // The Implementation chat runs on the spec's AI: its box has no Model
    // button, while the spec tab's header has one.
    await expect(page.getByRole("main").getByRole("button", { name: /^Model:/ })).toHaveCount(0);
    await expect(specTab(page).getByRole("button", { name: /^Model:/ })).toBeVisible();

    const reply = page.getByRole("textbox", { name: /^Reply/ });

    await reply.fill("hello");
    await reply.press("Enter");

    await expect(page.getByText("No tasks were handed over")).toBeVisible();

    // The Sessions section has one row for the spec, linked to a phase
    // chat with the spec as a tab; the phase chats have no rows of their own.
    await expect(sessions(page).getByRole("link", { name: /^greeting/ }))
        .toHaveAttribute("href", /^\/\?chat=[^&]+&spec=greeting$/);
    await expect(sessions(page).locator('a[href^="/?chat="]')).toHaveCount(1);

    // The spec's ⋯ menu lists its other views and its chats.
    await specTab(page).getByRole("button", { name: "More of this spec" }).click();
    await expect(page.getByRole("menuitem", { name: /^Logs/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^requirements · / })).toBeVisible();
    await page.keyboard.press("Escape");

    // Maximize: the spec takes the row - the chat and the workspace panel
    // hide - until Show the chat (in the row that shows only then), or the same button,
    // gives them back as they were.
    const panel = page.locator(".eesha-nav-panel");

    await expect(panel).toBeVisible();

    await specTab(page).getByRole("button", { name: "Maximize the editor" }).click();
    await expect(reply).toBeHidden();
    await expect(panel).toBeHidden();
    await page.screenshot({ path: test.info().outputPath("maximized.png") });

    await page.getByRole("button", { name: "Show the chat" }).click();
    await expect(reply).toBeVisible();
    await expect(panel).toBeVisible();

    await specTab(page).getByRole("button", { name: "Maximize the editor" }).click();
    await specTab(page).getByRole("button", { name: "Restore the editor" }).click();
    await expect(reply).toBeVisible();
    await expect(page.getByRole("button", { name: "Show the chat" })).toBeHidden();

    // A section's key while maximized ends it and shows the panel with
    // that section open - here Files.
    await specTab(page).getByRole("button", { name: "Maximize the editor" }).click();
    await page.keyboard.press("Control+Shift+E");
    await expect(reply).toBeVisible();
    await expect(panel).toBeVisible();
    await openSection(page, "Files");

    expect(errors).toEqual([]);
});

test("at Agent's Choice a phase's write asks with a card in the phase chat", async ({ page }) => {

    test.setTimeout(120_000);

    await page.goto(eesha.url);
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
