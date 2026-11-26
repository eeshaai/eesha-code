import React, { useEffect, useState } from "react";

import { API, type EvalReport as Report, type EvalVariantReport, type EvalView } from "../server/protocol";
import { bridge } from "./bridge";
import { comparable, costIn, costText, countText, type EvalTotals, findingRows, lowestOf, sizeText, timeText, totalsOf } from "./evalNumbers";
import { setupLine } from "./EvalVariantFields";

/*
 * The Evaluator's report - `/eval/<name>?view=report`. One column per
 * variant: how long it took, what it charged, how many turns and tool
 * calls, what it listed as findings, where the time went, which files
 * its copy differs in.
 *
 * Numbers only. It never names a variant as better overall, and never
 * says whether a variant did the task. The lowest value of a row is
 * green, which is a number, not a verdict. How to read it is in the
 * page's Help (EvalHelp.tsx), not on the page.
 */

/** How often the numbers are read again while a variant works. */
const REFRESH_MS = 10_000;

/** The files table shows this many rows; the rest are counted. */
const FILES_SHOWN = 200;

/** The findings table shows this many rows; the rest are counted. */
const FINDINGS_SHOWN = 200;

/** How many of the slowest calls a variant's card lists. */
const SLOWEST = 5;

export default function EvalReport({ shown }: { shown: EvalView }): React.JSX.Element {

    const [report, setReport] = useState<Report | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    const working = shown.variants.some(one => one.working);

    // Read when the evaluation changes (a turn started or ended, a variant was added), and every few seconds while one works.
    useEffect(() => {

        let live = true;

        const read = () => void bridge.request<{ report?: Report }>(API.evalReport, { name: shown.name }).then(answer => {

            if (!live)
                return;

            setProblem(answer.problem);

            if (answer.report)
                setReport(answer.report);
        });

        read();

        const timer = working ? setInterval(read, REFRESH_MS) : undefined;

        return () => { live = false; clearInterval(timer); };

    }, [shown, working]);

    if (problem && !report)
        return <div className="evals__report"><p className="evals__problem" role="alert">{problem}</p></div>;

    if (!report)
        return <div className="evals__report"><p className="evals__note">Reading the numbers…</p></div>;

    // The report's variants in the page's order, each with its setup.
    const rows = shown.variants.flatMap(variant => {

        const numbers = report.variants.find(one => one.name === variant.name);

        // A variant gets one message: its first turn is all there is to count. (An evaluation from before that rule may have more; they are left out.)
        return numbers ? [{ variant, numbers, totals: totalsOf(numbers, true) }] : [];
    });

    const anySent = rows.some(row => row.numbers.turns.length > 0);

    return (
        <div className="evals__report">

            {!anySent ? <p className="evals__note">Nothing sent yet.</p> : null}
            {report.paused ? <p className="evals__note">Changed files and sizes are counted when every variant has finished.</p> : null}

            <h2>Numbers</h2>
            {/* The head - each variant's name and setup - stays at the top while the page scrolls. */}
            <div className="evals__table-wrap evals__table-wrap--sticky">
                <table className="evals__table evals__table--numbers">
                    <thead>
                        <tr>
                            <th scope="col" />
                            {rows.map(row => <th scope="col" key={row.variant.name}>{row.variant.name}</th>)}
                        </tr>
                        <tr className="evals__setup-row">
                            <th scope="row">Setup</th>
                            {rows.map(row => <th scope="col" key={row.variant.name}>{setupLine(row.variant)}{row.variant.extra ? " · own text" : ""}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {numberRows(rows.map(row => row.totals)).map(line => (
                            <tr key={line.label}>
                                <th scope="row" title={line.hint}>{line.label}</th>
                                {line.cells.map((cell, index) => <td key={rows[index]!.variant.name} className={line.lowest[index] ? "evals__lowest" : undefined}>{cell}</td>)}
                            </tr>
                        ))}
                        <tr>
                            <th scope="row" title="Files that differ from where the copy started, as they are on disk now - whatever message changed them.">Files changed</th>
                            {rows.map(row => <td key={row.variant.name}>{filesCell(row.numbers)}</td>)}
                        </tr>
                        <tr>
                            <th scope="row">Copy on disk</th>
                            {rows.map(row => <td key={row.variant.name}>{sizeText(row.numbers.bytes)}</td>)}
                        </tr>
                        <tr>
                            <th scope="row" title="The version the runtime's program said, when this variant's message was sent.">Runtime version</th>
                            {rows.map(row => <td key={row.variant.name}>{row.variant.version ?? "-"}</td>)}
                        </tr>
                        <tr>
                            <th scope="row" title="The model ids the runtime said it used, exactly as it named them.">Model used</th>
                            {rows.map(row => <td key={row.variant.name}>{row.totals.models.length ? row.totals.models.join(", ") : "-"}</td>)}
                        </tr>
                        <tr>
                            <th scope="row">Added</th>
                            {rows.map(row => <td key={row.variant.name}>{new Date(row.variant.addedAt).toLocaleDateString()}</td>)}
                        </tr>
                    </tbody>
                </table>
            </div>

            {/* Only after a saved Find or Fix task: with no lists there is nothing to show. */}
            {rows.some(row => row.totals.findings !== undefined)
                ? (
                    <>
                        <h2>Findings</h2>
                        <FindingsTable names={rows.map(row => row.variant.name)} all={rows.map(row => row.totals.findings)} />
                    </>
                )
                : null}

            <h2>Where the time went</h2>
            <div className="evals__cards">
                {rows.map(row => <TimeCard key={row.variant.name} name={row.variant.name} totals={row.totals} />)}
            </div>

            <h2>Files each variant changed</h2>
            <FilesTable rows={rows.map(row => row.numbers)} inGit={shown.commit !== undefined} />

            <p className="evals__note">On disk in all: {sizeText(report.bytes)}.</p>
        </div>
    );
}

/** The numbers table's rows: a label, what it counts, and one cell per variant. */
function numberRows(all: readonly EvalTotals[]): { label: string; hint: string; cells: string[]; lowest: boolean[] }[] {

    return plainRows(all).map(row => ({
        label: row.label,
        hint: row.hint,
        cells: row.cells,

        lowest: row.value
            ? lowestOf(all.map(totals => comparable(totals) ? row.value!(totals) : undefined))
            : all.map(() => false)
    }));
}

/**
 * The rows before the green marks. `value`: the number the row compares,
 * only for a row where lower is plainly better - total time, cost, failed
 * and refused calls. Rows where lower can just mean the variant did less
 * (tool calls, their time, turns) or that are not comparable between
 * models (tokens: each model counts them its own way, and cost already
 * says what they charged) have none.
 */
function plainRows(all: readonly EvalTotals[]): { label: string; hint: string; cells: string[]; value?: (totals: EvalTotals) => number | undefined }[] {

    // Costs are compared only in one unit: the one the first charged variant was charged in.
    const unit = all.find(totals => totals.cost.length)?.cost[0]?.unit;

    const dash = "-";
    const soFar = (totals: EvalTotals, text: string) => totals.running ? `${text} so far` : text;
    const count = (value: number | undefined) => value === undefined ? dash : countText(value);
    const sent = (totals: EvalTotals, text: string) => totals.turns ? text : dash;

    return [
        {
            label: "How it ended",
            hint: "Finished: the agent stopped by itself. Stopped: you pressed Stop. Failed: the runtime failed, or the turn hit its time limit. A stopped or failed variant gets no green.",
            cells: all.map(totals => sent(totals, totals.running ? "still working" : totals.ended ?? "finished"))
        },
        {
            label: "Total time",
            value: totals => totals.ms,
            hint: "From the message being sent until the agent stopped.",
            cells: all.map(totals => sent(totals, soFar(totals, timeText(totals.ms))))
        },
        {
            label: "Time in tool calls",
            hint: "The part of the total time spent inside tool calls: reading, editing, shell commands.",
            cells: all.map(totals => sent(totals, timeText(totals.toolMs)))
        },
        {
            label: "Rest of the time",
            hint: "Total time less the time in tool calls: the model thinking and writing, and the runtime starting.",
            cells: all.map(totals => sent(totals, timeText(Math.max(0, totals.ms - totals.toolMs))))
        },
        {
            label: "Tool calls",
            hint: "How many tool calls ended.",
            cells: all.map(totals => sent(totals, countText(totals.toolCalls)))
        },
        {
            label: "Failed tool calls",
            value: totals => totals.failed,
            hint: "Tool calls the runtime itself marked as failed.",
            cells: all.map(totals => sent(totals, countText(totals.failed)))
        },
        {
            label: "Refused calls",
            value: totals => totals.refused,
            hint: "Calls that were refused: outside the variant's copy, or a write to memory or a connector.",
            cells: all.map(totals => sent(totals, countText(totals.refused)))
        },
        {
            label: "Turns",
            hint: "How many times the model was called: each time it answers, or asks for tool calls. Only some runtimes say.",
            cells: all.map(totals => count(totals.modelCalls))
        },
        {
            label: "Cost",
            value: totals => costIn(totals.cost, unit),
            hint: "What the runtime said it charged. Credits are an allowance, not money.",
            cells: all.map(totals => costText(totals.cost))
        },
        {
            label: "Tokens read",
            hint: "Everything the model read, cache included.",
            cells: all.map(totals => count(totals.inputTokens))
        },
        {
            label: "of which from cache",
            hint: "The part of the tokens read that came from the cache.",
            cells: all.map(totals => count(totals.cachedTokens))
        },
        {
            label: "Tokens written",
            hint: "What the model wrote.",
            cells: all.map(totals => count(totals.outputTokens))
        },
        {
            label: "Findings listed",
            hint: "How many problems the variant listed in its answer to a saved Find or Fix task. A dash: its answer has no such list.",
            cells: all.map(totals => totals.findings ? countText(totals.findings.length) : dash)
        },
        {
            label: "Runtime errors",
            hint: "Whether the runtime wrote an error line in any of the counted turns.",
            cells: all.map(totals => sent(totals, totals.error ? "yes" : "none"))
        }
    ];
}

function filesCell(numbers: EvalVariantReport): string {

    if (numbers.filesProblem)
        return "could not be read";

    if (!numbers.files)
        return "-";

    const count = (status: string) => numbers.files!.filter(file => file.status === status).length;

    return numbers.files.length
        ? `${numbers.files.length} (${count("added")} added, ${count("modified")} changed, ${count("deleted")} deleted)`
        : "0";
}

/** One variant's time by kind of tool call, and its slowest single calls. */
function TimeCard({ name, totals }: { name: string; totals: EvalTotals }): React.JSX.Element {

    const rest = Math.max(0, totals.ms - totals.toolMs);

    const lines = [
        ...totals.tools.map(tool => ({
            label: tool.tool,
            ms: tool.ms,
            facts: `${tool.calls} ${tool.calls === 1 ? "call" : "calls"}${tool.failed ? `, ${tool.failed} failed` : ""}`,
            calls: totals.calls.filter(call => call.kind === tool.tool)
        })),
        { label: "Rest: model and runtime", ms: rest, facts: "", calls: [] }
    ];

    const longest = Math.max(1, ...lines.map(line => line.ms));
    const slowest = totals.calls.slice(0, SLOWEST);

    const row = (line: typeof lines[number]) => (
        <>
            <span className="evals__bar-label" title={line.label}>{line.label}</span>
            <span className="evals__bar-track"><span className="evals__bar-fill" style={{ width: `${Math.round(line.ms / longest * 100)}%` }} /></span>
            <span className="evals__bar-time">{timeText(line.ms)}</span>
            <span className="evals__bar-facts">{line.facts}</span>
        </>
    );

    return (
        <section className="evals__card" aria-label={`${name}: where the time went`}>
            <h3>{name}</h3>

            {!totals.turns
                ? <p className="evals__note">Nothing sent yet.</p>
                : (
                    <>
                        <ul className="evals__bars">
                            {lines.map(line => (
                                <li key={line.label}>
                                    {line.calls.length
                                        ? (
                                            <details className="evals__kind">
                                                <summary className="evals__bar-row">{row(line)}</summary>
                                                <ol className="evals__slowest">
                                                    {line.calls.map((call, index) => (
                                                        <li key={index}>
                                                            <span className="evals__bar-time">{timeText(call.ms)}</span>
                                                            <span className="evals__slowest-title" title={call.title}>{call.failed ? "failed · " : ""}{call.title}</span>
                                                        </li>
                                                    ))}
                                                </ol>
                                            </details>
                                        )
                                        : <div className="evals__bar-row">{row(line)}</div>}
                                </li>
                            ))}
                        </ul>

                        {slowest.length
                            ? (
                                <>
                                    <h4>Slowest calls</h4>
                                    <ol className="evals__slowest">
                                        {slowest.map((call, index) => (
                                            <li key={index}>
                                                <span className="evals__bar-time">{timeText(call.ms)}</span>
                                                <span className="evals__slowest-title" title={call.title}>{call.title}</span>
                                            </li>
                                        ))}
                                    </ol>
                                </>
                            )
                            : null}
                    </>
                )}
        </section>
    );
}

/**
 * What the variants listed, side by side: one row per place in the code,
 * one cell per variant. It shows who listed what. It does not say which
 * finding is right - a place only one variant listed can be the real one.
 */
function FindingsTable({ names, all }: { names: readonly string[]; all: readonly (EvalTotals["findings"])[] }): React.JSX.Element {

    const rows = findingRows(all);
    const silent = names.filter((_name, index) => all[index] === undefined);

    return (
        <>
            {silent.length
                ? <p className="evals__note" title="It was not asked for one, has not finished, or did not write it in the form asked.">No list from: {silent.join(", ")}.</p>
                : null}

            {!rows.length
                ? <p className="evals__note">Every variant that wrote a list said it found nothing.</p>
                : (
                    <div className="evals__table-wrap">
                        <table className="evals__table evals__table--findings">
                            <thead>
                                <tr>
                                    <th scope="col">File and line</th>
                                    <th scope="col">Listed by</th>
                                    {names.map(name => <th scope="col" key={name}>{name}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.slice(0, FINDINGS_SHOWN).map(row => (
                                    <tr key={`${row.file}:${row.line}`}>
                                        <th scope="row" title={row.file}>{row.file}{row.line ? `:${row.line}` : ""}</th>
                                        <td>{row.found} of {names.length}</td>
                                        {row.cells.map((cell, index) => (
                                            <td key={names[index]}>
                                                {cell
                                                    ? <>{cell.severity ? <span className={`evals__severity evals__severity--${cell.severity}`}>{cell.severity}</span> : null} {cell.problem}</>
                                                    : null}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

            {rows.length > FINDINGS_SHOWN ? <p className="evals__note">{rows.length - FINDINGS_SHOWN} more rows are not listed.</p> : null}
        </>
    );
}

/** Every changed file as a row, one cell per variant: what that variant did to it. */
function FilesTable({ rows, inGit }: { rows: readonly EvalVariantReport[]; inGit: boolean }): React.JSX.Element {

    if (!inGit)
        return <p className="evals__note">Not in git: no list of changed files.</p>;

    const paths = [...new Set(rows.flatMap(row => (row.files ?? []).map(file => file.path)))].sort((left, right) => left.localeCompare(right));
    const problems = rows.filter(row => row.filesProblem);

    return (
        <>
            {problems.map(row => <p className="evals__problem" key={row.name}>{row.name}: its changed files could not be read. {row.filesProblem}</p>)}

            {!paths.length
                ? <p className="evals__note">No copy differs from where it started.</p>
                : (
                    <div className="evals__table-wrap">
                        <table className="evals__table evals__table--files">
                            <thead>
                                <tr>
                                    <th scope="col">File</th>
                                    {rows.map(row => <th scope="col" key={row.name}>{row.name}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {paths.slice(0, FILES_SHOWN).map(path => (
                                    <tr key={path}>
                                        <th scope="row" title={path}>{path}</th>
                                        {rows.map(row => {

                                            const status = row.files?.find(file => file.path === path)?.status;

                                            return <td key={row.name} className={status ? `evals__file evals__file--${status}` : "evals__file"}>{status === "modified" ? "changed" : status ?? ""}</td>;
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

            {paths.length > FILES_SHOWN ? <p className="evals__note">{paths.length - FILES_SHOWN} more files are not listed.</p> : null}
        </>
    );
}
