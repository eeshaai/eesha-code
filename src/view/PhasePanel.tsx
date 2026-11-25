import React from "react";
import type { PanelWidths } from "../shared/sddMessages";
import { ResizableSplit, ResizableSplitItem, StatusIndicator, Tabs } from "./ui";

/**
 * The shell both panels are laid out in: a title bar with its actions
 * on the right, a rail down the left, tabs filling the rest, and - when
 * asked for - a footer holding the open tab's file and tools.
 *
 * It knows nothing about specs, workflows, documents or runs. A tab is
 * an id, a label and something to render; the rail is whatever the
 * caller hands it (`WorkflowRail`), or nothing - the spec panel has no
 * rail and shows its phases in the header (`PhaseSteps`).
 */

export interface PhaseTab {

    id: string;

    label: string;

    /** A number shown after the label - open notes, log lines. Absent or zero draws nothing. */
    count?: number;

    /** A class on that number, for a count that carries a severity. */
    countClass?: string;

    /**
     * Something in this tab is worth a look. Drawn as a dot on the tab,
     * and only while the tab is closed - open it and the dot's job is
     * done. `"waiting"` is a question or a permission sitting unanswered
     * (animated, since it is the more urgent of the two); `"done"` is a
     * run that finished while the tab was not the one being read.
     */
    attention?: "waiting" | "done";

    title?: string;

    /**
     * This tab's own controls, while it is open: at the right end of the
     * tab row, or of the footer when the panel has one (`footer`).
     */
    tools?: React.ReactNode;

    /**
     * What the tab is about - its file - drawn before the tools, in the
     * tab row or in the footer.
     */
    info?: React.ReactNode;

    /**
     * Stays mounted while another tab is open, hidden rather than
     * removed. For a tab whose content has state of its own that a
     * remount would lose - a plugin's page in an iframe. Off, a tab is
     * rendered only while it is the open one.
     */
    keepAlive?: boolean;

    render(): React.ReactNode;
}

export interface PhasePanelProps {

    /** Extra classes on the root, for a caller's own rules. */
    className?: string;

    /** The top bar - title, path, whatever the caller wants read first. */
    header?: React.ReactNode;

    /**
     * The actions at the right end of the top bar - Run, Stop, a gate's
     * answer - reachable from any tab.
     */
    actions?: React.ReactNode;

    /**
     * The left column: the caller's own rail. Absent, there is no left
     * column - the spec panel puts its phases in the header instead.
     */
    rail?: React.ReactNode;

    /**
     * Something above the tabs about the whole panel right now - a gate
     * waiting for an answer, which step the tabs describe.
     */
    card?: React.ReactNode;

    tabs: PhaseTab[];

    /** Which tab is open. An id not in `tabs`, or undefined, opens the first. */
    activeTab?: string;

    onTab(id: string): void;

    /** A column on the right, beside the tabs - the spec panel's sessions pane. */
    aside?: React.ReactNode;

    /**
     * The column widths the person dragged, in percent of the panel. A
     * missing one keeps its default share.
     */
    widths?: PanelWidths;

    /**
     * Turns on the bars between the columns, and hears where they were
     * dropped. Called once per drag, when it ends. Absent, the columns
     * keep their fixed widths and no bar is drawn.
     */
    onWidths?(widths: PanelWidths): void;

    /**
     * A bar across the whole bottom of the panel that holds the open
     * tab's file and tools, so the tab row shows only the tab names. It
     * is always drawn, empty when the open tab brings nothing, so it
     * does not come and go as tabs change. Off, the file and tools sit
     * in the tab row.
     */
    footer?: boolean;

    /**
     * Controls about the whole panel, at the far right of the footer,
     * after the open tab's tools - the spec panel's button that shows
     * and hides the sessions pane. Drawn only when `footer` is on.
     */
    footerEnd?: React.ReactNode;
}

/**
 * A tab's name as the tab row draws it: the label, then its count, then
 * a dot when something in a closed tab is worth a look - a question or a
 * permission waiting (animated), or a run that finished while the tab was
 * not the one being read.
 */
function tabLabel(tab: PhaseTab, open: boolean): React.ReactNode {

    return (
        <span className="side-tab">
            {tab.label}
            {tab.count ? (
                <span className={"side-tab__count" + (tab.countClass ? " " + tab.countClass : "")}>
                    {tab.count}
                </span>
            ) : null}
            {/* The UI library's dot: pulsing yellow while a person is
                waited on, a still blue once a run finished unseen. */}
            {tab.attention && !open ? (
                <StatusIndicator
                    className="side-tab__dot"
                    status={tab.attention === "waiting" ? "connecting" : "busy"}
                    srLabel={tab.attention === "waiting" ? "Waiting for you" : "Finished"} />
            ) : null}
        </span>
    );
}

/**
 * A tab's content, drawn only when the library's Tabs draws this item -
 * so a closed tab's `render` is not called at all.
 */
function TabBody({ render }: { render(): React.ReactNode }) {

    return <>{render()}</>;
}

