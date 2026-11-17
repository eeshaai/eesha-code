import React, { useCallback, useEffect, useRef, useState } from "react";

import { FeatureSettings, GeneralSettings, Modal, RuntimeSettings, SettingsFrame, SettingsIntro, StorageSettings } from "../view/ui";
import { API, SettingsChange, SettingsView, ThemeChoice } from "../server/protocol";
import { bridge } from "./bridge";
import ConnectorsPage from "./ConnectorsPage";
import FolderPicker from "./FolderPicker";
import MemoryPage, { MemoryConnector } from "./MemoryPage";
import { type SettingsSection, settingsAddress } from "./pageRoute";
import { shortPath } from "./shortPath";
import { applyFontSize } from "./theme";

/*
 * Settings, in place of the chat. A menu on the left opens one section at
 * a time, each at its own address (pageRoute.ts):
 *
 *   General     the theme, the text size, the working folders (Add a
 *               folder… opens the folder picker), the port (with Pick a
 *               free port), and the whole settings.json text box for
 *               everything else.
 *   Connectors  ConnectorsPage.tsx, with the Memory block of MemoryPage.tsx under it.
 *   Memory      MemoryPage.tsx: every saved memory, to add, edit and delete.
 *   Runtimes    one card per runtime: its program, Set as default,
 *               the Enabled / Disabled switch, and its denied tools. Add a runtime below
 *               them, and Remove on the ones added.
 *   Features    the feature flags that matter here.
 *   Storage     what the trash and old scratch folders hold.
 *
 * The UI library draws it: SettingsFrame for the menu and heading, and
 * GeneralSettings, RuntimeSettings, FeatureSettings and StorageSettings
 * for the sections. This file asks the server and keeps what is typed.
 *
 * A simple control writes its change at once; the text box writes on
 * Save. The server checks every change the way the engine reads the file,
 * and refuses one it would fail on.
 */

/** The text size's limits - the same as the server's FONT_SIZE in settings.ts. */
const FONT_DEFAULT = 16;
const FONT_MIN = 11;
const FONT_MAX = 24;

/** How long after the last A+ or A- press the size is saved, in ms. */
const SIZE_SAVE_DELAY = 400;

const THEMES: { value: ThemeChoice; label: string }[] = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "system", label: "Follow the system" }
];

type Clearing = "trash" | "scratch";

/** The left menu, top to bottom. */
const SECTIONS: { section: SettingsSection; label: string }[] = [
    { section: "general", label: "General" },
    { section: "connectors", label: "Connectors" },
    { section: "memory", label: "Memory" },
    { section: "runtimes", label: "Runtimes" },
    { section: "features", label: "Features (Experimental)" },
    { section: "storage", label: "Storage" }
];

