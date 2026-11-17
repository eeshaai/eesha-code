import * as path from "path";

import type { Plan } from "../documents/parsePlan";
import type { HandedTask } from "../phase/assemble";
import { splitWave } from "../phase/waves";
import type { TaskRun } from "../../shared/taskRun";

/*
 * A lane: one step of a plan being implemented - the agent tasks of a
 * wave in one chat, or one `Run:` task - and the small rules about it
 * that the spec controller and the implementation run both use.
 */

/**
 * One step of the plan on its way to being worked, or being worked -
 * see `ImplementRun.implement`. Either the agent tasks of a wave that
 * sit next to each other, in one chat, or a single `Run:` task.
 */
export interface Lane {

    /** The stage its chat's lines are filed under - the implement stage. */
    stageId: string;

    /** The agent tasks of the chat, or the one `Run:` task. */
    wave: HandedTask[];

    /** Queued until every lane before it is done and every earlier task is ticked; starting while its chat opens. */
    state: "queued" | "starting" | "running";

    /** The runtime's conversation, once the chat's turn has opened one. */
    sessionId?: string;

    /** The phase chat the lane's work runs in, once made - see `ImplementRun.startLane`. */
    chatId?: string;

    /**
     * 1 for the first chat of a wave, 2 for the next, and so on. A wave
     * gets a second chat only when a `Run:` task sits between its agent
     * tasks; the number keeps the two chats' logs apart.
     */
    part?: number;

    /**
     * A `Run:` lane that moves on only when a person ticks its box: a
     * task done by hand, or a command whose exit code the terminal could
     * not report.
     */
    waitsForTick?: boolean;
}

/** The `Run:` line of a lane's one task, when the lane is a `Run:` task rather than a chat. */
export function laneRun(lane: Lane): TaskRun | undefined {

    return lane.wave.length === 1 ? lane.wave[0].run : undefined;
}

/**
 * The lanes one wave becomes - see `splitWave` - with each chat of the
 * wave numbered, so a wave's second chat is filed apart from its first.
 */
export function lanesOfWave(stageId: string, wave: HandedTask[]): Lane[] {

    let part = 0;

    return splitWave(wave).map(step => step.length === 1 && step[0].run
        ? { stageId, wave: step, state: "queued" as const }
        : { stageId, wave: step, state: "queued" as const, part: ++part });
}

/**
 * Where a lane's chat lines are filed: the stage, then the wave or the
 * task - `implement@wave:2`, `implement@1.4`. The view reads every
 * bucket under the stage as one chat each.
 */
export function laneBucket(lane: Lane): string {

    return chatBucket(lane.stageId, laneTask(lane));
}

/**
 * What a lane's chat is filed against on record: the task's own id
 * when it got one task, `wave:<n>` when it got a whole wave -
 * `wave:<n>-<part>` for a wave's second chat onwards. The same string
 * `TaskSession.task` carries, so a bucket can be rebuilt from the
 * record alone once the lane is gone.
 */
export function laneTask(lane: Lane): string {

    const waveId = lane.wave[0].wave;

    if (lane.wave.length === 1 || waveId === undefined)
        return lane.wave[0].id;

    return lane.part && lane.part > 1 ? `wave:${waveId}-${lane.part}` : `wave:${waveId}`;
}

/**
 * Every path the plan's `Files:` lines name for these tasks, and for
 * the sub-tasks under them, once each.
 */
export function filesOfWave(plan: Plan | undefined, wave: readonly { id: string }[]): string[] {

    const ids = wave.map(task => task.id);

    return [...new Set((plan?.tasks ?? [])
        .filter(task => ids.some(id => task.id === id || task.id.startsWith(`${id}.`)))
        .flatMap(task => task.files))];
}

/** The bucket for a chat on record - see {@link laneBucket}. */
export function chatBucket(stageId: string, task: string): string {

    return `${stageId}@${task}`;
}

/**
 * A folder as a workflow param holds it: relative to the workspace
 * with forward slashes when inside it, absolute otherwise - the same
 * shape the params prompt writes for a picked folder.
 */
export function portable(folder: string, workspace: string): string {

    const relative = path.relative(workspace, folder);

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
        return relative.split(path.sep).join("/");

    return relative ? folder.split(path.sep).join("/") : ".";
}
