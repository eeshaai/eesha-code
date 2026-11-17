import React, { useEffect, useState } from "react";

import { Button, Input } from "../view/ui";
import type { PathMatch } from "../shared/composeFiles";
import { API } from "../server/protocol";
import { bridge } from "./bridge";

/*
 * Picks an item through Eesha Code's connectors - the levels of the
 * compose box's `>` list, starting at `root`, read only. Used by New
 * spec (a work item or issue to start a spec from) and by the workspace
 * window (the work item or issue the workspace is for).
 *
 * Picking a level that has more below opens it. Picking an item hands
 * its whole path to `onPick`, which says what it is; a problem it gives
 * back is shown under the list.
 */
export default function ConnectorPick({ root, emptyText, onPick }: {

    /** Where the list starts: ["ado", "workitems"], ["github"]. */
    root: string[];

    /** What the list says when the first level is empty. */
    emptyText: string;

    /** An item was picked: its whole path. Resolves to a problem to show, or nothing when it is taken. */
    onPick(path: string[]): Promise<string | undefined>;
}) {

    const [path, setPath] = useState<string[]>(root);
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<PathMatch[] | undefined>();
    const [refresh, setRefresh] = useState(0);
    const [problem, setProblem] = useState<string | undefined>();

    useEffect(() => {

        let live = true;

        setRows(undefined);

        const timer = setTimeout(() => {

            void bridge.request<{ rows?: PathMatch[] }>(API.sddPick, { path, query, ...(refresh ? { refresh: true } : {}) }).then(answer => {

                if (live)
                    setRows(answer.rows ?? [{ name: "problem", detail: answer.problem ?? "No answer.", disabled: true }]);
            });
        }, 200);

        return () => { live = false; clearTimeout(timer); };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path.join(">"), query, refresh]);

    const pick = async (row: PathMatch) => {

        if (row.disabled)
            return;

        if (row.refresh)
            return setRefresh(count => count + 1);

        setQuery("");
        setProblem(undefined);

        if (!row.leaf)
            return setPath([...path, row.name]);

        setProblem(await onPick([...path, row.name]));
    };

    return (
        <div className="eesha-pick" role="group" aria-label="Pick with a connector">
            <div className="eesha-pick__bar">
                <code className="eesha-pick__path">{">" + path.join(">") + ">"}</code>
                {path.length > root.length
                    ? <Button size="sm" fill="ghost" onClick={() => { setQuery(""); setPath(path.slice(0, -1)); }}>Back</Button>
                    : null}
                <Input size="sm" aria-label="Search this level" placeholder="Search by number or words" value={query} onChange={event => setQuery(event.target.value)} />
            </div>
            <ul className="eesha-pick__rows">
                {rows === undefined
                    ? <li className="eesha-workspace-quiet">Asking the connector…</li>
                    : rows.length === 0
                        ? <li className="eesha-workspace-quiet">{path.length === root.length ? emptyText : "Nothing here."}</li>
                        : rows.map(row => (
                            <li key={row.name}>
                                <button
                                    type="button"
                                    className="eesha-pick__row"
                                    disabled={row.disabled}
                                    title={row.hint ?? row.detail}
                                    onClick={() => void pick(row)}>
                                    <strong>{row.name}</strong>
                                    {row.detail ? <span> {row.detail}</span> : null}
                                    {row.hint ? <em> {row.hint}</em> : null}
                                    {!row.leaf && !row.refresh && !row.disabled ? <span aria-hidden> ›</span> : null}
                                </button>
                            </li>
                        ))}
            </ul>
            {problem ? <p className="eesha-new-spec-problem" role="alert">{problem}</p> : null}
        </div>
    );
}
