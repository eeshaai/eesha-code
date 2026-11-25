import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentFile } from "../view/chat/pendingChanges";
import { AskedNote, ChangeLetter, ChangeTag, DiffCounts, EditorAction, EditorDiff, EditorFile, EditorGap, EditorIconButton, EditorPath, EditorTabs, EditorView, type FileSelection, SegmentSwitch } from "../view/ui";
import { diffLineCounts, useDiffCounts, useEditorDiffText } from "../view/diff/editorDiff";
import { changedLineMarks } from "../view/diff/lineDiff";
import MarkdownPreview from "../view/MarkdownPreview";
import { isMarkdownPath, isSpecPath } from "../view/text/specWords";
import { API, GitDiff, GitDiffAsk } from "../server/protocol";
import { bridge } from "./bridge";
import type { EditorTab, TabsState, TabWhat, TurnDiff } from "./editorTabs";
// Part of page.js, not loaded later: a part loaded later brings its styles
// in a file of its own, which the page does not load.
import SddEditor from "./SddEditor";
import { type GitMark, pathKey, pathParts } from "./fileMarks";

/*
 * The editor tabs the Files, Git and Changed files views share. The
 * library's Tabs draws the row: a close button on every tab, the preview tab in italics, a double-click keeps it. Only the tab
 * that shows is drawn, and read again each time it shows.
 *
 * A file tab has a path line with what changed it, a switch
 * between the file, its git change and what the agent changed, Find, Copy
 * path and Add to context. A Markdown file also has Preview: the file
 * rendered, with the spec words coloured when it sits in a `spec` or
 * `specs` folder (a switch turns that off). The file is coloured, its changed lines marked,
 * and picked lines can go to the message box. A diff tab shows its letter,
 * path, line counts and an Inline / Side by side switch; a turn's diff
 * also what was asked and a switch between the turn alone and the turn
 * against now.
 *
 * The library draws all of it (EditorTabs, EditorView, SegmentSwitch).
 * This file reads the files and the git diffs from the server, picks what
 * each tab shows, and passes it in.
 */

export type DiffLayout = "inline" | "split";

/** What the tabs need from the page around them. */
export interface EditorHelp {

    /** The chat's folders - a file's path line starts at the one it is in. */
    folders: readonly string[];

    /** Git's letter for each changed file, by `pathKey` of its full path. */
    marks: ReadonlyMap<string, GitMark>;

    /** The files this chat's turns changed. */
    agentFiles: readonly AgentFile[];

    /** What was asked for each turn, by `<root>|<after snapshot>`. */
    turnMessages: Readonly<Record<string, string>>;

    layout: DiffLayout;

    onLayout(layout: DiffLayout): void;

    /** "AI changes" in a file tab: the file before the agent's turns and now, by `pathKey`, once asked. */
    agentDiffs: Readonly<Record<string, TurnDiff>>;

    askAgentDiff(file: AgentFile): void;

    onAddFile(path: string): void;

    onAddLines(path: string, picked: FileSelection): void;

    /** A turn's diff: the other comparison, in place of this tab. */
    onCompare(tab: EditorTab, diff: TurnDiff): void;

    onGoToSession(): void;

    /** A question waits for you in the chat beside this spec, and that chat is the spec's. */
    chatWaits(what: { spec: string; folder?: string }): boolean;

    /** Where the chat draws its log lines - the Logs tab's body, while that tab shows. */
    setLogsBody(element: HTMLElement | null): void;

    /** The phase a spec tab shows when it comes to the front. Nothing: the spec's own first phase. */
    specPhase(what: Extract<TabWhat, { kind: "spec" }>): string | undefined;
}

async function readFile(file: string): Promise<string> {

    const answer = await bridge.request<{ text?: string }>(API.file, { view: bridge.view, path: file });

    if (answer.text === undefined)
        throw new Error(answer.problem ?? "Could not read the file.");

    return answer.text;
}

const copy = (text: string) => void navigator.clipboard?.writeText(text);

