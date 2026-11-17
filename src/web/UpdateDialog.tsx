import React, { useEffect, useState } from "react";

import { Button, Modal } from "../view/ui";
import { API, isNewerVersion, type UpdateCheckView } from "../server/protocol";
import { bridge } from "./bridge";

/*
 * Opened from the version in the footer when Eesha Code is installed from
 * npm. Asks npm for the newest Eesha Code and, when it is newer, offers
 * Upgrade: the server stops, the newer version is installed, and it
 * starts again. Run from source, the footer builds at once and this
 * window is never opened (App.tsx, buildAndRestart).
 *
 * Once the server stops, the page waits; the app reloads it when the
 * server says hello again (see onStarted).
 */

type Step =
    | { at: "checking" }
    | { at: "checked"; view: UpdateCheckView; problem?: string }
    | { at: "working"; view: UpdateCheckView }
    | { at: "restarting"; view: UpdateCheckView };

export default function UpdateDialog({ onClose, onStarted }: {

    onClose(): void;

    /** The server is stopping to upgrade: the page reloads when it is back. */
    onStarted(): void;
}) {

    const [step, setStep] = useState<Step>({ at: "checking" });

    useEffect(() => {

        let live = true;

        void bridge.request<UpdateCheckView>(API.updateCheck, {})
            .catch((error: Error) => ({ problem: error.message }) as UpdateCheckView)
            .then(view => { if (live) setStep({ at: "checked", view }); });

        return () => { live = false; };
    }, []);

    const start = async (view: UpdateCheckView) => {

        setStep({ at: "working", view });

        const answer = await bridge.request(API.updateStart, { version: view.latest })
            .catch((error: Error) => ({ problem: error.message }));

        if (answer.problem)
            return setStep({ at: "checked", view, problem: answer.problem });

        setStep({ at: "restarting", view });
        onStarted();
    };

    const busy = step.at === "working" || step.at === "restarting";

    let body: React.ReactNode;
    let action: React.ReactNode = null;

    if (step.at === "checking")
        body = <p>Asking npm for the newest version…</p>;
    else if (!step.view.kind)
        // The server did not answer at all.
        body = <pre className="eesha-update-problem">{step.view.problem ?? "No answer from the server."}</pre>;
    else {

        const { view } = step;
        const hasNewer = view.latest !== undefined && isNewerVersion(view.latest, view.current);

        const lines: React.ReactNode[] = [
            <p key="current">You have <b>{view.current}</b>, installed from npm.</p>
        ];

        if (view.latest)
            lines.push(<p key="latest">{hasNewer ? <>npm has <b>{view.latest}</b>.</> : <>npm has {view.latest} - you have the latest.</>}</p>);

        if (view.problem)
            lines.push(<pre key="check" className="eesha-update-problem">{view.problem}</pre>);

        if (step.at === "working")
            lines.push(<p key="working">Stopping Eesha Code to install…</p>);
        else if (step.at === "restarting")
            lines.push(<p key="restarting">Eesha Code stopped and is installing {view.latest}, then it starts again - this page reloads by itself when it is back. If it does not come back, run <code>eesha status</code>.</p>);
        else {

            if (step.problem)
                lines.push(<pre key="problem" className="eesha-update-problem">{step.problem}</pre>);

            if (hasNewer)
                lines.push(<p key="how">Upgrade stops Eesha Code, installs {view.latest} with npm, and starts it again. Open sessions come back after the restart.</p>);
        }

        body = lines;

        if (step.at === "checked" && hasNewer)
            action = <Button type="button" variant="primary" size="sm" onClick={() => void start(view)}>Upgrade to {view.latest}</Button>;
    }

    return (
        <Modal show onHide={() => { if (!busy) onClose(); }}>
            <Modal.Header closeButton={!busy} onClose={onClose}>
                <Modal.Title>Eesha Code version</Modal.Title>
            </Modal.Header>
            <Modal.Body>{body}</Modal.Body>
            <Modal.Footer>
                {busy ? null : <Button type="button" fill="ghost" size="sm" onClick={onClose}>Close</Button>}
                {action}
            </Modal.Footer>
        </Modal>
    );
}