export default function SettingsPage({ section }: {

    /** The section on screen. Each section is its own page load. */
    section: SettingsSection;
}) {

    const [view, setView] = useState<SettingsView | undefined>();
    const [problem, setProblem] = useState<string | undefined>();
    const [text, setText] = useState("");
    const [textProblem, setTextProblem] = useState<string | undefined>();
    const [port, setPort] = useState("");
    const [clearing, setClearing] = useState<Clearing | undefined>();
    const [busy, setBusy] = useState(false);

    /** The Add a runtime form, while it is open. */
    const [adding, setAdding] = useState<{ id: string; command: string; args: string } | undefined>();
    const [checking, setChecking] = useState(false);
    const [addProblem, setAddProblem] = useState<string | undefined>();

    /** The runtime the Remove question is about. */
    const [removing, setRemoving] = useState<string | undefined>();

    /** The folder picker for "Add a folder…" under Working folders is open. */
    const [pickingWorking, setPickingWorking] = useState(false);

    /** "Turn off" boxes typed in and not saved yet, by runtime id. */
    const [offDrafts, setOffDrafts] = useState<Record<string, string>>({});

    /** The text box has edits not saved: a control's change does not overwrite them. */
    const dirty = useRef(false);

    const [stale, setStale] = useState(false);

    /** The port in the file when the page last showed it. */
    const savedPort = useRef<number | undefined>(undefined);

    /** The text size in the file when the page last showed it. */
    const fileSize = useRef<number | undefined>(undefined);

    const show = useCallback((next: SettingsView) => {

        setView(next);
        fileSize.current = next.fontSize;

        // Only when the saved port changed: a port typed or picked but not
        // saved yet stays in the box while other settings change.
        if (savedPort.current !== next.port) {

            savedPort.current = next.port;
            setPort(String(next.port));
        }

        if (dirty.current)
            setStale(true);
        else
            setText(next.text);
    }, []);

    const send = useCallback(async (route: string, body: Record<string, unknown>): Promise<boolean> => {

        setBusy(true);
        setProblem(undefined);

        try {

            const answer = await bridge.request<SettingsView>(route, body);

            if (answer.problem || !answer.file) {

                setProblem(answer.problem ?? "The server did not answer.");

                return false;
            }

            show(answer);

            return true;

        } catch (error) {

            setProblem(`Could not reach the server: ${(error as Error).message}`);

            return false;

        } finally {

            setBusy(false);
        }
    }, [show]);

    useEffect(() => { void send(API.settings, {}); }, [send]);

    const change = (one: SettingsChange): void => void send(API.settingsChange, one as Record<string, unknown>);

    /*
     * A+ and A-: the page takes the new size at once, and it is saved
     * only when the presses stop. Saving on every press would lock the
     * buttons while it ran, so quick presses would be lost.
     */
    const [pickedSize, setPickedSize] = useState<number | undefined>();
    const sizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const sizeToSave = useRef<number | undefined>(undefined);

    const saveSize = useCallback(async (): Promise<void> => {

        const size = sizeToSave.current;

        sizeTimer.current = undefined;

        if (size === undefined)
            return;

        const saved = await send(API.settingsChange, { fontSize: size });

        // A press while it was saving is saved by its own timer.
        if (sizeToSave.current !== size)
            return;

        sizeToSave.current = undefined;
        setPickedSize(undefined);

        // Refused: the page goes back to the size in the file.
        if (!saved && fileSize.current !== undefined)
            applyFontSize(fileSize.current);
    }, [send]);

    const pickSize = (size: number): void => {

        const next = Math.min(FONT_MAX, Math.max(FONT_MIN, size));

        sizeToSave.current = next;
        setPickedSize(next);
        applyFontSize(next);

        clearTimeout(sizeTimer.current);
        sizeTimer.current = setTimeout(() => void saveSize(), SIZE_SAVE_DELAY);
    };

    // Leaving the page before the timer runs still saves the size.
    useEffect(() => () => {

        if (sizeTimer.current !== undefined) {

            clearTimeout(sizeTimer.current);
            void saveSize();
        }
    }, [saveSize]);

    const saveText = async (): Promise<void> => {

        setBusy(true);
        setTextProblem(undefined);

        try {

            const answer = await bridge.request<SettingsView>(API.settingsSave, { text });

            if (answer.problem || !answer.file) {

                setTextProblem(answer.problem ?? "The server did not answer.");

                return;
            }

            dirty.current = false;
            setStale(false);
            show(answer);

        } finally {

            setBusy(false);
        }
    };

    const revert = (): void => {

        dirty.current = false;
        setStale(false);
        setTextProblem(undefined);
        setText(view?.text ?? "");
    };

    /** Check and add: the server starts the program once, so this can take up to 20 seconds. */
    const addRuntime = async (): Promise<void> => {

        if (!adding)
            return;

        setChecking(true);
        setAddProblem(undefined);

        try {

            const answer = await bridge.request<SettingsView>(API.runtimeAdd, { ...adding });

            if (answer.problem || !answer.file)
                return setAddProblem(answer.problem ?? "The server did not answer.");

            setAdding(undefined);
            show(answer);

        } catch (error) {

            setAddProblem(`Could not reach the server: ${(error as Error).message}`);

        } finally {

            setChecking(false);
        }
    };

    const removeRuntime = async (id: string): Promise<void> => {

        setRemoving(undefined);

        await send(API.runtimeRemove, { id });
    };

    /** Fills the Port box with a port nothing uses now. Nothing is saved. */
    const pickFreePort = async (): Promise<void> => {

        setProblem(undefined);

        try {

            const answer = await bridge.request<{ port?: number }>(API.freePort, {});

            if (answer.problem || !answer.port)
                return setProblem(answer.problem ?? "The server gave no port.");

            setPort(String(answer.port));

        } catch (error) {

            setProblem(`Could not reach the server: ${(error as Error).message}`);
        }
    };

    const clear = async (what: Clearing): Promise<void> => {

        setClearing(undefined);

        await send(what === "trash" ? API.emptyTrash : API.removeScratch, {});
    };

    const sections = SECTIONS.map(one => ({ id: one.section, label: one.label, href: settingsAddress(one.section) }));
    const title = SECTIONS.find(one => one.section === section)!.label;

    const frame = (body: React.ReactNode) => (
        <SettingsFrame sections={sections} current={section} title={title}>{body}</SettingsFrame>
    );

    // Connectors keeps its own page, with its own saving. Memory is a
    // connector too: its choices sit under the others.
    if (section === "connectors")
        return frame(<><ConnectorsPage /><MemoryConnector /></>);

    // Memory keeps its own page too: the memories are not in settings.json.
    if (section === "memory")
        return frame(<MemoryPage />);

    if (!view)
        return frame(problem
            ? <p className="ee-settings__problem" role="alert">{problem}</p>
            : <p className="ee-settings__quiet">Loading…</p>);

    // A file the engine cannot read: only the text box can fix it.
    const locked = view.problem !== undefined || busy;

    // A+ and A- stay on while a save runs: their presses are not lost.
    const sizeLocked = view.problem !== undefined;
    const fontSize = pickedSize ?? view.fontSize;

    // One block per runtime: the ones found first, then the ones not
    // found, each in the picker's order. `toggleRuntime` keeps using the
    // picker's order.
    const listed = [...view.runtimes.filter(runtime => runtime.found), ...view.runtimes.filter(runtime => !runtime.found)];

    const toggleRuntime = (id: string): void => {

        const providers = view.runtimes.filter(runtime => runtime.id === id ? !runtime.shown : runtime.shown).map(runtime => runtime.id);

        change({ providers });
    };

    // Tools turned off for a runtime id that is in none of the blocks (one
    // removed from the file, or a typo): shown below them, so they can be
    // seen and cleared.
    const unlistedTools = Object.keys(view.runtimeTools).filter(id => !view.runtimes.some(runtime => runtime.id === id));

    const savedOff = (id: string): string[] => view.runtimeTools[id]?.toolsOff ?? [];
    const offText = (id: string): string => offDrafts[id] ?? savedOff(id).join(", ");
    const offTyped = (id: string): string[] => [...new Set(offText(id).split(",").map(one => one.trim()).filter(Boolean))];
    const offChanged = (id: string): boolean => offTyped(id).join(",") !== savedOff(id).join(",");
    const offBox = (id: string) => ({ text: offText(id), changed: offChanged(id) });

    const saveOff = async (id: string): Promise<void> => {

        if (!offChanged(id))
            return;

        if (await send(API.settingsChange, { runtimeTools: { id, toolsOff: offTyped(id) } }))
            setOffDrafts(drafts => { const next = { ...drafts }; delete next[id]; return next; });
    };

    const portNumber = Number(port);
    const portChanged = port.trim() !== "" && portNumber !== view.port;

    /** The folders picked go after the saved ones; the server drops one already there. Resolves to a problem to show in the picker. */
    const addWorking = async (picked: string[]): Promise<string | undefined> => {

        try {

            const answer = await bridge.request<SettingsView>(API.settingsChange, { workingFolders: [...view.workingFolders, ...picked] });

            if (answer.problem || !answer.file)
                return answer.problem ?? "The server did not answer.";

            setPickingWorking(false);
            show(answer);

            return undefined;

        } catch (error) {

            return `Could not reach the server: ${(error as Error).message}`;
        }
    };

    return frame(
        <>
            {/* Storage clears folders: nothing there is written to settings.json. */}
            <SettingsIntro
                file={section !== "storage" ? view.file : undefined}
                fileProblem={view.problem}
                textBoxHref={section === "general" ? undefined : settingsAddress("general")}
                problem={problem} />

            {section === "general"
                ? (
                    <GeneralSettings
                        themes={THEMES}
                        theme={view.theme}
                        onTheme={theme => change({ theme: theme as ThemeChoice })}
                        fontSize={fontSize}
                        fontMin={FONT_MIN}
                        fontMax={FONT_MAX}
                        fontDefault={FONT_DEFAULT}
                        sizeLocked={sizeLocked}
                        onFontSize={pickSize}
                        port={port}
                        portChanged={portChanged}
                        runningPort={view.runningPort}
                        onPortChange={setPort}
                        onPickFreePort={() => void pickFreePort()}
                        onPortSave={() => change({ port: portNumber })}
                        workingFolders={view.workingFolders}
                        onWorkingFolderAdd={() => setPickingWorking(true)}
                        onWorkingFolderRemove={folder => change({ workingFolders: view.workingFolders.filter(one => one !== folder) })}
                        text={text}
                        textProblem={textProblem}
                        stale={stale}
                        onTextChange={next => { dirty.current = true; setText(next); }}
                        onRevert={revert}
                        onSave={() => void saveText()}
                        locked={locked}
                        busy={busy} />
                )
                : null}

            {section === "general" && pickingWorking
                ? (
                    <Modal show onHide={() => setPickingWorking(false)} className="eesha-wide-modal">
                        <Modal.Header closeButton onClose={() => setPickingWorking(false)}>
                            <Modal.Title>Add working folders</Modal.Title>
                        </Modal.Header>
                        <Modal.Body>
                            <FolderPicker
                                initial={[]}
                                allExtras
                                heading="Folders to add"
                                intro="Pick the folders where you keep your code."
                                submitLabel="Add"
                                onCancel={() => setPickingWorking(false)}
                                onSubmit={addWorking} />
                        </Modal.Body>
                    </Modal>
                )
                : null}

            {section === "runtimes"
                ? (
                    <RuntimeSettings
                        runtimes={listed.map(runtime => ({
                            id: runtime.id,
                            own: Boolean(runtime.own),
                            shown: runtime.shown,
                            found: runtime.found,
                            foundShort: runtime.found ? shortPath(runtime.found) : undefined,
                            install: runtime.install,
                            program: runtime.program,
                            // A runtime not on this machine has no use for a
                            // tools box, unless the file already denies some.
                            tools: runtime.found !== undefined || savedOff(runtime.id).length > 0 ? offBox(runtime.id) : undefined
                        }))}
                        shownCount={listed.filter(runtime => runtime.shown).length}
                        defaultRuntime={view.defaultRuntime}
                        unlisted={unlistedTools.map(id => ({ id, ...offBox(id) }))}
                        locked={locked}
                        onSetDefault={id => change({ defaultRuntime: id })}
                        onToggleShown={toggleRuntime}
                        onToolsChange={(id, value) => setOffDrafts(drafts => ({ ...drafts, [id]: value }))}
                        onToolsSave={id => void saveOff(id)}
                        adding={adding}
                        checking={checking}
                        addProblem={addProblem}
                        onAddOpen={() => setAdding({ id: "", command: "", args: "" })}
                        onAddChange={setAdding}
                        onAddCancel={() => { setAdding(undefined); setAddProblem(undefined); }}
                        onAddSubmit={() => void addRuntime()}
                        removing={removing}
                        onRemoveAsk={setRemoving}
                        onRemoveCancel={() => setRemoving(undefined)}
                        onRemoveConfirm={id => void removeRuntime(id)} />
                )
                : null}

            {section === "features"
                ? <FeatureSettings flags={view.flags} locked={locked} onFlag={(name, on) => change({ flag: { name, on } })} />
                : null}

            {section === "storage"
                ? (
                    <StorageSettings
                        trash={view.storage.trash}
                        scratch={view.storage.scratch}
                        busy={busy}
                        clearing={clearing}
                        onAsk={setClearing}
                        onCancel={() => setClearing(undefined)}
                        onConfirm={what => void clear(what)} />
                )
                : null}
        </>
    );
}
