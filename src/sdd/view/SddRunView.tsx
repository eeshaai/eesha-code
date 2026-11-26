/*
 * The SDD run view - the spec editor page. Its work is split into
 * parts, one per file, called one after another in this order:
 *
 *   runState.tsx        the phase and tab picked, Doc tab modes, notes, links
 *   implementState.tsx  tasks, chats, lanes, waves, logs, questions
 *   docEditing.tsx      editing blocks and the prompt, adding notes, links in a doc
 *   docParts.tsx        renderers, rails, phase card, buttons, task rows
 *   phaseTabs.tsx       each tab drawn, Run till here
 *
 * Small shared pieces are in runViewHelpers.tsx. This file only puts
 * the header, the tabs and the panes on the page.
 */

import { useContext } from "react";

import PhasePanel from "../../view/PhasePanel";
import PhaseSteps from "../../view/PhaseSteps";
import { Button, HeaderButton, LibraryMenu, type MenuEntry, StatusDot } from "../../view/ui";
import { SddViewProps } from "../../view/templates/TemplateRunView";
import { useRunState } from "./runState";
import { useImplementState } from "./implementState";
import { useDocEditing } from "./docEditing";
import { useDocParts } from "./docParts";
import { usePhaseTabs } from "./phaseTabs";
import { SpecPageContext } from "./specPage";

/**
 * The spec panel: phases in a rail on the left, the selected phase's
 * tabs in the middle - Doc, Logs and Prompt for a document phase,
 * Tasks, Logs and Prompt for an execution phase, Logs and Prompt for
 * a document not yet written. The conversations are phase chats,
 * normal sessions beside the spec. The layout is `PhasePanel`;
 * this file decides what goes in it.
 *
 * The header has no runtime or model picker. Each phase runs on what
 * style.yml and settings.json say, and a phase chat's own pickers are
 * locked.
 *
 * There is no tab row. The phase's main view - Doc, or Tasks in the
 * execution phase - shows; the others (Prompt, Logs, Wave graph, a
 * plugin's page) are in the header's ⋯ menu, with the spec's older chats
 * the page adds (specPage.ts). Another view open, a button in the header
 * goes back to the main one. The page's box over the document says what
 * waits for you.
 *
 * Everything shown comes from the style and the disk. Stages and
 * their artifacts arrive in the SpecState message, so a phase added to
 * style.yml appears here with no code change. Position is the first
 * document phase whose artifact is missing, and Start sits on that row.
 *
 * A brand-new spec has only its idea document, so every later chip is
 * empty until that phase's document lands and the watcher brings it in.
 */
export default function SddRunView(props: SddViewProps) {

    const runState = useRunState(props);
    const implementState = useImplementState(runState);
    const docEditing = useDocEditing({ ...runState, ...implementState });
    const docParts = useDocParts({ ...runState, ...implementState, ...docEditing });
    const phaseTabs = usePhaseTabs({ ...runState, ...implementState, ...docEditing, ...docParts });

    const {
        widths, saveWidths, setSelectedName, current, setTab, shownTab, full, items,
        card, actions, tabs, tillDialog, firstTab
    } = { ...runState, ...implementState, ...docEditing, ...docParts, ...phaseTabs };

    const page = useContext(SpecPageContext);

    /** The phase's main view: the one it opens on. The others are in the ⋯ menu. */
    const main = tabs.find(tab => tab.id === firstTab) ?? tabs[0];
    const open = tabs.find(tab => tab.id === shownTab) ?? main;
    const away = main !== undefined && open !== undefined && open.id !== main.id;

    const menu: MenuEntry[] = [
        { heading: "Show" },
        ...tabs.map((tab): MenuEntry => ({
            label: `${tab.label}${tab.count ? ` (${tab.count})` : ""}`,
            onSelect: () => setTab(tab.id),
            end: tab.id === open?.id
                ? "shown"
                : tab.attention ? <StatusDot tone={tab.attention === "waiting" ? "waiting" : "working"} label={tab.attention === "waiting" ? "waiting for you" : "finished"} /> : undefined
        })),
        ...(page.menu ?? [])
    ];

    // A view in the menu wants a look: the ⋯ button gets its dot.
    const menuDot = tabs.some(tab => tab.id !== open?.id && tab.attention === "waiting")
        ? "waiting" as const
        : tabs.some(tab => tab.id !== open?.id && tab.attention) ? "working" as const : undefined;

    return (
        <PhasePanel
            className={"sdd-view sdd-view--menu" + (full ? " phase-panel--full" : "")}
            header={(
            <header className="sdd-view__header">

                {/* No spec name here: the editor tab above already shows it. */}
                <PhaseSteps items={items} selectedId={current?.name} onSelect={setSelectedName} />

                {away
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" title={`Back to ${main.label}`} onClick={() => setTab(main.id)}>
                            ← {main.label}
                        </Button>
                    )
                    : null}

                <LibraryMenu
                    ariaLabel="More of this spec"
                    placement="bottom"
                    items={menu}
                    trigger={
                        <HeaderButton
                            size="sm"
                            label="More of this spec"
                            title="Prompt, Logs, Wave graph and the spec's chats"
                            icon="more"
                            dot={menuDot}
                            dotLabel={menuDot === "waiting" ? "a view waits for you" : "a view has news"} />
                    } />

                {tillDialog}

                {/* The count of changed blocks is not shown in this
                    header. It is on the Doc tab's "What changed" button,
                    which is the thing you press when you read it - a
                    number on a header is a fact, and a number on the
                    button that acts on it is an offer. */}
            </header>
            )}
            actions={actions}
            card={page.box || card ? <>{page.box}{card}</> : undefined}
            tabs={tabs}
            activeTab={shownTab}
            onTab={setTab}
            widths={widths}
            onWidths={saveWidths}
            footer />
    );
}
