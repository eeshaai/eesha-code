import { createPermissionGate, type PermissionGate } from "../core/agent/permissions";
import type { ChatController } from "../chat/ChatController";
import type { ChatNotice } from "../chat/chatHost";
import type { ChatStore } from "../chat/chatStore";
import { isAcpRuntime } from "../chat/permissionLevels";
import { evalDir, evalScratchDir, type EvalVariant, type SavedEval } from "./evals";
import { claudeWaits } from "./memory/claudeMemory";
import type { SessionPlace } from "./memory/Memory";
import { workspaceKey } from "./protocol";
import { type HostServer, ServerChatHost } from "./ServerChatHost";
import { sessionWorkspace } from "./workspaces";

/** Told to the agent beside the memory's own lines: it can read here, never save. */
const MEMORY_READ_ONLY = "In this session the memory can be read but not changed: memory_save and memory_delete are refused.";

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
        private readonly variant: EvalVariant,
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
