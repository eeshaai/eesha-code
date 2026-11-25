import { SpecStage } from "../../shared/runMessages";

/**
 * What refuses a press, and the sentence it is refused with.
 *
 * Which documents count (the style's `blockOnOpenQuestions:`, the
 * idea exemption, what an answer looks like) is settled in
 * `sdd/documents/openQuestions.ts` and the panel. A stage arrives here
 * with `openQuestions` only when it has something to refuse over. This
 * file decides which press each one stops.
 *
 * A phase is never blocked by its own questions: running it again over
 * the answers is how they get folded in. Only the phases after it are
 * refused. The execution phase comes last, so the plan's controls are
 * blocked by every drafting document, `tasks.md` included.
 */

/** The stages whose documents hold an unanswered question, among those before `stageName`. */
export function questionsBefore(stages: SpecStage[], stageName: string | undefined): SpecStage[] {

    if (!stageName)
        return [];

    const index = stages.findIndex(stage => stage.name === stageName);

    return stages
        .slice(0, index < 0 ? 0 : index)
        .filter(stage => stage.openQuestions?.length);
}

/**
 * Why starting `stageName` is refused, or `undefined` when it is not.
 *
 * The sentence names the documents and the ids, so a disabled button
 * does not look broken, and says how to lift it: one line typed into
 * the document, not another pass of the model.
 *
 * @param fileName How to name a document to a reader - the panel's own
 * path-to-filename, passed in so this file needs nothing from the host.
 */
export function blockedBy(
    stages: SpecStage[],
    stageName: string | undefined,
    fileName: (path: string) => string
): string | undefined {

    const blocking = questionsBefore(stages, stageName);

    if (!blocking.length)
        return undefined;

    const named = blocking.map(stage => {

        // A question with no id still blocks - see `openQuestions.ts`.
        // Numbered by position so the sentence can point at it.
        const ids = (stage.openQuestions ?? [])
            .map((question, at) => question.id ?? `question ${at + 1}`)
            .join(", ");

        return `${stage.artifact ? fileName(stage.artifact) : stage.name} (${ids})`;
    });

    return `Answer the open questions in ${named.join(" and ")} first - `
        + "write an A: line under each, then this button comes back.";
}