/** A side column's share of the panel, in percent, before anyone drags it. */
const DEFAULT_SIDE = { rail: 18, sessions: 28 };

/** The narrowest and widest a side column is dragged to, in percent. */
const MIN_SIDE = 10;
const MAX_SIDE = 45;

/** The share the tabs keep in the middle, however far a bar is dragged. */
const MIN_MIDDLE = 35;

export default function PhasePanel({
    className, header, actions, rail, card, tabs, activeTab, onTab, aside, widths, onWidths, footer, footerEnd
}: PhasePanelProps) {

    const shown = tabs.find(tab => tab.id === activeTab) ?? tabs[0];

    const tabExtras = shown?.info || shown?.tools
        ? (
            <>
                {shown?.info && <div className="phase-panel__tab-info">{shown.info}</div>}
                {shown?.tools && <div className="phase-panel__tab-tools">{shown.tools}</div>}
            </>
        )
        : undefined;

    const railColumn = rail !== undefined && (
        <div className="phase-panel__rail">{rail}</div>
    );

    const middle = (
        <div className="phase-panel__pane">

            {card && <div className="phase-panel__card">{card}</div>}

            {/* The UI library's Tabs, told which one is open. The open
                tab's file and tools sit at the end of the tab row, or
                in the footer when the panel has one. A `keepAlive` tab
                stays mounted, hidden, so its state (a plugin's page)
                survives a switch away and back. */}
            <Tabs
                className="phase-panel__tabs phase-panel__tabs--row"
                activeIndex={shown ? tabs.indexOf(shown) : 0}
                onChange={index => onTab(tabs[index].id)}
                listExtras={footer ? undefined : tabExtras}>

                {tabs.map(tab => (
                    <Tabs.Item
                        key={tab.id}
                        label={tabLabel(tab, tab === shown)}
                        title={tab.title}
                        keepMounted={tab.keepAlive}
                        className="phase-panel__content">

                        <TabBody render={tab.render} />
                    </Tabs.Item>
                ))}
            </Tabs>
        </div>
    );

    const asideColumn = aside && (
        <div className="phase-panel__aside">{aside}</div>
    );

    return (
        <div className={"phase-panel" + (className ? " " + className : "")}>

            {(header || actions) && (
                <div className="phase-panel__header">

                    <div className="phase-panel__header-main">{header}</div>

                    {actions && <div className="phase-panel__actions">{actions}</div>}
                </div>
            )}

            <div className="phase-panel__body">

                {onWidths
                    ? (
                        <SplitColumns
                            rail={railColumn || undefined}
                            middle={middle}
                            aside={asideColumn || undefined}
                            widths={widths}
                            onWidths={onWidths} />
                    )
                    : (
                        <>
                            {railColumn}
                            {middle}
                            {asideColumn}
                        </>
                    )}
            </div>

            {footer && (
                <div className="phase-panel__footer">
                    {tabExtras}
                    {footerEnd && <div className="phase-panel__footer-end">{footerEnd}</div>}
                </div>
            )}
        </div>
    );
}

/**
 * The columns laid out by the UI library's ResizableSplit: a bar between
 * each pair, and each side column's share of the panel in percent - so
 * the columns grow and shrink with the window. The tabs in the middle
 * take whatever the side columns leave.
 */
function SplitColumns({ rail, middle, aside, widths, onWidths }: {
    rail?: React.ReactNode;
    middle: React.ReactNode;
    aside?: React.ReactNode;
    widths?: PanelWidths;
    onWidths(widths: PanelWidths): void;
}) {

    const railSize = rail ? widths?.rail ?? DEFAULT_SIDE.rail : 0;
    const asideSize = aside ? widths?.sessions ?? DEFAULT_SIDE.sessions : 0;

    const sizes = [
        ...(rail ? [railSize] : []),
        100 - railSize - asideSize,
        ...(aside ? [asideSize] : [])
    ];

    return (
        <ResizableSplit
            sizes={sizes}
            dividerLabels={[
                ...(rail ? ["Resize the phase list"] : []),
                ...(aside ? ["Resize the sessions pane"] : [])
            ]}
            onResize={next => onWidths({
                ...widths,
                ...(rail ? { rail: round(next[0]) } : {}),
                ...(aside ? { sessions: round(next[next.length - 1]) } : {})
            })}>

            {[
                ...(rail ? [<ResizableSplitItem key="rail" min={MIN_SIDE} max={MAX_SIDE}>{rail}</ResizableSplitItem>] : []),
                <ResizableSplitItem key="middle" min={MIN_MIDDLE}>{middle}</ResizableSplitItem>,
                ...(aside ? [<ResizableSplitItem key="aside" min={MIN_SIDE} max={MAX_SIDE}>{aside}</ResizableSplitItem>] : [])
            ]}
        </ResizableSplit>
    );
}

/** A percent kept to one decimal place - enough to put a bar back where it was. */
function round(percent: number): number {

    return Math.round(percent * 10) / 10;
}
