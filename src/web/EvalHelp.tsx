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
                "Everything is typed here: the common message, and each variant's setup and own text. The evaluation's page only shows the run - nothing is typed there.",
                "One message goes to every variant at once: the common message, then a blank line, then the variant's own text. Either can be empty, not both. A saved task's closing lines come last.",
                "Each variant gets one message, never a second: a second message would spoil the comparison.",
                "Each variant works in its own copy of the folder, so nothing it does touches your folder. Nobody is asked: what a variant does inside its copy runs, and anything outside its copy is refused.",
                "Name: you open the evaluation again with this name. Letters, digits, - and _ only, up to 60.",
                "Folder in git: each copy starts from the folder as it is now, with your uncommitted changes, without the older history. Not in git: a plain copy of the files.",
                `Up to ${EVAL_VARIANTS_MAX} variants. A variant with no name gets the evaluation's name and a number. You can add more later.`,
                "Saved task: a Find task adds lines that tell every variant to change no file and to list what it found in one form. A Fix task tells it to fix what it finds and list it the same way. The report then shows the lists side by side. A task with no kind is sent as it is.",
                `Your own tasks: one .md file each in ${taskFolder || "~/.eesha/eval-tasks"}.`,
                "Create and send makes the copies, sends every variant its message at the same moment, and opens the evaluation."
            ];

        case "live":
            return [
                "This page only shows the run. The message and each variant's setup were set when the evaluation was made; nothing is typed here.",
                "The top shows the common message and the saved task, as they were sent. A column's head shows its setup; hold the pointer on it to read the variant's own text.",
                "Stop (in a column's head, while it works): ends that variant's turn. The report then says it was stopped, and gives it no green.",
                "Send to all: shown only when the message did not go when the evaluation was made. It sends the kept message.",
                "Add variant: a new variant with its setup and own text. In git, its copy starts from the commit the evaluation started from - the same files the others got. Not in git: a copy of the folder as it is today. Then Send to new variants sends it the kept common message with its own text, saved task lines included. The others are left alone, and may still be working.",
                "Copy as new variant: a new variant with the same setup and own text, for you to change one thing. The old variant stays as it was.",
                "Retry (in a column's head, once it got its message): runs that variant again from the start. Its old copy, chat and numbers are thrown away; it gets a new copy from where the evaluation started (not in git: your folder as it is today) and the same message. Its name and setup stay. Not while it works.",
                "Remove (in a column's head): removes that variant, its copy and its chat. Not while it works, and not the last one.",
                "Runs without asking: a tool call inside the variant's copy runs, one outside it is refused."
            ];

        case "report":
            return [
                "Each column is one variant's one message: from sending it until the agent stopped.",
                "Runtime version and Model used: what the runtime said when the message was sent and while it worked, so a report read months later says what each variant ran on. A dash: the runtime did not say.",
                "Changed files and sizes are counted only when no variant works: counting reads every file of every copy, which would slow the variants being timed.",
                "Green is the lowest value in its row, only in the rows where lower is plainly better: total time, cost, failed tool calls and refused calls. Tool calls, their time, turns and tokens get no green: fewer can just mean the variant did less, and each model counts tokens its own way. Green is not a verdict: a variant can be fastest because it did less. A row is not coloured when all values are the same. A variant you stopped, or one that failed, gets no green: it did less.",
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
