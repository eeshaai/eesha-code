import type { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

/*
 * Going back to an earlier message in a chat on Claude: the saved
 * conversation is copied, up to just before that message, into a new
 * conversation the chat carries on from. The SDK does the copy on disk
 * (`forkSession`) - no model call, so it costs nothing.
 *
 * Both Claude runtimes keep conversations in the same place under the
 * same ids: claude-agent-acp names its ACP session by the Claude session
 * id. So one helper serves the `claude` and `claude-cli` runtimes.
 */

/** One message of a saved conversation, as `getSessionMessages` lists it. */
export interface TranscriptMessage {

    type: string;

    uuid: string;

    parent_tool_use_id: string | null;

    message: unknown;
}

/** The two SDK calls this file uses - a stand-in in tests. */
export interface ClaudeHistorySdk {

    getSessionMessages: typeof getSessionMessages;

    forkSession: typeof forkSession;
}

/** Where a conversation can be cut, found before anything is changed. */
export type ClaudeCutPoint =

    /** After this message, the last one kept. */
    | { kind: "at"; upTo: string }

    /** The message was the conversation's first: nothing comes before it, so the next message starts a new one. */
    | { kind: "empty" }

    /** The message could not be found in the saved conversation. `reason` says why, in plain words. */
    | { kind: "unmatched"; reason: string };

/** How much of a message's start is compared - enough to tell messages apart, short of anything a runtime adds at the end. */
const KEY_CHARS = 200;

/** Spaces and line breaks folded to one space, so a runtime's own line endings do not stop a match. */
function folded(text: string): string {

    return text.replace(/\s+/g, " ").trim();
}

/**
 * The text of a message the person sent, or nothing for anything else:
 * the agent's answers, and the user-side messages that carry tool
 * results or come from a sub-agent.
 */
export function typedText(message: TranscriptMessage): string | undefined {

    if (message.type !== "user" || message.parent_tool_use_id)
        return undefined;

    const content = (message.message as { content?: unknown } | undefined)?.content;

    if (typeof content === "string")
        return content;

    if (!Array.isArray(content))
        return undefined;

    const blocks = content as { type?: unknown; text?: unknown }[];

    if (blocks.some(block => block?.type === "tool_result"))
        return undefined;

    const texts = blocks.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text as string);

    return texts.length ? texts.join("\n") : undefined;
}

/**
 * Where to cut a saved conversation so it ends just before the message
 * the person went back to.
 *
 * `prompts` are the chat's messages from that one to the newest, in
 * order. They are found in the saved conversation from the newest back,
 * each before the one after it, by the start of their text - the chat's
 * thread has no ids the runtime knows. Messages the runtime added that
 * the chat never showed are passed over.
 *
 * @returns the last message to keep (`upTo`), or no `upTo` when the
 * message is the conversation's first. Nothing when a message is not
 * found - after a compact, say, the earlier messages are a summary.
 */
export function cutPoint(
    messages: readonly TranscriptMessage[],
    prompts: readonly string[]
): { upTo?: string } | undefined {

    if (!prompts.length)
        return undefined;

    let position = messages.length;

    for (let index = prompts.length - 1; index >= 0; index--) {

        const key = folded(prompts[index]).slice(0, KEY_CHARS);

        let found = -1;

        for (let at = position - 1; at >= 0 && found < 0; at--) {

            const text = typedText(messages[at]);

            if (text !== undefined && folded(text).includes(key))
                found = at;
        }

        if (found < 0)
            return undefined;

        position = found;
    }

    return position > 0 ? { upTo: messages[position - 1].uuid } : {};
}

/**
 * Where a Claude conversation would be cut so it ends just before a
 * message the person sent. Reads the saved conversation; changes
 * nothing.
 *
 * @param sessionId the conversation the chat is on now
 * @param cwd       the folder it runs in - where the SDK keeps it
 * @param prompts   see {@link cutPoint}
 */
export async function claudeCutPoint(
    sessionId: string,
    cwd: string,
    prompts: readonly string[],
    sdk: Promise<ClaudeHistorySdk> = loadSdk()
): Promise<ClaudeCutPoint> {

    try {

        const { getSessionMessages } = await sdk;

        const messages = await getSessionMessages(sessionId, { dir: cwd });

        if (!messages.length)
            return { kind: "unmatched", reason: `Claude has no saved conversation ${sessionId} under ${cwd}.` };

        const cut = cutPoint(messages, prompts);

        if (!cut)
            return {
                kind: "unmatched",
                reason: "That message was not found in Claude's saved conversation - it may have been compacted."
            };

        return cut.upTo === undefined ? { kind: "empty" } : { kind: "at", upTo: cut.upTo };

    } catch (error) {

        return { kind: "unmatched", reason: `Claude's saved conversation could not be read: ${(error as Error).message}` };
    }
}

/**
 * Copies a Claude conversation, up to and including `upTo`, into a new
 * conversation. The old one is left as it was.
 *
 * @param title the new conversation's name in Claude's own list
 * @returns the new conversation's id, or why it could not be made
 */
export async function forkClaudeConversation(
    sessionId: string,
    cwd: string,
    upTo: string,
    title: string,
    sdk: Promise<ClaudeHistorySdk> = loadSdk()
): Promise<{ sessionId: string } | { reason: string }> {

    try {

        const { forkSession } = await sdk;

        return { sessionId: (await forkSession(sessionId, { dir: cwd, upToMessageId: upTo, title })).sessionId };

    } catch (error) {

        return { reason: `Claude's conversation could not be cut: ${(error as Error).message}` };
    }
}

/** The SDK, loaded on first use - ESM-only, so `import()`, the same as `ClaudeProvider` loads it. */
let sdkModule: Promise<ClaudeHistorySdk> | undefined;

function loadSdk(): Promise<ClaudeHistorySdk> {

    return sdkModule ??= (import("@anthropic-ai/claude-agent-sdk") as unknown as Promise<ClaudeHistorySdk>);
}

/** The runtimes whose conversations {@link cutClaudeConversation} can cut. */
export function cutsClaude(provider: string | undefined): boolean {

    return provider === "claude" || provider === "claude-cli";
}