/** A git diff, read when it shows and again whenever its repository changes. A commit's diff never changes. Nothing: no ask. */
function useGitDiff(root: string | undefined, ask: GitDiffAsk | undefined): { diff?: GitDiff; problem?: string } {

    const [diff, setDiff] = useState<GitDiff | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    const read = useCallback(async () => {

        if (!root || !ask)
            return;

        try {

            const answer = await bridge.request<Partial<GitDiff>>(API.gitDiff, { view: bridge.view, root, ask });

            if (answer.problem) {

                setProblem(answer.problem);
                setDiff(undefined);

            } else {

                setProblem(undefined);
                setDiff(answer as GitDiff);
            }

        } catch {

            setProblem("Could not reach the server.");
        }

        // The ask is the same while its parts are the same.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, ask?.side, ask?.path, ask?.from, ask?.commit]);

    useEffect(() => {

        setDiff(undefined);
        setProblem(undefined);
        void read();

    }, [read]);

    useEffect(() => bridge.onPage(message => {

        if (!ask || ask.side === "commit")
            return;

        // The server says which repository changed. It is only told while
        // the git panel or the file tree watches.
        if (message.type === "eesha.gitChanged" && message.root === root)
            void read();

        if (message.type === "eesha.hello")
            void read();

    }), [ask, root, read]);

    return { diff, problem };
}

function LayoutSwitch({ help }: { help: EditorHelp }) {

    return (
        <SegmentSwitch
            label="Diff layout"
            value={help.layout}
            options={[{ value: "inline", text: "Inline" }, { value: "split", text: "Side by side" }]}
            onChange={help.onLayout} />
    );
}

/** The path, cut into its folders: eesha-code › src › web › App.tsx. */
function PathLine({ path, folders }: { path: string; folders: readonly string[] }) {

    return <EditorPath parts={pathParts(path, folders)} title={path} />;
}

/** What each side of a git diff is. */
function gitLabels(ask: GitDiffAsk): [string, string] {

    switch (ask.side) {

        case "changes":
            return ["Staged (or the last commit)", "On disk"];

        case "staged":
            return ["Last commit", "Staged"];

        case "commit":
            return ["Before the commit", "The commit"];

        default:
            return ["Before", "After"];
    }
}

/** What git says about a file, in a few words. */
function markText(mark: GitMark): string {

    switch (mark.letter) {

        case "!": return "Conflict in git";
        case "U": return "New file, not in git yet";
        case "A": return "Added in git";
        case "D": return "Deleted in git";
        case "R": return "Renamed in git";
        default: return "Changed in git";
    }
}

type FileMode = "file" | "preview" | "git" | "agent";

/**
 * A Markdown file, rendered. Read when it shows, and again on Reload -
 * the same way the File view reads it.
 */
function PreviewBody({ path, specMode, reload }: { path: string; specMode: boolean; reload: number }) {

    const [text, setText] = useState<string | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    useEffect(() => {

        let live = true;

        readFile(path).then(
            read => { if (live) { setText(read); setProblem(undefined); } },
            (error: Error) => { if (live) setProblem(error.message); });

        return () => { live = false; };

    }, [path, reload]);

    if (problem)
        return <p className="eesha-md-preview-problem" role="alert">{problem}</p>;

    if (text === undefined)
        return <p className="eesha-md-preview-problem">Reading the file…</p>;

    return (
        <div className="eesha-md-preview-scroll">
            <MarkdownPreview text={text} specMode={specMode} />
        </div>
    );
}

/** A file tab: the path line, the switch, and the file - or its git change, or what the agent changed. */
function FileTab({ path, help }: { path: string; help: EditorHelp }) {

    const key = pathKey(path);
    const mark = help.marks.get(key);
    const agent = help.agentFiles.find(one => pathKey(one.path) === key);

    const [mode, setMode] = useState<FileMode>("file");
    const [findRequest, setFindRequest] = useState(0);

    // Preview: a Markdown file only. Spec mode starts on for a file in a
    // `spec` or `specs` folder, and the switch can turn it off.
    const markdown = isMarkdownPath(path);
    const specFolder = isSpecPath(path);
    const [specMode, setSpecMode] = useState(specFolder);
    const [reload, setReload] = useState(0);

    // Git's change for this file: its changed lines, and the Git changes view.
    const ask = useMemo<GitDiffAsk | undefined>(
        () => mark && mark.side !== "conflict" ? { side: mark.side, path: mark.path } : undefined,
        [mark?.side, mark?.path]); // eslint-disable-line react-hooks/exhaustive-deps

    const git = useGitDiff(mark?.root, ask);

    const lineMarks = useMemo(() => {

        const diff = git.diff;

        return diff && !diff.binary && !diff.tooLarge ? changedLineMarks(diff.before ?? "", diff.after) : undefined;

    }, [git.diff]);

    // AI changes: asked of the chat each time the view is picked, so it is never old.
    const askAgent = useRef(help.askAgentDiff);
    askAgent.current = help.askAgentDiff;

    useEffect(() => {

        if (mode === "agent" && agent)
            askAgent.current(agent);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, agent?.path, agent?.before]);

    // A switch to a view the file no longer has goes back to the file.
    useEffect(() => {

        if ((mode === "git" && !mark) || (mode === "agent" && !agent) || (mode === "preview" && !markdown))
            setMode("file");

    }, [mode, mark, agent, markdown]);

    const agentDiff = help.agentDiffs[key];
    const gitDiffText = useEditorDiffText(git.diff);
    const agentDiffText = useEditorDiffText(agentDiff);
    const turnKey = agent ? `${agent.root}|${agent.after}` : undefined;

    return (
        <EditorView
            head={(
                <>
                    <PathLine path={path} folders={help.folders} />
                    {mark ? <ChangeTag tone={mark.letter}>{markText(mark)}</ChangeTag> : null}
                    {agent
                        ? (
                            <ChangeTag tone="agent" icon="sparkle" title={turnKey && help.turnMessages[turnKey] ? `First changed when you asked: ${help.turnMessages[turnKey]}` : undefined}>
                                Changed by the agent
                            </ChangeTag>
                        )
                        : null}
                    <EditorGap />
                    <SegmentSwitch<FileMode>
                        label="Show"
                        value={mode}
                        options={[
                            { value: "file", text: "File" },
                            ...(markdown ? [{ value: "preview" as const, text: "Preview", title: "The Markdown rendered" }] : []),
                            { value: "git", text: "Git changes", disabled: !mark || mark.side === "conflict", title: mark ? "What git sees changed in this file" : "Git has no change for this file" },
                            { value: "agent", text: "AI changes", disabled: !agent, title: agent ? "The file before the agent's first change in this chat, and now" : "The agent did not change this file in this chat" }
                        ]}
                        onChange={setMode} />
                    {mode === "file"
                        ? <EditorIconButton icon="search" label="Find in file (Ctrl+F)" onClick={() => setFindRequest(value => value + 1)} />
                        : mode === "preview"
                            ? (
                                <>
                                    {specFolder
                                        ? (
                                            <SegmentSwitch<"on" | "off">
                                                label="Spec colours"
                                                value={specMode ? "on" : "off"}
                                                options={[
                                                    { value: "on", text: "Spec colours", title: "Colour the EARS words (WHEN, IF, SHALL...) and MUST, as the SDD Doc tab does" },
                                                    { value: "off", text: "Plain" }
                                                ]}
                                                onChange={value => setSpecMode(value === "on")} />
                                        )
                                        : null}
                                    <EditorIconButton icon="refresh" label="Read the file again" onClick={() => setReload(value => value + 1)} />
                                </>
                            )
                            : <LayoutSwitch help={help} />}
                    <EditorIconButton icon="copy" label="Copy path" onClick={() => copy(path)} />
                    <EditorAction icon="add-circle" title="Add this file to the message's context" onClick={() => help.onAddFile(path)}>
                        Add file to context
                    </EditorAction>
                </>
            )}>

            {mode === "file"
                ? (
                    <EditorFile
                        path={path}
                        fetchContent={readFile}
                        colors
                        lineMarks={lineMarks}
                        find
                        findRequest={findRequest}
                        status
                        onAddSelection={picked => help.onAddLines(path, picked)}
                        addSelectionLabel={(start, end) => start === end ? `Add line ${start} to context` : `Add lines ${start}–${end} to context`} />
                )
                : null}

            {mode === "preview"
                ? <PreviewBody path={path} specMode={specMode} reload={reload} />
                : null}

            {mode === "git" && ask
                ? (
                    <EditorDiff
                        diff={gitDiffText}
                        problem={git.problem}
                        path={path}
                        layout={help.layout}
                        beforeLabel={gitLabels(ask)[0]}
                        afterLabel={gitLabels(ask)[1]}
                        newText="A new file - git does not have it yet."
                        noChangeText="No change in the text." />
                )
                : null}

            {mode === "agent"
                ? (
                    <EditorDiff
                        diff={agentDiffText}
                        path={path}
                        layout={help.layout}
                        beforeLabel="Before the agent's turns"
                        afterLabel="Now"
                        newText="A new file - the agent made it."
                        noChangeText="No change - the file is as it was before the agent's turns." />
                )
                : null}
        </EditorView>
    );
}

/** A git diff tab: letter, path, counts, layout. */
function GitTab({ root, ask, help }: { root: string; ask: GitDiffAsk; help: EditorHelp }) {

    const { diff, problem } = useGitDiff(root, ask);
    const mark = ask.side === "commit" ? undefined : help.marks.get(pathKey(`${root}/${ask.path}`));
    const [beforeLabel, afterLabel] = gitLabels(ask);
    const diffText = useEditorDiffText(diff);
    const counts = useDiffCounts(diff);

    return (
        <EditorView
            head={(
                <>
                    <ChangeLetter letter={mark?.letter} />
                    <PathLine path={`${root}/${ask.path}`} folders={help.folders} />
                    {counts ? <DiffCounts added={counts.added} removed={counts.removed} /> : null}
                    <EditorGap />
                    <LayoutSwitch help={help} />
                </>
            )}>
            <EditorDiff
                diff={diffText}
                problem={problem}
                path={ask.path}
                layout={help.layout}
                beforeLabel={beforeLabel}
                afterLabel={afterLabel}
                newText="A new file."
                noChangeText="No change in the text." />
        </EditorView>
    );
}

/** What one turn did to a file, or the file before the turn against now - with what was asked. */
function TurnTab({ tab, diff, help }: { tab: EditorTab; diff: TurnDiff; help: EditorHelp }) {

    const asked = diff.from ? help.turnMessages[`${diff.from.root}|${diff.from.after}`] : undefined;
    const letter = diff.before === undefined ? "A" : diff.after === "" ? "D" : "M";
    const diffText = useEditorDiffText(diff);
    const counts = useMemo(() => diff.binary ? undefined : diffLineCounts(diff.before, diff.after), [diff]);

    return (
        <EditorView
            head={(
                <>
                    <ChangeLetter letter={letter} />
                    <PathLine path={diff.path} folders={[]} />
                    {counts ? <DiffCounts added={counts.added} removed={counts.removed} /> : null}
                    <EditorGap />
                    {diff.from
                        ? (
                            <SegmentSwitch<"turn" | "now">
                                label="Compare"
                                value={diff.turn ? "turn" : "now"}
                                options={[
                                    { value: "turn", text: "What this turn did", title: "The file before this turn and right after it" },
                                    { value: "now", text: "Before the turn vs now", title: "The file before this turn and as it is now" }
                                ]}
                                onChange={value => { if ((value === "turn") !== Boolean(diff.turn)) help.onCompare(tab, diff); }} />
                        )
                        : null}
                    <LayoutSwitch help={help} />
                </>
            )}>
            {asked ? <AskedNote text={asked} actionText="Go to the session" onAction={help.onGoToSession} /> : null}
            <EditorDiff
                diff={diffText}
                path={diff.path}
                layout={help.layout}
                beforeLabel="Before the turn"
                afterLabel={diff.turn ? "After the turn" : "Now"}
                newText={diff.turn ? "A new file - the turn added all of it." : "A new file - the agent made it."}
                noChangeText={diff.turn ? "No change - the turn left the file as it was." : "No change - the file is as it was before the turn."} />
        </EditorView>
    );
}

function TabBody({ tab, help }: { tab: EditorTab; help: EditorHelp }) {

    const what = tab.what;

    if (what.kind === "file")
        return <FileTab path={what.path} help={help} />;

    if (what.kind === "git")
        return <GitTab root={what.root} ask={what.ask} help={help} />;

    // The chat draws its log here, with the log's own filters on top.
    if (what.kind === "logs")
        return <div className="eesha-logs" ref={help.setLogsBody} />;

    // A spec: its phases, documents and Next. Drawn again each time it comes to the front.
    if (what.kind === "spec")
        return <SddEditor spec={{ workspace: what.workspace, spec: what.spec, ...(what.folder ? { folder: what.folder } : {}) }} phase={help.specPhase(what)} chatWaits={help.chatWaits(what)} onGoToChat={help.onGoToSession} />;

    return <TurnTab tab={tab} diff={what.diff} help={help} />;
}

export default function EditorArea({ state, emptyText, help, onShow, onClose, onKeep, onHide, beside, maximized, onMaximize }: {
    state: TabsState;

    /** Said when no tab is open - what the list on the left opens. */
    emptyText: string;

    help: EditorHelp;

    onShow(id: string): void;
    onClose(id: string): void;
    onKeep(id: string): void;

    /** Hides the editor. Its tabs stay open, and come back with it. */
    onHide(): void;

    /** What is beside the editor - "chat" - for the maximize button's hover text. */
    beside: string;

    /** The editor takes the whole row: what is beside it is hidden. */
    maximized: boolean;

    /** Maximizes the editor, or gives the room back. */
    onMaximize(): void;
}) {

    return (
        <EditorTabs
            tabs={state.tabs}
            active={state.active}
            emptyText={emptyText}
            renderTab={tab => <TabBody tab={tab} help={help} />}
            onShow={onShow}
            onClose={onClose}
            onKeep={onKeep}
            onHide={onHide}
            onMaximize={onMaximize}
            maximized={maximized}
            maximizeTitle={`Maximize the editor - the ${beside} and the panels hide until you restore it`}
            restoreTitle={`Restore the editor - the ${beside} and the panels show beside it again`} />
    );
}
