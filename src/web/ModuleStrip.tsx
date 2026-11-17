import React from "react";

import { StatusDot, type StatusTone, UiIcon } from "../view/ui";
import type { StripModule, StripState } from "./sideState";

/*
 * The strip at the far left of the page: always 44px of icons, never
 * words. One icon for now: AI (the sessions); specs are in the Spec
 * explorer on the right. A click on an icon
 * opens that module's panel just right of the strip; a click on the
 * pressed icon hides the panel again. The pressed icon has a blue line
 * on its left and white colour; the others are grey.
 */

export interface ModuleStripProps {

    state: StripState;

    onPick(module: StripModule): void;

    /** The AI icon's dot: another session waits for you, or works. Only while the AI panel is hidden. */
    aiDot?: { tone: StatusTone; label: string };

    /** The shortcut that shows or hides the panel, for the hover text: "Ctrl+B". */
    toggleKeys: string;
}

export default function ModuleStrip({ state, onPick, aiDot, toggleKeys }: ModuleStripProps) {

    const button = (module: StripModule, name: string, icon: React.ReactNode, dot?: ModuleStripProps["aiDot"]) => {

        const pressed = state.open && state.module === module;

        return (
            <button
                type="button"
                className="eesha-strip-button"
                aria-label={name}
                aria-pressed={pressed}
                title={`${name} (${toggleKeys} shows or hides the panel)`}
                onClick={() => onPick(module)}>
                {icon}
                {dot ? <StatusDot tone={dot.tone} label={dot.label} className="eesha-strip-dot" /> : null}
            </button>
        );
    };

    return (
        <nav className="eesha-strip" aria-label="Modules">
            {button("ai", "AI sessions", <UiIcon name="chat" size="md" />, state.open && state.module === "ai" ? undefined : aiDot)}
        </nav>
    );
}
