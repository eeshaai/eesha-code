import { Providers } from "../core/agent/providerArgs";
import { type AnswerBook, createPermissionGate, type PermissionGate } from "../core/agent/permissions";
import { isPermissionLevel, levelFor, PermissionLevel } from "../core/models/permissionCard";
import type { ChatStore } from "./chatStore";

/*
 * The Permissions level picked per provider. Kept in the
 * chat store, one value per provider id, for every chat on the server.
 */

const LEVELS_KEY = "eesha.permissionLevels";

/** Whether a provider id is an ACP agent: anything but the two SDK runtimes. */
export function isAcpRuntime(provider: string): boolean {

    return !(Providers as readonly string[]).includes(provider);
}

/** Every level saved, by provider id. Shape-checked: saved values outlive builds. */
export function readLevels(store: ChatStore): Record<string, PermissionLevel> {

    const stored = store.get<unknown>(LEVELS_KEY);

    if (!stored || typeof stored !== "object" || Array.isArray(stored))
        return {};

    return Object.fromEntries(
        Object.entries(stored as Record<string, unknown>)
            .filter((entry): entry is [string, PermissionLevel] => isPermissionLevel(entry[1])));
}

/** One provider's level now. Never set: Auto. */
export function readLevel(store: ChatStore, provider: string): PermissionLevel {

    return levelFor(readLevels(store)[provider], isAcpRuntime(provider));
}

/** The level and kind of every runtime in the list, as the compose row's Permissions picker needs them. */
export function levelsOf(
    store: ChatStore,
    providers: readonly string[]
): Record<string, { level: PermissionLevel; acp: boolean }> {

    return Object.fromEntries(providers.map(provider =>
        [provider, { level: readLevel(store, provider), acp: isAcpRuntime(provider) }]));
}

/**
 * The permission check of one session: the level picked for its runtime,
 * read on every call, and the saved answers of the server. The same for a
 * chat and for a spec's phase, so both follow one picker.
 */
export function levelGate(options: {
    store: ChatStore;
    book: AnswerBook;
    provider: string;
    chatId: string;
    workingFolder: string;
    addFolder(folder: string): void;
}): PermissionGate {

    return createPermissionGate({
        provider: options.provider,
        acp: isAcpRuntime(options.provider),
        chatId: options.chatId,
        workingFolder: options.workingFolder,
        level: () => readLevel(options.store, options.provider),
        book: options.book,
        addFolder: options.addFolder
    });
}

export async function writeLevel(store: ChatStore, provider: string, level: PermissionLevel): Promise<void> {

    await store.update(LEVELS_KEY, { ...readLevels(store), [provider]: level });
}
