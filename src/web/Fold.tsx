import React from "react";

import { PanelButton, UiIcon } from "../view/ui";

/*
 * One section of the workspace panel on the left (see sideState.ts): a
 * 32px head that opens and closes it, and what it holds under the head.
 *
 * Most sections hold a pane that draws its own head with its own buttons
 * - Files, Git. While such a section is open, the pane's head shows and a
 * click on its title closes the section; its buttons work as before.
 * While it is closed, the pane is hidden and this file draws the head,
 * with a short fact after the title ("3 files"). A section that holds no
 * such pane (`own`) always gets this file's head, with `actions` on it.
 */

export interface FoldAction {

    icon: React.ComponentProps<typeof PanelButton>["icon"];

    label: string;

    title?: string;

    onClick(): void;
}

export interface FoldProps {

    /** Its name in the class list - `eesha-fold--git`. */
    name: string;

    title: string;

    /** Said after the title while it is closed. */
    fact?: string;

    open: boolean;

    onToggle(): void;

    /** It draws no head of its own: this file draws it, open or closed. */
    own?: boolean;

    /** Buttons on the head of an `own` section. */
    actions?: FoldAction[];

    children?: React.ReactNode;
}

export default function Fold({ name, title, fact, open, onToggle, own, actions, children }: FoldProps) {

    const toggle = (
        <button
            type="button"
            className="eesha-fold__toggle"
            aria-expanded={open}
            title={open ? `Close ${title}` : `Open ${title}`}
            onClick={onToggle}>
            <UiIcon name="chevron-right" size="sm" className="eesha-fold__arrow" />
            <span className="eesha-fold__title">{title}</span>
            {!open && fact ? <span className="eesha-fold__fact">{fact}</span> : null}
        </button>
    );

    if (own)
        return (
            <section className={`eesha-fold eesha-fold--own eesha-fold--${name}${open ? " is-open" : ""}`} aria-label={title}>
                <div className="ee-panel-head eesha-fold__head">
                    {toggle}
                    {open ? actions?.map(action => <PanelButton key={action.label} icon={action.icon} label={action.label} title={action.title} onClick={action.onClick} />) : null}
                </div>
                <div className="eesha-fold__body" hidden={!open}>{children}</div>
            </section>
        );

    return (
        <section className={`eesha-fold eesha-fold--${name}${open ? " is-open" : ""}`} aria-label={title}>
            {open ? <div className="eesha-fold__over">{toggle}</div> : <div className="ee-panel-head eesha-fold__head">{toggle}</div>}
            {children}
        </section>
    );
}
