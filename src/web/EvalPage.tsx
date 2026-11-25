import React, { useCallback, useEffect, useState } from "react";

import { AppHeader, AppShell, Button, HeaderButton } from "../view/ui";
import { type AiOptions, API, EVAL_NAME, EVAL_VARIANTS_MAX, type EvalRow, type EvalTask, type EvalVariantView, type EvalView } from "../server/protocol";
import { bridge } from "./bridge";
import EvalHelp from "./EvalHelp";
import EvalReport from "./EvalReport";
import EvalVariantFields, { askOf, draftOf, newDraft, setupLine, type VariantDraft } from "./EvalVariantFields";
import { columnAddress, evalAddress, type EvalShown, evalShownOfAddress, settingsAddress } from "./pageRoute";
import { PAGE_MIN, PAGE_WIDTH } from "./sideState";
import { applyFontSize, applyTheme } from "./theme";

/*
 * The Evaluator. It sends one message to a few variants - a runtime, a
 * model and a little setup each - and shows their chats side by side,
 * so the person can compare them. It never says which variant did better.
 *
 *   /eval                       a form to make an evaluation, and the list of them
 *   /eval/<name>                one evaluation, live: a message box for all its
 *                               variants, then one column per variant
 *   /eval/<name>?variant=<v>    the same, with one variant's column as wide as the page
 *   /eval/<name>?view=report    its report - see EvalReport.tsx
 *
 * Each variant works in its own copy of the folder, and nobody is asked:
 * a tool call inside the copy runs, one outside it is refused. A column
 * is a frame showing that variant's own chat (EvalColumn.tsx), so the
 * thread and the message box are the ones every session has.
 *
 * Nothing of an evaluation shows in the session list, the search or the
 * start page.
 */

const NAME_RULE = "Letters, digits, - and _ only, up to 60.";

