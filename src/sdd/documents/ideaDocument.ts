/**
 * `idea.md`, rendered from what ＋ New Spec collected.
 *
 * No model runs here. Idea is the input gate: it records what was
 * asked, where it came from, and which pipeline the spec runs. Every
 * one of those is something the person typed or picked, so writing it
 * is formatting, not reasoning. A model in the middle would only
 * paraphrase - and a spec sourced from a document somebody already
 * wrote does not need that: the requirements phase reads the original,
 * not a lossy copy a human would then have to approve.
 *
 * So the document is thin on purpose. It carries the provenance that
 * must travel with the spec, it points at the source material, and it
 * is a plain file the user can edit before the next phase reads it.
 *
 * The format lives here rather than in a style, because every style's
 * pipeline opens with this document and the phase after it reads it -
 * one shape serves all of them, and a shape produced by code can be
 * relied on in a way a shape produced by a prompt cannot.
 */

/** Where the work item behind a spec came from, and the pointer to it. */
export interface IdeaInput {

    /** The spec folder's name - what everything calls this piece of work. */
    specName: string;

    /**
     * The style this spec follows. Recorded in frontmatter and nowhere
     * else - it is how discovery tells this folder apart from one
     * written under a different style once more than one is enabled.
     */
    style: string;

    /** The pipeline this spec runs. Recorded in frontmatter and nowhere else. */
    specType: string;

    /** `manual`, `ado`, `gh` or `file`. */
    source: string;

    /** The one line the user typed, for a `manual` spec. */
    description?: string;

    /** Work item id or issue number, for `ado` and `gh`. */
    workItem?: string;

    /** A link to that item, when the user pasted one rather than an id. */
    url?: string;

    /** Spec-relative names of files copied into the folder, in the order picked. */
    files?: string[];
}

/** What each source is called in prose, and where its detail is. */
const SOURCES: Record<string, string> = {
    manual: "described by hand",
    ado: "Azure DevOps work item",
    gh: "GitHub issue",
    file: "a file handed over"
};

export function renderIdea(input: IdeaInput): string {

    const lines: string[] = [
        "---",
        "spec: 1",
        `style: ${input.style}`,
        `type: ${input.specType}`,
        `source: ${input.source}`
    ];

    // Provenance keys only where they mean something. An empty `id:`
    // on a manual spec is a key a later reader has to decide how to
    // treat.
    if (input.workItem)
        lines.push(`id: ${input.workItem}`);

    if (input.url)
        lines.push(`url: ${input.url}`);

    lines.push(
        `title: ${input.specName}`,
        "---",
        "",
        `# ${input.specName}`,
        "",
        "## What is being asked",
        "",
        ...asked(input),
        "",
        "## Where this came from",
        "",
        ...provenance(input),
        "",
        "---",
        "",
        "*Written by ＋ New Spec from what you were asked. Edit it freely - "
        + "the requirements phase reads this file, so anything you add here is "
        + "context it works from.*",
        "");

    return lines.join("\n");
}

/**
 * The ask, or where to find it.
 *
 * For a source that carries its own material this points rather than
 * summarises: the requirements phase opens the real thing, and a
 * sentence here pretending to be the ask would compete with it.
 */
function asked(input: IdeaInput): string[] {

    if (input.description)
        return [input.description];

    if (input.files?.length) {

        const one = input.files.length === 1;

        return [
            `The ask is in ${one ? "the file" : "the files"} copied into this spec folder:`,
            "",
            ...input.files.map(file => `- \`${file}\``),
            "",
            `**Read ${one ? "it" : "them all"} in full.** `
            + `${one ? "It is" : "They are"} this spec's source material, not a summary of the ask.`
        ];
    }

    if (input.workItem || input.url)
        return [
            `The ask is ${item(input)}. **Read it and its comment thread** through the `
            + `${input.source === "ado" ? "Azure DevOps" : "GitHub"} MCP server before drafting anything from it.`
        ];

    // Nothing but a folder name. Said plainly rather than left blank:
    // a phase reading this needs to know the ask is thin, not guess
    // that the section failed to render.
    return [
        "Nothing was recorded when this spec was created. "
        + "**Write what is being asked here before running the next phase.**"
    ];
}

function provenance(input: IdeaInput): string[] {

    const lines = [`- **Source**: ${SOURCES[input.source] ?? input.source}`];

    if (input.url)
        lines.push(`- **Item**: ${input.url}`);
    else if (input.workItem)
        lines.push(`- **Item**: ${input.workItem}`);

    if (input.files?.length)
        lines.push(...input.files.map(file => `- **File**: \`${file}\``));

    return lines;
}

/** How to name the work item in a sentence - the link when there is one. */
function item(input: IdeaInput): string {

    const kind = input.source === "ado" ? "work item" : "issue";

    if (input.url)
        return input.workItem ? `${kind} ${input.workItem} (${input.url})` : input.url;

    return `${kind} ${input.workItem}`;
}
