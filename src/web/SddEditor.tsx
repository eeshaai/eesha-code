import React, { useEffect, useState } from "react";

import SddSpecView from "../sdd/view/SddSpecView";
import { focusSdd, setSddHost } from "../sdd/view/host";
import { Button, PopoverDefaults } from "../view/ui";
import { sddLine, specLine, type SpecShown } from "./sddLine";

/*
 * The SDD editor: a spec as an editor tab, beside a session - its phase
 * rail, the phase's tabs (Doc, Prompt, Logs, and Tasks and Wave graph in
 * implementation) and Next beside the title. The phase's conversation is
 * not here: it is the phase chat, a normal session. Its line to the
 * server is sddLine.ts, set here once when this file loads.
 *
 * Only the tab in front is drawn. Brought to the front again, it opens
 * its spec on the server again and draws from what the server sends.
 */
setSddHost(sddLine);

export default function SddEditor({ spec, phase }: {
    spec: SpecShown;

    /** The phase to show first - the phase of the chat beside it. */
    phase?: string;
}) {

    const id = JSON.stringify([spec.workspace, spec.spec, spec.folder ?? ""]);

    /** Bumped by "Show it here instead", which opens the spec here again. */
    const [round, setRound] = useState(0);

    /** What the line said of this spec: nothing yet, why it did not open, or that another browser tab took it. */
    const [state, setState] = useState<{ at: string; problem?: string; moved?: boolean } | undefined>();

    const at = `${id}#${round}`;

    useEffect(() => {

        specLine.show(spec, {
            problem: text => setState({ at, problem: text }),
            moved: () => setState({ at, moved: true })
        });

        setState({ at });

        // A wave chat's phase is `implement@wave:2`: the view finds its phase from it.
        if (phase)
            focusSdd(phase.includes("@") ? { ownerId: phase } : { phase });

        return () => specLine.show(undefined);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [at]);

    // Drawn only once the line shows this spec, so the view reads its own page state.
    if (state?.at !== at)
        return null;

    if (state.moved)
        return (
            <div className="eesha-spec-tab">
                <div className="eesha-gone">
                    <h2>This spec is open in another tab</h2>
                    <p>A spec is shown in one browser tab at a time, and it was opened in another one.</p>
                    <Button variant="primary" onClick={() => setRound(now => now + 1)}>Show it here instead</Button>
                </div>
            </div>
        );

    if (state.problem !== undefined)
        return (
            <div className="eesha-spec-tab">
                <div className="eesha-gone">
                    <h2>That spec is not here</h2>
                    <p>{state.problem}</p>
                </div>
            </div>
        );

    return (
        <div className="eesha-spec-tab">
            <PopoverDefaults compactBelow={false}>
                <SddSpecView key={at} />
            </PopoverDefaults>
        </div>
    );
}
