import { AgentEvent, AgentSession } from "./AgentSession";

/**
 * The live conversations this engine is holding.
 *
 * A task lasts one call; the conversations it starts are joined by
 * people and outlive it. So tasks start sessions and leave them here,
 * surfaces subscribe here rather than to a task, and lifetime is a
 * policy stated at handover rather than a `finally` in the caller.
 */

/** A session being held, and what it was started for. */
export interface LiveSession {

    readonly id: string;

    /**
     * What this conversation belongs to - a spec folder, a run, a task.
     * Opaque to this registry, which only ever groups by it.
     */
    readonly ownerId: string;

    readonly session: AgentSession;

    readonly startedAt: number;
}

/** How long a detached session is kept. */
export interface HoldPolicy {

    /**
     * Release when the agent stops working.
     *
     * Note what idle means per phase: for a conversation that opens
     * with a question it arrives seconds in; for one handed a task
     * list, when the list is finished.
     */
    untilIdle?: boolean;

    /**
     * A backstop, in milliseconds, so a session that never reports idle
     * is not held forever. Not a work timeout - the task's own
     * `timeout:` is that.
     */
    maxHoldMs?: number;
}

/**
 * What became of a session this registry no longer holds.
 *
 * `replaced` is a second hold on the same id - the ordinary case when a
 * task hands the same session over twice. The other two are real
 * endings.
 */
export type DepartureReason = "ended" | "forgotten" | "replaced";

/** A session that has left the registry, and when. */
export interface Departure {

    reason: DepartureReason;

    at: number;
}

/**
 * How many departures are remembered. A diagnostic, not a record - old
 * ones are dropped oldest first once the list is full.
 */
const DEPARTURE_LIMIT = 50;

export class AgentSessions {

    private readonly live = new Map<string, LiveSession>();

    /**
     * Why the sessions that have left are no longer here, so `ai@1`
     * can tell "it ended" from "it was never here" when a
     * `continueSession` cannot be honoured.
     */
    private readonly departed = new Map<string, Departure>();

    private readonly unsubscribes = new Map<string, () => void>();

    private readonly listeners = new Set<(id: string, event: AgentEvent) => void>();

    /**
     * @param now Injected so a test can pin it, and so nothing in the
     * engine reaches for the clock directly.
     */
    constructor(private readonly now: () => number = () => Date.now()) { }

    /**
     * Takes a session over from the task that started it. Everything it
     * emits from here on is republished to this registry's subscribers.
     */
    hold(ownerId: string, session: AgentSession, policy: HoldPolicy = {}): LiveSession {

        this.release(session.id, "replaced");

        const entry: LiveSession = { id: session.id, ownerId, session, startedAt: this.now() };

        this.live.set(session.id, entry);

        const timer = policy.maxHoldMs !== undefined
            ? setTimeout(() => void this.end(session.id), policy.maxHoldMs)
            : undefined;

        const stop = session.on(event => {

            for (const listener of [...this.listeners])
                listener(session.id, event);

            if (policy.untilIdle && event.kind === "idle")
                void this.end(session.id);
        });

        this.unsubscribes.set(session.id, () => {

            stop();

            if (timer !== undefined)
                clearTimeout(timer);
        });

        return entry;
    }

    get(id: string): AgentSession | undefined {

        return this.live.get(id)?.session;
    }

    /** Everything held for one owner, newest first. */
    forOwner(ownerId: string): LiveSession[] {

        return [...this.live.values()]
            .filter(entry => entry.ownerId === ownerId)
            .sort((left, right) => right.startedAt - left.startedAt);
    }

    all(): LiveSession[] {

        return [...this.live.values()];
    }

    /** Every event from every held session. Returns its own unsubscribe. */
    on(listener: (id: string, event: AgentEvent) => void): () => void {

        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    /**
     * Lets a held session go, and disposes it. Disposal ends this
     * engine's hold, not the conversation - the provider keeps its
     * state, so it can be reopened.
     */
    async end(id: string): Promise<void> {

        const entry = this.live.get(id);

        this.release(id, "ended");

        if (!entry)
            return;

        try {

            await entry.session.dispose();

        } catch {

            // Not worth failing a run over: the work is already done.
        }
    }

    /**
     * Lets a held session go without touching it, for a caller that
     * already ended it another way (a `delete`, say). A hold left behind
     * is a dead entry a surface could still find.
     */
    forget(id: string): void {

        this.release(id, "forgotten");
    }

    /** Ends everything - for shutting the engine down. */
    async endAll(): Promise<void> {

        await Promise.all(this.all().map(entry => this.end(entry.id)));
    }

    /**
     * What became of a session this registry is not holding.
     *
     * `undefined` means it has never been held here at all - a stale id
     * from an earlier window, not a conversation that ended.
     */
    departureOf(id: string): Departure | undefined {

        return this.departed.get(id);
    }

    private release(id: string, reason?: DepartureReason): void {

        this.unsubscribes.get(id)?.();
        this.unsubscribes.delete(id);

        // `hold` releases before it stores, so an id arriving for the
        // first time must not be recorded as having left.
        if (this.live.delete(id) && reason)
            this.remember(id, reason);
    }

    private remember(id: string, reason: DepartureReason): void {

        this.departed.delete(id);
        this.departed.set(id, { reason, at: this.now() });

        // Drops the oldest first; insertion order gives that.
        while (this.departed.size > DEPARTURE_LIMIT)
            this.departed.delete(this.departed.keys().next().value as string);
    }
}
