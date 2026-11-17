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


import PhasePanel from "../../view/PhasePanel";
import PhaseSteps from "../../view/PhaseSteps";
import { providerPartsOf } from "../../view/ChatView";
import { ProviderLine } from "../../view/ui";
import { SddViewProps } from "../../view/templates/TemplateRunView";
import { useRunState } from "./runState";
import { useImplementState } from "./implementState";
import { useDocEditing } from "./docEditing";
import { useDocParts } from "./docParts";
import { usePhaseTabs } from "./phaseTabs";

/**
 * The spec panel: phases in a rail on the left, the selected phase's
 * tabs in the middle - Doc, Logs and Prompt for a document phase,
 * Tasks, Logs and Prompt for an execution phase, Logs and Prompt for
 * a document not yet written. The conversations are phase chats,
 * normal sessions beside the spec. The layout is `PhasePanel`;
 * this file decides what goes in it.
 *
 * The header has the spec's AI picker: the runtime and model every
 * phase runs on from now. A phase chat's own pickers are locked.
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
        title, widths, saveWidths, setSelectedName, current, setTab, shownTab, full, specDir, items,
        card, actions, tabs, tillDialog, aiChoice, setAiChoice, specStages, isRunning
    } = { ...runState, ...implementState, ...docEditing, ...docParts, ...phaseTabs };

    // What the phase picked runs on, else the first phase that runs a
    // model - a gate has none.
    const stageAi = current?.ai ?? specStages.find(stage => stage.ai)?.ai;

    return (
        <PhasePanel
            className={"sdd-view" + (full ? " phase-panel--full" : "")}
            header={(
            <header className="sdd-view__header">

                {/* The whole name and the spec folder are the title's
                    tooltip - the name is cut short on a long spec, and
                    the steps use the room on this row. */}
                <div
                    className="sdd-view__title"
                    title={specDir ? `${title}\n${specDir.replace(/[\\/][^\\/]*$/, "")}` : title}>
                    {title}
                </div>

                <PhaseSteps items={items} selectedId={current?.name} onSelect={setSelectedName} />

                {stageAi && aiChoice && setAiChoice
                    ? (
                        <div className="sdd-view__ai" title="What every phase of this spec runs on from now">
                            <ProviderLine
                                look="menus"
                                capitalizeNames
                                disabled={isRunning}
                                parts={providerPartsOf(
                                    { current: stageAi, choice: aiChoice, onPick: setAiChoice },
                                    { running: isRunning, onHandover: () => undefined, refreshModels: props.refreshModels })} />
                        </div>
                    )
                    : null}

                {tillDialog}

                {/* The count of changed blocks is not shown beside the
                    title. It is on the Doc tab's "What changed" button,
                    which is the thing you press when you read it - a
                    number on a header is a fact, and a number on the
                    button that acts on it is an offer. */}
            </header>
            )}
            actions={actions}
            card={card}
            tabs={tabs}
            activeTab={shownTab}
            onTab={setTab}
            widths={widths}
            onWidths={saveWidths}
            footer />
    );
}
