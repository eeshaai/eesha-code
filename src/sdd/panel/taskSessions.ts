import { TaskSession } from "../../shared/runMessages";
import type { SddStore } from "./sddHost";

/**
 * The implementation chats behind a spec.
 *
 * Every session started here goes through the plugin, which
 * returns the provider's own id, so a chat can always be pointed at
 * again.
 *
 * Kept in the workspace's store so they survive a reload, and
 * best-effort: a teammate's spec was implemented on their machine, so
 * their chats were never here and the view offers no button for work
 * with no entry.
 *
 * A phase's conversation is not here - it lives in the spec's own
 * events file (`SddController.sessionOpened`). Implementation chats stay
 * here because only this map can say a chat is already working a task.
 */

const TASKS_KEY = "sdd.styles.taskSessions";

export function taskSessions(store: SddStore, specName: string): TaskSession[] {

    return store.get<Record<string, TaskSession[]>>(TASKS_KEY)?.[specName] ?? [];
}

/** Appended, never replaced: a task started twice has two chats and both are real. */
export async function rememberTaskSession(store: SddStore, specName: string, session: TaskSession): Promise<void> {

    const all = store.get<Record<string, TaskSession[]>>(TASKS_KEY) ?? {};

    await store.update(TASKS_KEY, { ...all, [specName]: [...(all[specName] ?? []), session] });
}

/**
 * Marks a chat as finished, because the agent in it stopped working.
 *
 * Recorded rather than inferred: a chat this app is no longer holding
 * could equally be one from a previous run, and the two mean
 * different things to a row that is deciding whether to say "in chat…".
 */
export async function endTaskSession(store: SddStore, specName: string, sessionId: string): Promise<void> {

    await markTaskSession(store, specName, sessionId, true);
}

/**
 * A wave chat's turn ended: its record says so, and gets the runtime's
 * conversation when the turn opened one. Found by the phase chat's id.
 */
export async function endChatTask(store: SddStore, specName: string, chatId: string, held?: { sessionId: string; provider?: string }): Promise<void> {

    const all = store.get<Record<string, TaskSession[]>>(TASKS_KEY) ?? {};

    const updated = (all[specName] ?? []).map(entry => entry.chatId !== chatId
        ? entry
        : { ...entry, ended: true, ...(held ? { sessionId: held.sessionId, ...(held.provider ? { provider: held.provider } : {}) } : {}) });

    await store.update(TASKS_KEY, { ...all, [specName]: updated });
}

/** A wave chat is working again - a message typed into it. Its next end ends it again. */
export async function reopenChatTask(store: SddStore, specName: string, chatId: string): Promise<void> {

    const all = store.get<Record<string, TaskSession[]>>(TASKS_KEY) ?? {};

    const updated = (all[specName] ?? []).map(entry => {

        if (entry.chatId !== chatId)
            return entry;

        const { ended: _ended, ...working } = entry;

        return working;
    });

    await store.update(TASKS_KEY, { ...all, [specName]: updated });
}

/**
 * Marks a finished chat as working again, because a message was sent
 * into it and its agent is back on it. Its next stop ends it again.
 */
export async function reopenTaskSession(store: SddStore, specName: string, sessionId: string): Promise<void> {

    await markTaskSession(store, specName, sessionId, false);
}

async function markTaskSession(store: SddStore, specName: string, sessionId: string, ended: boolean): Promise<void> {

    const all = store.get<Record<string, TaskSession[]>>(TASKS_KEY) ?? {};

    const updated = (all[specName] ?? []).map(entry => {

        if (entry.sessionId !== sessionId)
            return entry;

        if (ended)
            return { ...entry, ended: true };

        // Left off rather than set false, the way a chat that never
        // ended is written.
        const { ended: _ended, ...working } = entry;

        return working;
    });

    await store.update(TASKS_KEY, { ...all, [specName]: updated });
}

/**
 * The chats already working any of these tasks, newest first.
 *
 * A chat that has ended does not count, which is what stops the
 * duplicate-chat warning firing forever once a spec has been
 * implemented once. A wave's chat counts for every task it was handed.
 */
export function chatsWorking(store: SddStore, specName: string, taskIds: string[]): TaskSession[] {

    return taskSessions(store, specName)
        .filter(session => !session.ended)
        .filter(session => works(session, taskIds))
        .sort((left, right) => right.at - left.at);
}

/** Whether this chat was handed any of these tasks. */
export function works(session: TaskSession, taskIds: string[]): boolean {

    return taskIds.includes(session.task)
        || (session.tasks ?? []).some(id => taskIds.includes(id));
}
