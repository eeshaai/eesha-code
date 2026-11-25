/*
 * Editing on the SDD run view's Doc and Prompt tabs: opening a block
 * for edit and saving it, saving or dropping the prompt, the prompt's
 * outline, going to a line, adding, resolving and removing review
 * notes, and how links and plan rows are drawn inside a document.
 *
 * Part of SddRunView - see runState.tsx for how the parts fit.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { Components } from "react-markdown";
import { Button, Checkbox, CommentBox, UiIcon } from "../../view/ui";
import { indent, link, wrap } from "./mdKeys";
import { chainAt, outlineOf, sectionAt } from "./outline";
import { useScrolledLine } from "./scrolledLine";
import { AnchoredNote, anchorFor } from "../../view/templates/reviewNotes";
import { SpecRefLink as SpecRefLinkData, anchorId, matchesTarget, parseRefLabel, parseRefLink, resolveRef } from "./specRefs";
import { isTaskDone, pendingUnder, reposOf, SpecTask } from "./taskList";
import { FLASH, NEXT_TITLE, samePath, plainText, SpecRefLink, keepHereInView, fieldOf, applyToField, noteId } from "./runViewHelpers";
import type { RunState } from "./runState";
import type { ImplementState } from "./implementState";

export function useDocEditing(ctx: RunState & ImplementState) {

    const {
        specStages, documents, saveDocument, startTasks, runCommand, runningCommands, stopCommand, runWorkflow, workflows,
        queuedTasks, openFile, notes, saveNotes, docStage, artifact, promptPath, shownTab,
        setEditing, closing, setClosing, editorRef, blockRef, typeScale, pinned, setPinned,
        blockEdit, setBlockEdit, outlineOpen, noteEdit, setNoteEdit, setComposing, dropDraft, full,
        setFull, marks, setDrafts, draft, dirty, promptEditing, setPromptEditing, promptClosing,
        setPromptClosing, promptEditorRef, promptBodyRef, promptDraft, promptDirty, offset,
        previewsByArtifact, knownByArtifact, lineAnchors, fileLines, readingRef, inlinePlan,
        followCitation, flashing, setLaunched, chatFor, openChat, isWorking, blockedWork,
        inlineRowAt, unitById, toggleTask, handed, startUnit, outOfOrder
    } = ctx;

    /** The phase whose document is on screen - the half of an anchor id that says which document it belongs to. */
    const anchorScope = docStage?.name ?? "";

    /**
     * What every rendered block carries.
     *
     * `data-line` and `data-end` are the file's own numbering, offset
     * past the frontmatter. They are the whole reading surface: the
     * gutter measures them, hover and the pin select on them, a
     * double-click splices the source lines they name, the change bars
     * test them, and a note anchors to the text on them.
     *
     * The anchor id is kept, so a followed cross-reference lands on
     * the right block.
     */
    const blockProps = (node: { position?: { start: { line: number }; end: { line: number } } } | undefined) => {

        if (!node?.position)
            return {};

        const line = node.position.start.line;
        const anchor = lineAnchors.get(line);
        const file = line + offset;
        const last = node.position.end.line + offset;

        const classes = [
            anchor ? "sdd-ref-target" : "",
            pinned === file ? "sdd-block--pinned" : "",
            flashing.current.has(file) ? FLASH : ""
        ].filter(Boolean).join(" ");

        return {
            "data-line": file,
            "data-end": last,
            ...(anchor ? { id: anchorId(anchorScope, anchor) } : {}),
            ...(classes ? { className: classes } : {})
        };
    };

    /** The block a pointer event happened inside - or nothing, for a click on a control. */
    const blockOf = (target: EventTarget | null): HTMLElement | undefined => {

        const element = target as HTMLElement | null;

        // A reference control, a link or a field owns its own clicks.
        // Pinning the paragraph underneath one would fight the thing
        // that was actually pressed.
        if (!element || element.closest("button, a, input, textarea, select"))
            return undefined;

        return element.closest<HTMLElement>("[data-line]") ?? undefined;
    };

    /** The exact source of one block, ready to be edited. */
    const openBlock = (start: number, end: number) => {

        setBlockEdit({ start, end, text: fileLines.slice(start - 1, end).join("\n") });
    };

    /**
     * The draft with the open block spliced into it - or the draft
     * itself, when no block editor is open.
     *
     * Nothing here renumbers anything. The document re-renders from
     * the new text and react-markdown reports fresh positions, so an
     * edit that adds four lines simply renumbers what is below it.
     *
     * Split out of `commitBlock` because Ctrl+S has to write the block
     * you are typing in, and `setDrafts` cannot help with that: it
     * schedules the new draft rather than returning it, so a save in
     * the same handler would write the text as it was before the edit.
     */
    const withBlock = () => blockEdit
        ? [
            ...fileLines.slice(0, blockEdit.start - 1),
            ...blockEdit.text.split("\n"),
            ...fileLines.slice(blockEdit.end)
        ].join("\n")
        : draft;

    /**
     * The edited block kept.
     *
     * Into `drafts`, the same unsaved-changes channel the full editor
     * writes to - so one Save button covers both, and a block edit is
     * no more committed than a typed one until it is pressed.
     */
    const commitBlock = () => {

        if (!blockEdit || artifact === undefined)
            return setBlockEdit(undefined);

        setDrafts(previous => ({ ...previous, [artifact]: withBlock() }));
        setBlockEdit(undefined);
    };

    /**
     * The document written to disk, wherever the typing happened.
     *
     * An open block editor is committed on the way past, so Ctrl+S in
     * the middle of fixing a paragraph saves that paragraph rather
     * than silently skipping it.
     *
     * `close` is what separates the two keys. Ctrl+S means write this
     * to disk and nothing else - you press it mid-sentence and carry
     * on typing, and an editor that closed under you would be a bug.
     * Ctrl+Enter means done, the same as the Save button and the same
     * as Ctrl+Enter in the block editor.
     */
    const saveNow = (close: boolean) => {

        if (artifact === undefined)
            return;

        const text = withBlock();

        if (blockEdit) {

            setDrafts(previous => ({ ...previous, [artifact]: text }));
            setBlockEdit(undefined);
        }

        saveDocument(artifact, text);

        if (close)
            setEditing(false);
    };

    /** The block element for a file line, when it is on screen. */
    const elementAt = (line: number) =>
        readingRef.current?.querySelector<HTMLElement>(
            ".md-body [data-line=\"" + line + "\"]") ?? undefined;

    /**
     * The prompt written to disk.
     *
     * `close` separates the two keys exactly as it does for the
     * document: Ctrl+S writes and leaves you typing, Ctrl+Enter and the
     * Save button write and close.
     */
    const savePrompt = (close: boolean) => {

        if (promptPath === undefined)
            return;

        saveDocument(promptPath, promptDraft);

        if (close)
            setPromptEditing(false);
    };

    /** The prompt's unsaved changes, dropped - and its editor closed. */
    const discardPrompt = () => {

        if (promptPath === undefined)
            return;

        setDrafts(previous => {

            const { [promptPath]: dropped, ...rest } = previous;

            return rest;
        });

        setPromptEditing(false);
        setPromptClosing(false);
    };

    /** The prompt's headings, read off its text the same way the document's are. */
    const promptOutline = useMemo(() => outlineOf(promptDraft), [promptDraft]);

    /** The line at the top of the prompt pane - only headings carry one there, which is all the outline needs. */
    const promptScroll = useScrolledLine(promptBodyRef, [promptPath, promptDraft, promptEditing, full, typeScale, shownTab]);

    const promptSection = sectionAt(promptOutline, promptScroll.top ?? 0);

    const promptChain = useMemo(() => chainAt(promptOutline, promptScroll.top ?? 0), [promptOutline, promptScroll.top]);

    const promptOutlineBodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => keepHereInView(promptOutlineBodyRef.current), [promptSection?.line, outlineOpen]);

    /**
     * A source line on every rendered heading, so the outline has
     * something to scroll to.
     *
     * Only the headings. The document's own `blockProps` marks every
     * block because the gutter, the pin, the change bars and the notes
     * all select on it; none of that is here, and the outline is the
     * one thing that needs a target.
     *
     * Memoised with no dependencies because react-markdown treats these
     * as component types - a fresh object each render would remount the
     * whole prompt on every keystroke.
     */
    const promptHeadings = useMemo<Components>(() => {

        const heading = (tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
            ({ node, children, ...rest }: {
                node?: { position?: { start: { line: number } } };
                children?: React.ReactNode;
            }) => React.createElement(
                tag,
                { ...rest, "data-line": node?.position?.start.line },
                children);

        return {
            h1: heading("h1"),
            h2: heading("h2"),
            h3: heading("h3"),
            h4: heading("h4"),
            h5: heading("h5"),
            h6: heading("h6")
        };
    }, []);

    /** Scroll a prompt heading into view - what its outline entry does. */
    const goToPromptLine = (line: number) => {

        promptBodyRef.current
            ?.querySelector<HTMLElement>(".md-body [data-line=\"" + line + "\"]")
            ?.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    /**
     * Unsaved changes, dropped - and the editor closed if it was open.
     *
     * One act, because there is one draft: a block edited in place and
     * a document typed into the editor write to the same `drafts`
     * entry, so "throw away what I have not saved" cannot mean two
     * different things depending on where the typing happened.
     */
    const discardDraft = () => {

        if (artifact === undefined)
            return;

        setDrafts(previous => {

            const { [artifact]: dropped, ...rest } = previous;

            return rest;
        });

        setBlockEdit(undefined);
        setEditing(false);
        setClosing(false);
    };

    /** Move the pin one block, and bring it into view. */
    const stepPin = (direction: 1 | -1) => {

        if (marks.length === 0)
            return;

        const at = marks.findIndex(mark => mark.line === pinned);

        const next = at < 0
            ? marks[direction === 1 ? 0 : marks.length - 1]
            : marks[Math.min(marks.length - 1, Math.max(0, at + direction))];

        setPinned(next.line);
        elementAt(next.line)?.scrollIntoView({ block: "center", behavior: "smooth" });
    };

    /** Scroll a file line into view and pin it - what the outline and a note both do. */
    const goToLine = (line: number) => {

        // A note or a heading can name a line inside a block rather
        // than at its head. The nearest block at or above it is the
        // one that actually holds that text.
        const mark = marks.find(one => one.line === line)
            ?? [...marks].reverse().find(one => one.line <= line);

        setPinned(mark?.line ?? line);

        // Landed at the top of the pane, not its middle. A plan's task
        // group is one block that can be taller than the pane; centred,
        // its first line - the one that was clicked in the outline -
        // sits above the fold.
        if (mark)
            elementAt(mark.line)?.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    /** Put a note against a line. */
    const addNote = (line: number, text: string) => {

        if (artifact === undefined || !text.trim())
            return;

        saveNotes([
            ...notes,
            {
                id: noteId(),
                artifact,
                line,
                anchorText: anchorFor(draft, line),
                body: text.trim(),
                createdAt: new Date().toISOString()
            }
        ]);

        // Saved is not unsaved. Without this the draft outlives the note
        // it became, and the next + on that line offers the text back as
        // though it had never been written.
        dropDraft(line);

        setComposing(undefined);
    };

/**
     * What a note looks like, wherever it is drawn.
     *
     * The rail and the margin are two frames around the same thing, and
     * the actions on it - edit, resolve, delete - belong to the note,
     * not to the frame. Written once so a change to any of them cannot
     * land in one place and not the other.
     */
    const noteContents = (note: AnchoredNote) => {

        const editing = noteEdit?.id === note.id ? noteEdit : undefined;

        return (
            <CommentBox
                where={note.at === undefined ? "orphaned" : "line " + note.at + (note.moved ? " · moved" : "")}
                whereTitle={note.at === undefined
                    ? "The text this was written against is no longer in the document"
                    : note.moved
                        ? "This note followed its text - it was written against line " + note.line
                        : "Go to line " + note.at}
                whereLost={note.at === undefined}
                onWhereClick={() => note.at !== undefined && goToLine(note.at)}
                resolved={note.resolved}
                {...(editing
                    ? {
                        // As everywhere else: Escape closes the field and
                        // does not also drop the pin behind it - the box
                        // keeps the key to itself.
                        value: editing.text,
                        onChange: (text: string) => setNoteEdit({ ...editing, text }),
                        onSubmit: commitNote,
                        onCancel: () => setNoteEdit(undefined),
                        submitLabel: "Save",
                        autoFocus: true
                    }
                    : {
                        body: note.body,
                        actions: [
                            {
                                icon: "edit" as const,
                                label: "Edit this note",
                                title: "Rewrite this note",
                                onClick: () => setNoteEdit({ id: note.id, text: note.body })
                            },
                            {
                                icon: note.resolved ? "undo" as const : "check" as const,
                                label: note.resolved ? "Reopen this note" : "Resolve this note",
                                title: note.resolved ? "Reopen this note" : "Mark it dealt with",
                                onClick: () => setResolved(note.id, !note.resolved)
                            },
                            {
                                icon: "delete" as const,
                                label: "Delete this note",
                                onClick: () => removeNote(note.id)
                            }
                        ]
                    })} />
        );
    };

    /** The rewritten note, kept. Its anchor is untouched - the note still points where it pointed. */
    const commitNote = () => {

        if (!noteEdit?.text.trim())
            return;

        saveNotes(notes.map(note => note.id === noteEdit.id ? { ...note, body: noteEdit.text.trim() } : note));

        setNoteEdit(undefined);
    };

    /** Dealt with. Kept rather than deleted, so a document's review history survives it. */
    const setResolved = (id: string, resolved: boolean) => {

        saveNotes(notes.map(note => note.id === id ? { ...note, resolved } : note));
    };

    const removeNote = (id: string) => {

        saveNotes(notes.filter(note => note.id !== id));
    };

    /**
     * The Doc tab's keyboard, in one place.
     *
     * On the window rather than on the pane, so the reading keys work
     * without the reader having clicked into the document first -
     * which in a meeting they have not.
     *
     * In the CAPTURE phase, and that is not a detail. Other code on the
     * page may listen for keydown on this same window (the page's own
     * shortcuts, for one). It does not ask whether the default was
     * prevented, so `preventDefault` alone does not keep a key: Ctrl+B
     * typed into this editor could reach the page's shortcut and collapse
     * its side panel. A capture listener on the window runs before any
     * bubble listener on it, so `stopImmediatePropagation` on the
     * combinations we claim is what actually takes them. Everything we do
     * not claim passes through untouched, which is why Ctrl+Z and Ctrl+F
     * still work.
     *
     * Capture also puts this in front of each field's own React
     * `onKeyDown`, so anything claimed here has to be narrowed to the
     * exact field it is meant for - hence `editorRef` and `blockRef`.
     * The note composers are textareas too, and they keep their own
     * Escape and Ctrl+Enter.
     *
     * The reading keys below deliberately do NOT stop the event. An
     * expanded diagram listens for Escape on this same window, and
     * swallowing it here would leave the reader unable to close one.
     */
    useEffect(() => {

        const onKey = (event: KeyboardEvent) => {

            const target = (event.target as HTMLElement | null) ?? document.activeElement;
            const tag = target?.tagName;

            /** Handled here, and kept from the browser and from the page's own shortcuts. */
            const take = () => {

                event.preventDefault();
                event.stopImmediatePropagation();
            };

            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();

            /**
             * One of the two document editors - not a note composer.
             *
             * A note is a sentence about a block. Indenting it, or
             * making a word in it bold, is not something anybody has
             * wanted, and Tab there is better spent moving to the
             * Add button.
             */
            const area = target === editorRef.current
                || target === blockRef.current
                || target === promptEditorRef.current
                ? target as HTMLTextAreaElement
                : undefined;

            /*
             * The prompt editor's own keys - the same three the document
             * editor has, and the same markdown keys, over a file with
             * no blocks and no notes.
             *
             * Written out rather than folded into the branch below,
             * because that one is about `artifact`: its Ctrl+S commits
             * an open block and its Escape asks about `dirty`, and
             * neither means anything here.
             */
            if (shownTab === "prompt" && promptPath !== undefined) {

                // The close question, from the keyboard - see the doc
                // branch below for why this comes first.
                if (promptClosing) {

                    if (event.key === "Escape") {

                        take();
                        setPromptClosing(false);

                    } else if (mod && !event.shiftKey && key === "s") {

                        take();
                        setPromptClosing(false);
                        savePrompt(true);
                    }

                    return;
                }

                if (mod && !event.shiftKey && key === "s") {

                    take();

                    if (promptDirty)
                        savePrompt(false);

                    return;
                }

                if (area === promptEditorRef.current && area) {

                    if (event.key === "Tab") {

                        take();
                        applyToField(area, indent(fieldOf(area), event.shiftKey));

                        return;
                    }

                    if (mod && !event.shiftKey) {

                        const mark = key === "b" ? "**"
                            : key === "i" ? "*"
                                : key === "e" ? "`"
                                    : undefined;

                        if (mark) {

                            take();
                            applyToField(area, wrap(fieldOf(area), mark));

                            return;
                        }

                        if (key === "k") {

                            take();
                            applyToField(area, link(fieldOf(area)));

                            return;
                        }
                    }

                    if (mod && event.key === "Enter") {

                        take();
                        savePrompt(true);

                        return;
                    }

                    if (event.key === "Escape") {

                        take();

                        if (promptDirty)
                            setPromptClosing(true);
                        else
                            setPromptEditing(false);

                        return;
                    }
                }
            }

            // Everything below is about a document on screen. Ctrl+S
            // while reading a log belongs to the browser.
            if (shownTab === "doc" && artifact !== undefined) {

                /*
                 * The question about closing, answered from the
                 * keyboard.
                 *
                 * First, because focus is on one of its buttons rather
                 * than in a field - so without this, Escape would fall
                 * through to the reading keys and drop the pin behind
                 * the dialog instead of withdrawing the question.
                 *
                 * Ctrl+S here means the Save button. The question is
                 * "save your changes?", and the key that saves is the
                 * obvious way to say yes.
                 */
                if (closing) {

                    if (event.key === "Escape") {

                        take();
                        setClosing(false);

                    } else if (mod && !event.shiftKey && key === "s") {

                        take();
                        setClosing(false);
                        saveNow(true);
                    }

                    return;
                }

                /*
                 * Write it, wherever the typing happened - reading,
                 * in a block, or in the editor.
                 *
                 * Taken even when there is nothing to save. The key
                 * means "this document is saved" and it now is; letting
                 * it through to the browser on the one press where the
                 * document happens to be clean would make the same
                 * keystroke do two different things.
                 */
                if (mod && !event.shiftKey && key === "s") {

                    take();

                    if (dirty || blockEdit)
                        saveNow(false);

                    return;
                }

                if (area) {

                    // Tab indents rather than leaving the field. In a
                    // document of nested lists, leaving is wrong every
                    // single time.
                    if (event.key === "Tab") {

                        take();
                        applyToField(area, indent(fieldOf(area), event.shiftKey));

                        return;
                    }

                    if (mod && !event.shiftKey) {

                        // The set every markdown editor has. `e` for
                        // code is GitHub's; the obvious alternative,
                        // the backtick key, is not on every layout.
                        const mark = key === "b" ? "**"
                            : key === "i" ? "*"
                                : key === "e" ? "`"
                                    : undefined;

                        if (mark) {

                            take();
                            applyToField(area, wrap(fieldOf(area), mark));

                            return;
                        }

                        if (key === "k") {

                            take();
                            applyToField(area, link(fieldOf(area)));

                            return;
                        }
                    }
                }

                // The whole-document editor's own two. Narrowed to it
                // by the ref: the block editor and the note composers
                // mean something else by both keys, and capture would
                // otherwise take them first.
                if (target === editorRef.current) {

                    // Done. The same as the Save button, and the same
                    // as Ctrl+Enter in the block editor.
                    if (mod && event.key === "Enter") {

                        take();
                        saveNow(true);

                        return;
                    }

                    /*
                     * Out of the editor.
                     *
                     * Asking first when the draft is dirty is the whole
                     * reason `closing` exists. Escape everywhere else on
                     * this surface is free - it drops a pin, it closes a
                     * block - and it cannot start meaning "lose an hour
                     * of typing" in one place.
                     */
                    if (event.key === "Escape") {

                        take();

                        if (dirty)
                            setClosing(true);
                        else
                            setEditing(false);

                        return;
                    }
                }
            }

            // Below here is the reading keyboard, and a field holding
            // focus means the reader is typing rather than reading -
            // every arrow press inside a block editor would otherwise
            // also move the pin behind it.
            if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT")
                return;

            if (event.key === "Escape") {

                // The pin first. Escape to drop it while reading full
                // screen should not also throw you out of full screen -
                // that is two undos for one keypress.
                if (pinned !== undefined)
                    setPinned(undefined);
                else
                    setFull(false);

                return;
            }

            /*
             * Enter opens the pinned block for editing.
             *
             * The pin is the keyboard cursor, and walking to a block you
             * want to fix and then reaching for the mouse to open it is
             * the flip this whole surface exists to avoid. Escape closes
             * the editor again, which the field handles itself - the
             * guard above means this never fires while it has focus.
             */
            if (event.key === "Enter" && pinned !== undefined) {

                const mark = marks.find(one => one.line === pinned);

                if (mark) {

                    event.preventDefault();
                    openBlock(mark.line, mark.end);
                }

                return;
            }

            // Arrows only. The vi pair walked the pin too, and a
            // document is a thing people type into - a stray j or k with
            // the focus anywhere but a field moved the reader instead of
            // writing a letter.
            if (event.key === "ArrowDown") {

                event.preventDefault();
                stepPin(1);

            } else if (event.key === "ArrowUp") {

                event.preventDefault();
                stepPin(-1);
            }
        };

        window.addEventListener("keydown", onKey, true);

        return () => window.removeEventListener("keydown", onKey, true);

        // `fileLines` because `openBlock` and `saveNow` both read it:
        // without it the handler could splice or write a document that
        // has since been edited. It is derived from the draft, so it
        // also covers every keystroke typed into the editor.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [marks, pinned, fileLines, shownTab, artifact, dirty, blockEdit, closing,
        promptPath, promptDraft, promptDirty, promptClosing]);

    /**
     * A citation link as a control - or the ordinary link, when it is
     * only a link.
     *
     * The href decides everything. A noun is not matched against the phase names, as that would mean a citation could only ever point inside this spec and `**Wave 1**` would have to be defended against; a path points wherever it points, and a link
     * that is not a citation is not shaped like one.
     */
    const citation = (href: string | undefined, children: React.ReactNode): React.ReactElement => {

        const link = href === undefined ? undefined : parseRefLink(href, plainText(children));

        /*
         * Not a citation, so it stays an ordinary link.
         *
         * A relative one is still worth catching: the href means a file
         * in the repository, and left to itself the page would try to
         * navigate its own frame to a path that is not served - a link
         * that appears to do nothing, or worse, blanks the panel. An
         * absolute URL is left entirely alone, because the browser
         * already opens those.
         */
        if (!link || !artifact) {

            const inside = href !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//");

            return (
                <a
                    href={href}
                    onClick={inside && artifact
                        ? event => { event.preventDefault(); openFile(resolveRef(artifact, href!)); }
                        : undefined}>
                    {children}
                </a>
            );
        }

        return control(resolveRef(artifact, link.href), link);
    };

    /**
     * The same control, from the plain-text spelling - `_Requirements: 1.2_`, `**Validates: Requirements
     * 1.2**`.
     *
     * **Read, never written.** Specs drafted by other tools carry this
     * spelling. Pointing the panel at a folder somebody else made works
     * with no import step. A document whose citations silently render as
     * italic prose would break that.
     *
     * The noun does the work the href does above, resolved against this
     * spec's stages - which is why this form can only ever point inside
     * the spec, and why the link form exists at all.
     */
    const legacyCitation = (children: React.ReactNode, plain: React.ReactElement): React.ReactElement => {

        const label = parseRefLabel(plainText(children));

        if (!label)
            return plain;

        const stage = specStages.find(candidate =>
            candidate.artifact !== undefined && matchesTarget(candidate.name, label.target));

        // A noun naming no phase is left exactly as written. Plenty of
        // ordinary emphasis ends in a number - `**Wave 1**`, `**Task 2**`
        // - and dressing those as references is worse than not linking.
        if (!stage?.artifact)
            return plain;

        return control(
            stage.artifact,
            { href: "", name: label.target, refs: label.refs },
            label.head);
    };

    /**
     * A resolved citation as the control it is, whichever spelling it
     * arrived in.
     *
     * @param head The exact text before the ids, when the document wrote
     * one worth preserving. The panel is showing a file, so a phrase
     * rendered differently from the line it came from is a small lie the
     * reader meets the moment they press Edit.
     */
    const control = (path: string, link: SpecRefLinkData, head?: string): React.ReactElement => {

        const stage = specStages.find(candidate => samePath(candidate.artifact, path));

        // Read to know whether the numbers are there. A stage says so
        // itself; anything else is known only once it has been fetched,
        // and `cited` above asked for it.
        const text = documents[path];
        const missing = stage ? !stage.exists : text === "";
        const known = knownByArtifact[path];

        return (
            <SpecRefLink
                link={link}
                // A phase gets the word the style calls it by; anything
                // else has only its file name, which is what a reader
                // would call it anyway.
                target={stage ? stage.label ?? stage.name : path.split("/").pop() ?? link.href}
                head={head}
                missing={missing}
                unnumbered={!missing && known !== undefined && known.size === 0}
                known={missing ? undefined : known}
                previews={missing ? undefined : previewsByArtifact[path]}
                onFollow={() => followCitation(path, stage, link.refs)}
            />
        );
    };

    /**
     * The markdown renderers, made once.
     *
     * react-markdown takes these as component *types*, so an object
     * literal in the JSX below would hand React a new type on every
     * render - and a new type is a different component, which React
     * mounts from scratch. The document would be rebuilt whenever
     * anything re-rendered this view, a pointer crossing a paragraph
     * included, and everything the document was holding would go with it:
     * a diagram would fall back to "Drawing diagram" and be parsed and
     * drawn again, and an expanded diagram would close itself. A fence
     * that does not parse would show it plainest, because the error box
     * is several times the height of the pending line - so the block
     * would grow and collapse under the pointer, which would move the
     * pointer onto another block, which would render again.
     *
     * What changes between renders - the pin, the change marks, the
     * anchors - is read through a ref this render just filled rather
     * than closed over. Same output, one identity.
     */
    /**
     * What a plan row's controls need, read through the same ref for
     * the same reason: the `li` renderer must keep one identity while
     * chats start and boxes tick underneath it.
     */
    const planRow = (node: { position?: { start: { line: number } } } | undefined): React.ReactNode => {

        if (!inlinePlan || !node?.position)
            return undefined;

        const fileLine = node.position.start.line + offset;

        const found = inlineRowAt.get(fileLine);

        if (!found)
            return undefined;

        const { row, group } = found;

        // Started and watched by id, from the plan on disk. A group is a
        // container, not work - its ▶ hands over the work under it.
        const unit = group ? undefined : unitById.get(row.id);

        const done = row.done;

        // A group's ▶: the open agent tasks under it, read from the plan
        // on disk by id so what is started is what the host knows, and
        // skipping any a chat already holds - the row ▶ is grey for
        // those, and this is the same press over several rows.
        if (group) {

            const under = pendingUnder(row)
                .map(leaf => unitById.get(leaf.id))
                .filter((leaf): leaf is SpecTask => leaf !== undefined && !isTaskDone(leaf));

            const fresh = under.filter(leaf => !isWorking(leaf.id) && !queuedTasks.includes(leaf.id));

            const groupDone = isTaskDone(row);

            const early = fresh.length ? outOfOrder(fresh.map(leaf => leaf.id)) : undefined;

            return (
                <span className="sdd-inline" contentEditable={false}>

                    <Checkbox
                        className="sdd-inline__box"
                        checked={done}
                        disabled={blockEdit !== undefined}
                        title={done ? "Ticked in tasks.md - click to untick" : "Click to tick this box in tasks.md"}
                        onChange={() => toggleTask(fileLine)}
                    />

                    <Button
                        fill="ghost"
                        size="icon"
                        className={`sdd-inline__play${groupDone ? " sdd-inline__play--done text-success" : ""}${!groupDone && under.length > 0 && fresh.length === 0 ? " sdd-inline__play--working text-info" : ""}`}
                        disabled={groupDone || fresh.length === 0 || blockedWork !== undefined || early !== undefined}
                        title={groupDone
                            ? "Done - everything under it is ticked"
                            : under.length === 0
                            ? "Nothing open under this group - only its own box is left to tick"
                            : fresh.length === 0
                            ? "Every open task under this group is already in a chat or waiting its turn"
                            : blockedWork
                            ?? early
                            ?? `Start every open task under this group (${fresh.length}) - ${NEXT_TITLE}`}
                        onClick={() => {

                            startTasks(fresh.map(handed));
                            setLaunched(fresh[0]?.id);
                        }}>
                        <UiIcon name={groupDone ? "check" : under.length > 0 && fresh.length === 0 ? "more" : "run"} />
                    </Button>
                </span>
            );
        }

        // Why this row may not start yet - the plan's order.
        const early = unit && !done ? outOfOrder([unit.id]) : undefined;

        // A row with a `Run:` line is not an agent's: the box, and the
        // one control its line asks for.
        if (unit?.run)
            return (
                <span className="sdd-inline" contentEditable={false}>

                    <Checkbox
                        className="sdd-inline__box"
                        checked={done}
                        disabled={blockEdit !== undefined}
                        title={done ? "Ticked in tasks.md - click to untick" : "Click to tick this box in tasks.md"}
                        onChange={() => toggleTask(fileLine)}
                    />

                    {unit.run.kind === "manual" && (
                        <span className="sdd-inline__play sdd-inline__play--hand" title="Done by hand - tick the box when it is"><UiIcon name="by-hand" /></span>
                    )}

                    {unit.run.kind === "command" && stopCommand && runningCommands?.includes(unit.run.command) && (
                        <Button
                            fill="ghost"
                            size="icon"
                            className="sdd-inline__play sdd-inline__play--terminal"
                            title={`Stop: ${unit.run.command}`}
                            onClick={() => stopCommand((unit.run as { command: string }).command)}>
                            <UiIcon name="stop" />
                        </Button>
                    )}

                    {unit.run.kind === "command" && !(stopCommand && runningCommands?.includes(unit.run.command)) && (
                        <Button
                            fill="ghost"
                            size="icon"
                            className="sdd-inline__play sdd-inline__play--terminal"
                            disabled={done || early !== undefined}
                            title={done ? "Done - the checkbox is ticked" : early ?? `Run: ${unit.run.command}`}
                            onClick={() => runCommand((unit.run as { command: string }).command)}>
                            <UiIcon name={done ? "check" : "terminal"} />
                        </Button>
                    )}

                    {unit.run.kind === "workflow" && (() => {

                        const run = unit.run;

                        const known = workflows.includes(run.name);

                        return (
                            <Button
                                fill="ghost"
                                size="icon"
                                className={`sdd-inline__play${known ? "" : " sdd-inline__play--unknown text-error"}`}
                                disabled={done || !known || early !== undefined}
                                title={done
                                    ? "Done - the checkbox is ticked"
                                    : known
                                    ? early ?? `Run the workflow '${run.name}' - tick the box when it is green`
                                    : `No workflow named '${run.name}' under .eesha/workflows`}
                                onClick={() => runWorkflow(run.name, {
                                    task: unit.id,
                                    taskTitle: unit.text,
                                    ...(unit.group !== undefined ? { group: unit.group } : {}),
                                    files: unit.files,
                                    repos: reposOf(unit.files),
                                    ...run.args
                                })}>
                                <UiIcon name={done ? "check" : known ? "run" : "help"} />
                            </Button>
                        );
                    })()}
                </span>
            );

        const working = unit !== undefined && isWorking(unit.id) && !isTaskDone(unit);

        const queued = unit !== undefined && queuedTasks.includes(unit.id) && !done;

        const chat = unit ? chatFor(unit.id) : undefined;

        return (
            <span className="sdd-inline" contentEditable={false}>

                <Checkbox
                    className="sdd-inline__box"
                    checked={done}
                    disabled={blockEdit !== undefined}
                    title={done ? "Ticked in tasks.md - click to untick" : "Click to tick this box in tasks.md"}
                    onChange={() => toggleTask(fileLine)}
                />

                {unit && (
                    <Button
                        fill="ghost"
                        size="icon"
                        className={`sdd-inline__play${done ? " sdd-inline__play--done text-success" : ""}${working || queued ? " sdd-inline__play--working text-info" : ""}`}
                        disabled={done || working || queued || blockedWork !== undefined || early !== undefined}
                        title={done
                            ? "Done - the checkbox is ticked"
                            : working
                            ? "An agent is working this task - it completes when the checkbox ticks"
                            : queued
                            ? "Waiting - queued behind the wave being worked; this starts when every task before it is ticked"
                            : blockedWork
                            ?? early
                            ?? "Start an agent chat for exactly this task - ticking its checkbox is its definition of done"}
                        onClick={() => startUnit(unit)}>
                        <UiIcon name={done ? "check" : working ? "more" : queued ? "hourglass" : "run"} />
                    </Button>
                )}

                {chat && !working && (
                    <button
                        className="sdd-inline__chat"
                        title={`Reopen the chat that worked task ${unit!.id}`}
                        onClick={() => openChat(chat)}>
                        chat
                    </button>
                )}
            </span>
        );
    };

    return {
        anchorScope, blockProps, blockOf, openBlock, withBlock, commitBlock, saveNow, elementAt,
        savePrompt, discardPrompt, promptOutline, promptScroll, promptSection, promptChain,
        promptOutlineBodyRef, promptHeadings, goToPromptLine, discardDraft, stepPin, goToLine,
        addNote, noteContents, commitNote, setResolved, removeNote, citation, legacyCitation,
        control, planRow
    } as const;
}

/** What useDocEditing gives the parts after it. */
export type DocEditing = ReturnType<typeof useDocEditing>;