/** The page's top bar - the same name and Settings link as every page. */
function header(): React.JSX.Element {

    return (
        <AppHeader
            name="Eesha Code"
            href="/"
            hrefTitle="Open the start page"
            logo={<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M7 8l4 4-4 4 M13 16h5" /></svg>}
            end={
                <>
                    <HeaderButton label="Evaluator" href={evalAddress()} current icon="diff" />
                    <HeaderButton label="Settings" href={settingsAddress()} icon="settings" />
                </>
            } />
    );
}

/** The server's line: the theme and text size, and a call when something of an evaluation changed. */
function useServer(onChange: (name?: string) => void): void {

    useEffect(() => {

        const off = bridge.onPage(message => {

            switch (message.type) {

                case "eesha.hello":

                    applyTheme(message.theme);
                    applyFontSize(message.fontSize);

                    return onChange();

                case "eesha.theme":
                    return applyTheme(message.theme);

                case "eesha.fontSize":
                    return applyFontSize(message.fontSize);

                case "eesha.evalChanged":
                    return onChange(message.name);

                // A variant's turn started or ended in one of the frames.
                case "eesha.listChanged":
                    return onChange();
            }
        });

        bridge.connect();

        return off;

    }, [onChange]);
}

/** The runtimes on offer with their models and modes. Nothing until the server has answered. */
function useAiOptions(): AiOptions | undefined {

    const [options, setOptions] = useState<AiOptions | undefined>();

    useEffect(() => {

        void bridge.request<AiOptions>(API.aiOptions, {}).then(answer => {

            if (!answer.problem && Array.isArray(answer.runtimes))
                setOptions(answer);
        });

    }, []);

    return options;
}

export default function EvalPage({ name }: { name?: string }): React.JSX.Element {

    return (
        <AppShell header={header()} minWidth={PAGE_MIN} scrollBelow={PAGE_WIDTH} narrowText={`Eesha Code needs a window at least ${PAGE_MIN} pixels wide. Make the window wider.`}>
            <div className="eesha-work">
                {name === undefined ? <EvalList /> : <EvalOne name={name} />}
            </div>
        </AppShell>
    );
}

/** `/eval`: the form to make an evaluation, and the ones already made. */
function EvalList(): React.JSX.Element {

    const [rows, setRows] = useState<EvalRow[]>([]);
    const [problem, setProblem] = useState<string | undefined>();

    /** Folders used before and git repositories found - offered as the folder field is typed in. */
    const [folders, setFolders] = useState<string[]>([]);

    const [name, setName] = useState("");
    const [folder, setFolder] = useState("");
    const [variants, setVariants] = useState<VariantDraft[]>([]);
    const [making, setMaking] = useState(false);
    const [formProblem, setFormProblem] = useState<string | undefined>();

    const options = useAiOptions();

    const read = useCallback(() => {

        void bridge.request<{ evals?: EvalRow[] }>(API.evalList, {}).then(answer => {

            setProblem(answer.problem);
            setRows(answer.evals ?? []);
        });

    }, []);

    useServer(read);

    const first = options?.defaultRuntime ?? options?.runtimes[0] ?? "";

    // Two to start with: one variant alone compares nothing.
    useEffect(() => {

        if (options)
            setVariants(current => current.length ? current : [newDraft(first), newDraft(first)]);

    }, [options, first]);

    useEffect(() => {

        void bridge.request<{ recent?: string[]; repos?: string[] }>(API.folders, {}).then(answer =>
            setFolders([...(answer.recent ?? []), ...(answer.repos ?? [])]));

    }, []);

    const change = (index: number, part: Partial<VariantDraft>) =>
        setVariants(current => current.map((one, at) => at === index ? { ...one, ...part } : one));

    const nameBad = name !== "" && !EVAL_NAME.test(name);

    const create = async () => {

        setFormProblem(undefined);
        setMaking(true);

        const answer = await bridge.request<{ eval?: EvalView }>(API.evalCreate, { name, folder: folder.trim(), variants: variants.map(askOf) });

        if (answer.problem || !answer.eval) {

            setMaking(false);

            return setFormProblem(answer.problem ?? "The server did not make the evaluation.");
        }

        location.assign(evalAddress(answer.eval.name));
    };

    if (problem)
        return <div className="evals evals--list"><div className="evals__form"><h1>Evaluator</h1><p className="evals__problem" role="alert">{problem}</p></div></div>;

    return (
        <div className="evals evals--list">
            <div className="evals__form">

                <div className="evals__row">
                    <h1>New evaluation</h1>
                    <EvalHelp page="list" />
                </div>

                <div className="evals__pair">
                    <label className="evals__field">
                        Name
                        <input className="evals__input" value={name} onChange={event => setName(event.target.value)} aria-invalid={nameBad} placeholder="login-refactor" />
                        {nameBad ? <span className="evals__problem">{NAME_RULE}</span> : null}
                    </label>
                    <label className="evals__field">
                        Folder
                        <input className="evals__input" value={folder} onChange={event => setFolder(event.target.value)} list="evals-folders" placeholder="The full path of the folder to work on" />
                        <datalist id="evals-folders">{folders.map(one => <option key={one} value={one} />)}</datalist>
                    </label>
                </div>

                <h2>Variants</h2>

                {/* The runtime list asks each runtime's program, which takes a few seconds the first time. */}
                {!options ? <p className="evals__note">Reading the runtimes on this machine…</p> : null}

                {variants.map((one, index) => (
                    <div className="evals__variant" key={index}>
                        <EvalVariantFields draft={one} options={options} namePlaceholder={`${name || "name"}-${index + 1}`} onChange={part => change(index, part)} />
                        <Button size="sm" variant="secondary" disabled={variants.length <= 1} onClick={() => setVariants(current => current.filter((_one, at) => at !== index))}>Remove</Button>
                    </div>
                ))}

                <div className="evals__row">
                    <Button variant="secondary" disabled={variants.length >= EVAL_VARIANTS_MAX || !options} onClick={() => setVariants(current => [...current, newDraft(first)])}>
                        Add variant
                    </Button>
                </div>

                {formProblem ? <p className="evals__problem" role="alert">{formProblem}</p> : null}

                <div className="evals__row">
                    <Button variant="primary" disabled={making || !name || nameBad || !folder.trim() || !variants.length} onClick={() => void create()}>
                        {making ? "Making the copies…" : "Create evaluation"}
                    </Button>
                </div>

                {rows.length
                    ? (
                        <>
                            <h2>Evaluations</h2>
                            <ul className="evals__list">
                                {rows.map(row => (
                                    <li key={row.name}>
                                        <a href={evalAddress(row.name)}>
                                            <span>{row.name}</span>
                                            <span className="evals__list-facts">{row.variants} {row.variants === 1 ? "variant" : "variants"} · {new Date(row.createdAt).toLocaleDateString()} · {row.folder}</span>
                                        </a>
                                        <a className="evals__list-report" href={evalAddress(row.name, { report: true })}>Report</a>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )
                    : null}
            </div>
        </div>
    );
}

/**
 * The form under the bar: a new variant, or a copy of one. Once there, a
 * variant's runtime, model, mode and effort are picked at the foot of its
 * own column, and its own text is typed there.
 */
interface VariantForm {

    kind: "add" | "copy";

    draft: VariantDraft;

    /** `copy`: the variant copied. */
    of?: string;
}

/** `/eval/<name>`: the message box for all variants and one column per variant, or the report. */
function EvalOne({ name }: { name: string }): React.JSX.Element {

    const [shown, setShown] = useState<EvalView | undefined>();
    const [loaded, setLoaded] = useState(false);
    const [problem, setProblem] = useState<string | undefined>();
    const [text, setText] = useState("");
    const [sendProblem, setSendProblem] = useState<string | undefined>();

    /** A send is on its way: the button is off until the variants say they work. */
    const [sending, setSending] = useState(false);

    /** What the address asks to show: the columns, one column, or the report. */
    const [view, setView] = useState<EvalShown>(() => evalShownOfAddress(location.search));

    const [form, setForm] = useState<VariantForm | undefined>();
    const [formProblem, setFormProblem] = useState<string | undefined>();
    const [formBusy, setFormBusy] = useState(false);

    const [deleting, setDeleting] = useState<"asked" | "running" | undefined>();
    const [deleteProblem, setDeleteProblem] = useState<string | undefined>();

    /** Remove one variant: asked, or on its way. */
    const [removing, setRemoving] = useState<{ variant: string; running: boolean; problem?: string } | undefined>();

    /** The saved tasks, where own ones go, and the own files that could not be read. */
    const [tasks, setTasks] = useState<{ tasks: EvalTask[]; folder: string; problems: string[] }>({ tasks: [], folder: "", problems: [] });

    /** The saved task the message box was filled from. Empty: none - the message is sent as typed. */
    const [taskName, setTaskName] = useState("");

    const options = useAiOptions();

    const readTasks = useCallback(() => {

        void bridge.request<{ tasks?: EvalTask[]; folder?: string; problems?: string[] }>(API.evalTasks, {}).then(answer => {

            if (!answer.problem)
                setTasks({ tasks: answer.tasks ?? [], folder: answer.folder ?? "", problems: answer.problems ?? [] });
        });

    }, []);

    useEffect(readTasks, [readTasks]);

    const task = tasks.tasks.find(one => one.name === taskName);

    const pickTask = (next: string) => {

        setTaskName(next);

        const picked = tasks.tasks.find(one => one.name === next);

        // The task's text goes into the box, to be read and changed before it is sent.
        if (picked)
            setText(picked.text);
    };

    const read = useCallback((changed?: string) => {

        if (changed !== undefined && changed !== name)
            return;

        void bridge.request<{ eval?: EvalView }>(API.evalGet, { name }).then(answer => {

            setProblem(answer.problem);
            setShown(answer.eval);
            setLoaded(true);
        });

    }, [name]);

    useServer(read);

    useEffect(() => { document.title = `${name} - Evaluator`; }, [name]);

    // Back and Forward move between the columns, one column and the report.
    useEffect(() => {

        const onPop = () => setView(evalShownOfAddress(location.search));

        window.addEventListener("popstate", onPop);

        return () => window.removeEventListener("popstate", onPop);

    }, []);

    const show = (next: EvalShown) => {

        history.pushState(null, "", evalAddress(name, next));

        setView(next);
    };

    const working = shown?.variants.filter(one => one.working).length ?? 0;

    // A variant's "working" comes a moment after the send: until then the button stays off.
    useEffect(() => {

        if (working > 0)
            setSending(false);

    }, [working]);

    /** `onlyNew`: only to the variants that never got a message. */
    const send = async (onlyNew = false) => {

        setSendProblem(undefined);
        setSending(true);

        const answer = await bridge.request(API.evalSend, { name, text, ...(task ? { task: task.name } : {}), ...(onlyNew ? { onlyNew: true } : {}) });

        if (answer.problem) {

            setSending(false);

            return setSendProblem(answer.problem);
        }

        // The box keeps the message: the evaluation now holds it, and shows it locked.
        read();

        // The variants answer with "working" on their own; this is for one that never starts.
        setTimeout(() => { setSending(false); read(); }, 5000);
    };

    const openForm = (next: VariantForm) => {

        setFormProblem(undefined);
        setDeleting(undefined);
        setRemoving(undefined);
        setForm(next);
    };

    const removeVariant = async (variant: string) => {

        setRemoving({ variant, running: true });

        const answer = await bridge.request<{ eval?: EvalView }>(API.evalVariantRemove, { name, variant });

        if (answer.problem || !answer.eval)
            return setRemoving({ variant, running: false, problem: answer.problem ?? "The server did not remove the variant." });

        setRemoving(undefined);
        setShown(answer.eval);

        if (view.variant === variant)
            show({});
    };

    const saveForm = async () => {

        if (!form)
            return;

        setFormProblem(undefined);
        setFormBusy(true);

        const answer = await bridge.request<{ eval?: EvalView }>(API.evalVariantAdd, { name, variant: askOf(form.draft) });

        setFormBusy(false);

        if (answer.problem || !answer.eval)
            return setFormProblem(answer.problem ?? "The server did not save the variant.");

        setShown(answer.eval);
        setForm(undefined);

        // The new column may be off screen, or hidden behind one shown alone.
        if (view.variant || view.report)
            show({});
    };

    /** A variant's own text goes; it then gets the common message alone. Its column's box is emptied too. */
    const clearText = async (variant: EvalVariantView) => {

        setSendProblem(undefined);

        const answer = await bridge.request<{ eval?: EvalView }>(API.evalVariantChange, { name, variant: askOf({ ...draftOf(variant, variant.name), extra: "" }) });

        if (answer.problem || !answer.eval)
            return setSendProblem(answer.problem ?? "The server did not clear the text.");

        setShown(answer.eval);
    };

    const remove = async () => {

        setDeleteProblem(undefined);
        setDeleting("running");

        const answer = await bridge.request(API.evalDelete, { name });

        if (answer.problem) {

            setDeleting("asked");

            return setDeleteProblem(answer.problem);
        }

        location.assign(evalAddress());
    };

    if (!loaded)
        return <div className="evals"><div className="evals__form"><p className="evals__note">Loading…</p></div></div>;

    if (problem || !shown)
        return (
            <div className="evals evals--list">
                <div className="evals__form">
                    <h1>{name}</h1>
                    <p className="evals__problem" role="alert">{problem ?? `There is no evaluation named '${name}'.`}</p>
                    <p><a href={evalAddress()}>All evaluations</a></p>
                </div>
            </div>
        );

    const count = shown.variants.length;

    // A variant gets one message, ever. Send to all goes while none got one; after that, Send to new variants, to the ones added later.
    const freshOnes = shown.variants.filter(one => !one.started && !one.working);
    const fresh = freshOnes.length;
    const anyStarted = fresh < count;

    // The message to all, kept from the first send: shown as it was, and locked.
    const kept = shown.sent;
    const boxText = kept ? kept.text : text;
    const keptTask = kept?.task ? tasks.tasks.find(one => one.name === kept.task) : undefined;

    // Something to send: the common text, or a variant's own. The server names a variant left with nothing.
    const canSend = !sending && fresh > 0 && (boxText.trim() !== "" || freshOnes.some(one => one.extra || one.own));
    const full = shown.variants.length < EVAL_VARIANTS_MAX ? undefined : `An evaluation holds up to ${EVAL_VARIANTS_MAX} variants.`;

    // One column alone: only when the address names a variant that is there.
    const alone = !view.report && shown.variants.some(one => one.name === view.variant) ? view.variant : undefined;

    /** A name nobody has, for a copy of `variant`. */
    const copyName = (variant: EvalVariantView): string => {

        const taken = new Set(shown.variants.map(one => one.name.toLowerCase()));

        for (let number = 2; ; number++) {

            const candidate = `${variant.name}-${number}`.slice(0, 60);

            if (!taken.has(candidate.toLowerCase()))
                return candidate;
        }
    };

    return (
        <div className={view.report ? "evals evals--list" : "evals"}>

            <div className="evals__bar">
                <h1>{shown.name}</h1>
                <div className="evals__switch" role="group" aria-label="What this page shows">
                    <button type="button" className="evals__tab" aria-pressed={!view.report} onClick={() => show({})}>Live</button>
                    <button type="button" className="evals__tab" aria-pressed={view.report === true} onClick={() => show({ report: true })}>Report</button>
                </div>
                <span className="evals__note evals__bar-facts" title={shown.folder}>
                    {shown.folder}{shown.commit ? ` · started from commit ${shown.commit}` : " · a plain copy, not in git"} · {new Date(shown.createdAt).toLocaleDateString()}
                </span>
                <EvalHelp page={view.report ? "report" : "live"} taskFolder={tasks.folder} />
                <Button size="sm" variant="secondary" disabled={full !== undefined} title={full} onClick={() => openForm({ kind: "add", draft: newDraft(options?.defaultRuntime ?? options?.runtimes[0] ?? shown.variants[0]?.runtime ?? "") })}>
                    Add variant
                </Button>
                <Button size="sm" variant="danger" disabled={deleting === "running"} onClick={() => { setForm(undefined); setRemoving(undefined); setDeleteProblem(undefined); setDeleting("asked"); }}>
                    Delete evaluation
                </Button>
                <a href={evalAddress()}>All evaluations</a>
            </div>

            {removing
                ? (
                    <div className="evals__panel" role="alertdialog" aria-label="Remove a variant">
                        <p>
                            Remove <strong>{removing.variant}</strong>? Its copy, its chat and its numbers are removed. It cannot be brought back.
                        </p>
                        {removing.problem ? <p className="evals__problem" role="alert">{removing.problem}</p> : null}
                        <div className="evals__row">
                            <Button variant="danger" disabled={removing.running} onClick={() => void removeVariant(removing.variant)}>{removing.running ? "Removing…" : "Remove for good"}</Button>
                            <Button variant="secondary" disabled={removing.running} onClick={() => setRemoving(undefined)}>Keep it</Button>
                        </div>
                    </div>
                )
                : null}

            {deleting
                ? (
                    <div className="evals__panel" role="alertdialog" aria-label="Delete this evaluation">
                        <p>
                            Delete <strong>{shown.name}</strong>? Its {count} {count === 1 ? "copy" : "copies"}, the chats and the report's numbers are removed.
                            It cannot be brought back. Your own folder, {shown.folder}, is not touched.
                        </p>
                        {deleteProblem ? <p className="evals__problem" role="alert">{deleteProblem}</p> : null}
                        <div className="evals__row">
                            <Button variant="danger" disabled={deleting === "running"} onClick={() => void remove()}>{deleting === "running" ? "Deleting…" : "Delete for good"}</Button>
                            <Button variant="secondary" disabled={deleting === "running"} onClick={() => setDeleting(undefined)}>Keep it</Button>
                        </div>
                    </div>
                )
                : null}

            {form
                ? (
                    <div className="evals__panel" role="group" aria-label="New variant">
                        <h2>{form.kind === "add" ? "New variant" : `Copy of ${form.of}`}</h2>
                        <EvalVariantFields
                            draft={form.draft}
                            options={options}
                            namePlaceholder={`${shown.name}-${count + 1}`}
                            onChange={part => setForm(current => current ? { ...current, draft: { ...current.draft, ...part } } : current)} />
                        {formProblem ? <p className="evals__problem" role="alert">{formProblem}</p> : null}
                        <div className="evals__row">
                            <Button variant="primary" disabled={formBusy || !form.draft.runtime} onClick={() => void saveForm()}>
                                {formBusy ? "Making the copy…" : "Add variant"}
                            </Button>
                            <Button variant="secondary" disabled={formBusy} onClick={() => setForm(undefined)}>Cancel</Button>
                        </div>
                    </div>
                )
                : null}

            {view.report ? <EvalReport shown={shown} /> : null}

            {/* Hidden on the report, not removed: the frames keep their place in the chats. */}
            <div className="evals__live" hidden={view.report === true}>

                <div className="evals__all">
                    <div className="evals__row">
                        <label className="evals__task">
                            Saved task
                            {/* Read again when opened: a task file added a moment ago is in the list. */}
                            <select className="evals__select" value={kept ? kept.task ?? "" : taskName} disabled={kept !== undefined} onFocus={readTasks} onChange={event => pickTask(event.target.value)}>
                                <option value="">None - type your own message</option>
                                {/* A kept task whose file is gone: its name still shows. */}
                                {kept?.task && !keptTask ? <option value={kept.task}>{kept.task}</option> : null}
                                {tasks.tasks.some(one => one.own)
                                    ? <optgroup label="Yours">{tasks.tasks.filter(one => one.own).map(one => <option key={one.name} value={one.name}>{one.title}</option>)}</optgroup>
                                    : null}
                                <optgroup label="Built in">{tasks.tasks.filter(one => !one.own).map(one => <option key={one.name} value={one.name}>{one.title}</option>)}</optgroup>
                            </select>
                        </label>
                    </div>
                    {tasks.problems.map(one => <p className="evals__problem" key={one}>{one}</p>)}
                    <div className="evals__all-row">
                        <label className="evals__field">
                            {kept ? "Common message - sent, kept as it was" : "Common message, for every variant"}
                            <textarea
                                className="evals__text"
                                rows={2}
                                value={boxText}
                                readOnly={kept !== undefined}
                                onChange={event => setText(event.target.value)}
                                onKeyDown={event => {

                                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && canSend) {

                                        event.preventDefault();

                                        void send(anyStarted);
                                    }
                                }} />
                        </label>
                        {!anyStarted
                            ? (
                                <Button variant="primary" disabled={!canSend} onClick={() => void send()}>
                                    Send to all {count}
                                </Button>
                            )
                            : fresh > 0
                                ? (
                                    <Button variant="primary" disabled={!canSend} title="Only to the variants that have not had their message yet. The others are left alone." onClick={() => void send(true)}>
                                        Send to new variants {fresh}
                                    </Button>
                                )
                                : null}
                    </div>
                    {sendProblem ? <p className="evals__problem" role="alert">{sendProblem}</p> : null}
                    {working > 0 ? <p className="evals__note">{working} of {count} still working.</p> : null}
                </div>

                <div className={alone ? "evals__columns evals__columns--alone" : "evals__columns"}>
                    {shown.variants.map(variant => (
                        <section className="evals__column" key={variant.chatId} aria-label={variant.name} hidden={alone !== undefined && alone !== variant.name}>
                            <div className="evals__column-head">
                                <div className="evals__column-line">
                                    <span className="evals__column-name" title={variant.name}>{variant.name}</span>
                                    <span className={variant.working ? "evals__state evals__state--working" : "evals__state"}>{variant.working ? "Working" : variant.started ? "Done" : "Not started"}</span>
                                </div>
                                <div className="evals__column-line">
                                    <span className="evals__column-ai" title={[setupLine(variant), ...(variant.own ? [`Own message, in place of the common one:\n${variant.own}`] : []), ...(variant.extra ? [`Own text:\n${variant.extra}`] : [])].join("\n\n")}>
                                        {setupLine(variant)}{variant.own || variant.extra ? " · own text" : ""}
                                    </span>
                                    <span style={{ flex: 1 }} />
                                    {variant.started || variant.working ? <span className="evals__column-lock">Setup locked</span> : null}
                                    {variant.started || variant.working
                                        ? (
                                            <Button size="xs" fill="ghost" variant="secondary" disabled={full !== undefined} title={full ?? "Make a new variant with this setup, to change one thing and compare. This variant stays as it is."} onClick={() => openForm({ kind: "copy", of: variant.name, draft: draftOf(variant, copyName(variant)) })}>
                                                Copy as new variant
                                            </Button>
                                        )
                                        : variant.extra || variant.own
                                            ? (
                                                <Button size="xs" fill="ghost" variant="secondary" title="Remove this variant's own text: it then gets the common message alone." onClick={() => void clearText(variant)}>
                                                    Clear text
                                                </Button>
                                            )
                                            : null}
                                    {count > 1 && !variant.working
                                        ? (
                                            <Button size="xs" fill="ghost" variant="secondary" title="Remove this variant: its copy, chat and numbers." onClick={() => { setForm(undefined); setDeleting(undefined); setRemoving({ variant: variant.name, running: false }); }}>
                                                Remove
                                            </Button>
                                        )
                                        : null}
                                    {alone
                                        ? <Button size="xs" fill="ghost" variant="secondary" onClick={() => show({})}>Show all columns</Button>
                                        : count > 1
                                            ? <Button size="xs" fill="ghost" variant="secondary" onClick={() => show({ variant: variant.name })}>Full width</Button>
                                            : null}
                                </div>
                            </div>

                            <iframe
                                className="evals__frame"
                                title={`${variant.name}: its chat`}
                                src={columnAddress(variant.chatId)} />
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
