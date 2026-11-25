import { createPermissionGate, type PermissionGate } from "../core/agent/permissions";
import type { ChatController } from "../chat/ChatController";
import type { ChatNotice } from "../chat/chatHost";
import type { ChatStore } from "../chat/chatStore";
import { isAcpRuntime } from "../chat/permissionLevels";
import { listChats } from "../chat/chatHistory";
import { evalDir, evalScratchDir, type EvalVariant, readEval, type SavedEval, writeEval } from "./evals";
import { claudeWaits } from "./memory/claudeMemory";
import type { SessionPlace } from "./memory/Memory";
import { EVAL_TEXT_MAX, workspaceKey } from "./protocol";
import { type HostServer, ServerChatHost } from "./ServerChatHost";
import { sessionWorkspace } from "./workspaces";

/** Told to the agent beside the memory's own lines: it can read here, never save. */
const MEMORY_READ_ONLY = "In this session the memory can be read but not changed: memory_save and memory_delete are refused.";

/** Said in the column when its text was saved. */
const VARIANT_TEXT_SAVED = "Saved for this variant. It is added under the common message when you press Send to all.";

/** Said in the column when its text cannot change any more. */
const VARIANT_TEXT_LOCKED = "This variant got its one message. To try another text, use Copy as new variant.";

/**
 * The host of one variant of an evaluation - see evals.ts.
 *
 * It differs from a normal session's host in these ways:
 *
 * - Its only folder is the variant's own copy. Nothing of it is saved
 *   in `sessions/`: the evaluation's own file holds it.
 * - Its chat file and saved picks are the evaluation's own, so the
 *   session list and the search never show it.
 * - Nobody is asked. Every call inside the copy runs; a call outside it
 *   is refused. The agent gets no question tool.
 * - It reads the memory the source folder's sessions read, and cannot
 *   change it. A Claude variant whose own memory is still on runs with
 *   Claude's memory and without ours - see `ownMemory`.
 * - A turn's end tells the Evaluator page, not the notices.
 */
export class EvalChatHost extends ServerChatHost {

    /**
     * @param store The evaluation's own saved values - each variant's
     *              runtime and model pick.
     */
    constructor(
        server: HostServer,
        private readonly saved: Pick<SavedEval, "name" | "folder">,
        private variant: EvalVariant,
        store: ChatStore
    ) {

        super(server, { folders: [variant.folder], scratch: false }, store);
    }

    /** The evaluation this variant belongs to. */
    get evalName(): string {

        return this.saved.name;
    }

    /** Nothing is written to `sessions/`: the evaluation's file says where the variant works. */
    protected override save(): void {

        // On purpose.
    }

    /** A variant's folder is its copy for good: nothing changes it. */
    override setFolders(_folders: readonly string[]): void {

        // On purpose.
    }

    override unattended(): boolean {

        return true;
    }

    /** The variant's chat file is filed under the evaluation's own folder, apart from every normal session. */
    override historyKey(): string | undefined {

        return evalDir(this.saved.name);
    }

    override scratchFolder(): string {

        return evalScratchDir(this.saved.name, this.variant.name);
    }

    /**
     * Every call inside the copy runs without a card; one outside it is
     * refused. No saved answer is read or written: nobody is asked.
     */
    protected override gate(provider: string, workingDirectory: string): PermissionGate | undefined {

        if (!this.chat)
            return undefined;

        return createPermissionGate({
            provider,
            acp: isAcpRuntime(provider),
            chatId: this.chat.chatId,
            workingFolder: workingDirectory,
            level: () => "auto",
            book: this.server.answers,
            addFolder: () => undefined,
            unattended: true
        });
    }

    /** What a session in the source folder would read: its workspace's memories and the folder's. */
    override memoryPlace(): SessionPlace {

        const workspace = sessionWorkspace(this.server.store, undefined, this.saved.folder);

        return {
            ...(workspace ? { workspace: { key: workspaceKey(workspace), name: workspace.name } } : {}),
            folders: [this.saved.folder]
        };
    }

