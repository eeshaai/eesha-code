import React, { useState } from "react";

import { Button, Modal } from "../view/ui";
import { EVAL_VARIANTS_MAX } from "../server/protocol";

/*
 * The Evaluator's help: a Help button that opens a window with how the
 * page works. It keeps the pages themselves free of explaining text.
 */

/** Which page the help is for. */
export type EvalHelpPage = "list" | "live" | "report";

const TITLES: Record<EvalHelpPage, string> = {
    list: "New evaluation",
    live: "Live",
    report: "Report"
};

function lines(page: EvalHelpPage, taskFolder: string): string[] {

    switch (page) {

        case "list":
            return [
                "One message goes to every variant at once: a common part, and each variant's own text under it. Each variant works in its own copy of the folder, so nothing it does touches your folder.",
                "Nobody is asked: what a variant does inside its copy runs, and anything outside its copy is refused.",
                "Name: you open the evaluation again with this name. Letters, digits, - and _ only, up to 60.",
                "Folder in git: each copy starts from the folder as it is now, with your uncommitted changes. Not in git: a plain copy of the files.",
                `Up to ${EVAL_VARIANTS_MAX} variants. A variant with no name gets the evaluation's name and a number. You can add more later.`,
                "Create evaluation makes the copies and opens the evaluation. Nothing is sent to an agent yet."
            ];

        case "live":
            return [
                "Each variant gets one message, never a second: a second message would spoil the comparison. To try something else, use Copy as new variant.",
                "A variant's message is the common message at the top, then a blank line, then the variant's own text. Either can be empty, not both. With the top box empty, each variant gets only its own text.",
                "The box at the foot of a column is that variant's own text. Enter saves it, it does not send. The column's head then says \"own text\"; Clear text there removes it. The same box picks the variant's runtime, mode, model and effort.",
                "Send to all sends every variant its message at the same moment. After that the top box keeps the common message, locked, as it was sent, and the column boxes are off.",
                "Send to new variants: shown when a variant was added after the first send. It sends the kept common message with the new variant's own text, saved task lines included, only to the new ones. The others are left alone, and may still be working.",
                "A saved task's closing lines come last, after the variant's own text.",
                "Remove (in a column's head): removes that variant, its copy and its chat. Not while it works, and not the last one.",
                "Copy as new variant: a new variant with the same setup, for you to change one thing. The old variant stays as it was.",
                "Add variant: in git, its copy starts from the commit the evaluation started from - the same files the others got. Not in git: a copy of the folder as it is today. Nothing is sent to it.",
                "Saved task: a Find task adds lines that tell every variant to change no file and to list what it found in one form. A Fix task tells it to fix what it finds and list it the same way. The report then shows the lists side by side. A task with no kind is sent as it is.",
                `Your own tasks: one .md file each in ${taskFolder || "~/.eesha/eval-tasks"}.`,
                "Runs without asking: a tool call inside the variant's copy runs, one outside it is refused."
            ];

        case "report":
            return [
                "Each column is one variant's one message: from sending it until the agent stopped.",
                "Runtime version and Model used: what the runtime said when the message was sent and while it worked, so a report read months later says what each variant ran on. A dash: the runtime did not say.",
                "Changed files and sizes are counted only when no variant works: counting reads every file of every copy, which would slow the variants being timed.",
                "Green is the lowest value in its row, only in the rows where lower is plainly better: total time, cost, failed tool calls and refused calls. Tool calls, their time, turns and tokens get no green: fewer can just mean the variant did less, and each model counts tokens its own way. Green is not a verdict: a variant can be fastest because it did less. A row is not coloured when all values are the same.",
                "A dash means the runtime does not give that number. \"So far\" means a turn is still running. Hold the pointer on a row's name to read what it counts.",
                "Findings: the problems each variant listed in its answer to a saved Find or Fix task. One row per file and line, one cell per variant. It shows who listed what; it does not say which finding is right.",
                "Where the time went: time inside tool calls, by kind of call. Press a kind to list every call in it.",
                "Files each variant changed: an empty cell means that variant left the file as it was. To see a change itself, open the variant's copy in ~/.eesha/evals and run git diff there."
            ];
    }
}

export default function EvalHelp({ page, taskFolder = "" }: { page: EvalHelpPage; taskFolder?: string }): React.JSX.Element {

    const [open, setOpen] = useState(false);

    return (
        <>
            <Button size="sm" fill="ghost" variant="secondary" onClick={() => setOpen(true)}>Help</Button>
            <Modal show={open} centered onHide={() => setOpen(false)}>
                <Modal.Header closeButton onClose={() => setOpen(false)}>
                    <Modal.Title>{TITLES[page]}: how it works</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    <ol className="evals__help">
                        {lines(page, taskFolder).map(line => <li key={line}>{line}</li>)}
                    </ol>
                </Modal.Body>
            </Modal>
        </>
    );
}