    override systemInstructions(provider: string): string | undefined {

        const standing = super.systemInstructions(provider);

        return standing && this.ownMemory() ? `${standing}\n\n${MEMORY_READ_ONLY}` : standing;
    }

    /**
     * Ours is off for a Claude variant while Claude's own memory is on
     * (Settings, Connectors, Memory): the variant runs with Claude's
     * memory alone. Two memories would not agree, and nobody can be
     * asked which one to turn off. Every other variant has ours, to read.
     */
    override ownMemory(): boolean {

        return super.ownMemory() && !claudeWaits(this.variant.provider, this.server.memory.choices());
    }

    /** Claude's own memory is turned off only for a variant that has ours. */
    protected override sessionEnv(provider: string): Record<string, string> {

        return this.ownMemory() ? super.sessionEnv(provider) : {};
    }

    /**
     * The picker at the foot of the variant's column was used, before
     * its first message: the evaluation's own file gets the new setup,
     * so the column's head, the report and a later copy all show it.
     * With no pick the variant keeps the runtime it has.
     */
    async picked(pick: { provider: string; model?: string; mode?: string; effort?: string } | undefined): Promise<void> {

        const saved = readEval(this.saved.name);
        const variant = saved?.variants.find(one => one.chatId === this.variant.chatId);

        if (!saved || !variant || !pick)
            return;

        const { model: _model, mode: _mode, effort: _effort, ...kept } = variant;

        void _model; void _mode; void _effort;

        const next: EvalVariant = {
            ...kept,
            provider: pick.provider,
            ...(pick.model ? { model: pick.model } : {}),
            ...(pick.mode ? { mode: pick.mode } : {}),
            ...(pick.effort ? { effort: pick.effort } : {})
        };

        writeEval({ ...saved, variants: saved.variants.map(one => one === variant ? next : one) });

        // Which memory the variant has depends on its runtime - see `ownMemory`.
        this.variant = next;

        this.server.evalChanged(this.saved.name);
    }

    /**
     * The box at the foot of the variant's column, before its message:
     * Enter saves the text as the variant's own text, added under the
     * common message when Send to all is pressed. Empty clears it. Once
     * the variant got its message nothing is saved, and the box keeps
     * what was typed.
     */
    async variantText(text: string): Promise<string> {

        const note = (said: string) => { if (this.chat) this.server.toPage(this.chat, { type: "eesha.note", text: said }); };

        const saved = readEval(this.saved.name);
        const variant = saved?.variants.find(one => one.chatId === this.variant.chatId);

        if (!saved || !variant)
            return text;

        const started = this.chat?.working === true || listChats(evalDir(saved.name)).some(chat => chat.id === variant.chatId);

        if (started) {

            note(VARIANT_TEXT_LOCKED);

            return text;
        }

        const kept = text.trim().slice(0, EVAL_TEXT_MAX);
        const { extra: _extra, ...rest } = variant;

        void _extra;

        const next: EvalVariant = { ...rest, ...(kept ? { extra: kept } : {}) };

        writeEval({ ...saved, variants: saved.variants.map(one => one === variant ? next : one) });

        this.variant = next;
        this.server.evalChanged(this.saved.name);

        note(kept ? VARIANT_TEXT_SAVED : "This variant's own text is cleared.");

        return kept;
    }

    variantDraft(): string | undefined {

        return readEval(this.saved.name)?.variants.find(one => one.chatId === this.variant.chatId)?.extra;
    }

    /** Never asks, and never holds a turn back - see {@link ownMemory}. */
    override async beforeTurn(_provider: string): Promise<string | undefined> {

        return undefined;
    }

    /** A turn ended. No session is read from `sessions/` - a variant has none there. */
    override async changed(chat: ChatController): Promise<void> {

        this.server.chatChanged(chat);
        this.server.evalChanged(this.saved.name);
    }

    /** Going back keeps no copy of the variant's chat among the sessions. */
    override copied(_fromId: string, _toId: string): void {

        // On purpose.
    }

    /** No notice: the Evaluator page shows which variants work and which are done. */
    override notify(_chat: ChatController, _notice: ChatNotice): void {

        this.server.evalChanged(this.saved.name);
    }
}
