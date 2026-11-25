import React, { useCallback, useEffect, useState } from "react";

import { accessGroups, accessOptions, connectorGroups, looseLines } from "../view/connectors/connectorView";
import { ConnectorsPage as LibraryConnectorsPage } from "../view/ui";
import { API, type AdoChoices, type ConnectorAccess, type ConnectorCard, type ConnectorId, type GithubChoices, type OfferedGroup, type ToPage } from "../server/protocol";
import { bridge } from "./bridge";

/*
 * The Connectors page:
 * one card for Azure DevOps and one for GitHub. Sign in runs the CLI's own sign-in; Connect
 * (or Edit) opens a window to pick what is in reach and each source's
 * access; Disconnect forgets the choices but leaves the CLI signed in.
 *
 * The UI library's ConnectorsPage draws it all. This file asks the server,
 * follows a sign-in, and keeps what the Connect window is editing.
 */

const SOURCES: Record<ConnectorId, { id: string; label: string; readOnly?: boolean; startsOff?: boolean }[]> = {
    ado: [
        { id: "workitems", label: "Work items" },
        { id: "queries", label: "Saved queries", readOnly: true },
        { id: "repos", label: "Repos (the agent changes code with git)", readOnly: true },
        { id: "pulls", label: "Pull requests" },
        { id: "builds", label: "Build pipelines" },
        { id: "releases", label: "Release pipelines" },
        { id: "wiki", label: "Wiki", readOnly: true },
        { id: "testplans", label: "Test plans", readOnly: true }
    ],
    github: [
        { id: "repos", label: "Repos (the agent clones with git)", readOnly: true },
        { id: "files", label: "Files and history", readOnly: true },
        { id: "pulls", label: "Pull requests" },
        { id: "issues", label: "Issues" },
        { id: "actions", label: "Actions" },
        { id: "releases", label: "Releases" },
        { id: "discussions", label: "Discussions", readOnly: true },
        { id: "projects", label: "Projects (needs gh auth refresh -s read:project)", readOnly: true, startsOff: true }
    ]
};

/** A reach entry as one line: "org/project", or "owner" / "owner/repo". */
function reachLines(card: ConnectorCard): string[] {

    if (!card.config)
        return [];

    return card.id === "ado"
        ? (card.config as AdoChoices).reach.map(one => `${one.org}/${one.project}`)
        : [...(card.config as GithubChoices).reach];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A line as the groups spell it, when it is one of theirs. GitHub owners are lines too; ADO organizations are not. */
function inGroups(card: ConnectorCard, groups: readonly OfferedGroup[], line: string): string | undefined {

    for (const group of groups) {

        if (card.id === "github" && same(group.name, line))
            return group.name;

        const item = group.items.find(one => same(one, line));

        if (item)
            return item;
    }

    return undefined;
}

/**
 * The ticked lines in the order they are shown. On GitHub a repo whose
 * owner is ticked is left out: the owner covers it.
 */
function tickedLines(editing: Editing): string[] {

    const github = editing.card.id === "github";
    const all = [...editing.loose, ...editing.groups.flatMap(group => github ? [group.name, ...group.items] : group.items)];
    const lines: string[] = [];

    for (const line of all)
        if (editing.ticked.has(line) && !lines.some(one => same(one, line)))
            lines.push(line);

    return github
        ? lines.filter(line => !line.includes("/") || !lines.some(owner => !owner.includes("/") && same(owner, line.split("/")[0])))
        : lines;
}

interface SignInState {

    lines: string[];

    code?: string;

    url?: string;

    problem?: string;
}

/** What the Connect window is editing. */
interface Editing {

    card: ConnectorCard;

    /** Lines in no group: saved, from the remotes, or added by hand. */
    loose: string[];

    /** GitHub owners with their repos, ADO organizations with their projects. */
    groups: OfferedGroup[];

    /** The groups shown open. */
    open: Set<string>;

    ticked: Set<string>;

    sources: Record<string, ConnectorAccess>;

    added: string;
}

/**
 * The cards from the last visit, kept in this browser tab (sessionStorage).
 * The server's answer takes a second or two: it asks the Azure and GitHub
 * command-line tools who is signed in each time. So the page shows these
 * at once and swaps in the new answer when it comes. Every page change
 * here loads the page again, which is why it is not kept in memory. The
 * cards hold no secrets: names, accounts, the chosen projects and repos.
 */
const KEPT_CARDS = "eesha.connectorCards";

function keptCards(): ConnectorCard[] | undefined {

    try {

        const text = sessionStorage.getItem(KEPT_CARDS);

        return text ? JSON.parse(text) as ConnectorCard[] : undefined;

    } catch {

        return undefined;
    }
}

export default function ConnectorsPage() {

    const [cards, setCardsNow] = useState<ConnectorCard[] | undefined>(keptCards);

    const setCards = useCallback((next: ConnectorCard[]) => {

        try {
            sessionStorage.setItem(KEPT_CARDS, JSON.stringify(next));
        } catch {
            // Storage off or full: the page still works, it only shows Loading next time.
        }

        setCardsNow(next);
    }, []);
    const [problem, setProblem] = useState<string | undefined>();
    const [signIns, setSignIns] = useState<Partial<Record<ConnectorId, SignInState>>>({});
    const [editing, setEditing] = useState<Editing | undefined>();
    const [removing, setRemoving] = useState<ConnectorCard | undefined>();
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {

        try {

            const answer = await bridge.request<{ cards?: ConnectorCard[] }>(API.connectors, {});

            if (answer.cards)
                setCards(answer.cards);
            else
                setProblem(answer.problem ?? "The server did not answer.");

        } catch (error) {

            setProblem(`Could not reach the server: ${(error as Error).message}`);
        }
    }, [setCards]);

    useEffect(() => { void load(); }, [load]);

    // What a sign-in prints, and its end.
    useEffect(() => bridge.onPage((message: ToPage) => {

        if (message.type !== "eesha.connectorSignIn")
            return;

        if (message.done) {

            const done = message.done;

            setSignIns(all => ({ ...all, [message.id]: "problem" in done ? { lines: [], problem: done.problem } : undefined }));
            void load();

            return;
        }

        setSignIns(all => {

            const before = all[message.id] ?? { lines: [] };

            return {
                ...all,
                [message.id]: {
                    lines: message.line ? [...before.lines, message.line].slice(-4) : before.lines,
                    code: message.code ?? before.code,
                    url: before.url ?? message.url
                }
            };
        });
    }), [load]);

    const signIn = async (id: ConnectorId): Promise<void> => {

        setSignIns(all => ({ ...all, [id]: { lines: [] } }));

        const answer = await bridge.request(API.connectorSignIn, { id });

        if (answer.problem)
            setSignIns(all => ({ ...all, [id]: { lines: [], problem: answer.problem } }));
    };

    const stopSignIn = (id: ConnectorId): void => void bridge.request(API.connectorSignIn, { id, stop: true });

    const startEditing = (card: ConnectorCard): void => {

        const groups = card.offered;
        const spelled = (line: string) => inGroups(card, groups, line) ?? line;
        const saved = reachLines(card).map(spelled);
        const found = card.found.map(spelled);
        const loose: string[] = [];

        for (const line of [...saved, ...found])
            if (!inGroups(card, groups, line) && !loose.some(one => same(one, line)))
                loose.push(line);

        const ticked = new Set(card.config ? saved : found);
        const defaults = Object.fromEntries(SOURCES[card.id].map(source => [source.id, (source.startsOff ? "off" : "read") as ConnectorAccess]));

        setEditing({
            card,
            loose,
            groups,
            // A group with something ticked in it starts open.
            open: new Set(groups.filter(group => group.items.some(item => ticked.has(item))).map(group => group.name)),
            // A new connection starts with what the remotes point to ticked.
            // The groups are offered, not ticked.
            ticked,
            sources: card.config ? { ...defaults, ...card.config.sources } : defaults,
            added: ""
        });
    };

    const save = async (): Promise<void> => {

        if (!editing)
            return;

        const lines = tickedLines(editing);

        // Saving with nothing ticked would leave `>ado>` with nothing to show.
        if (!lines.length)
            return setProblem(editing.card.id === "ado" ? "Tick at least one project, or add one as org/project." : "Tick at least one owner or repo, or add one.");

        const config = editing.card.id === "ado"
            ? {
                reach: lines.map(line => {

                    const at = line.indexOf("/");

                    return { org: line.slice(0, at), project: line.slice(at + 1) };
                }),
                sources: editing.sources
            }
            : { reach: lines, sources: editing.sources };

        setBusy(true);

        try {

            const answer = await bridge.request<{ cards?: ConnectorCard[] }>(API.connectorSave, { id: editing.card.id, config });

            if (answer.problem) {

                setProblem(answer.problem);

                return;
            }

            setProblem(undefined);
            setEditing(undefined);

            if (answer.cards)
                setCards(answer.cards);

        } finally {

            setBusy(false);
        }
    };

    const remove = async (card: ConnectorCard): Promise<void> => {

        setRemoving(undefined);

        const answer = await bridge.request<{ cards?: ConnectorCard[] }>(API.connectorRemove, { id: card.id });

        if (answer.problem)
            return setProblem(answer.problem);

        if (answer.cards)
            setCards(answer.cards);
    };

    const addLine = (): void => {

        if (!editing)
            return;

        const line = editing.added.trim();

        if (!line)
            return;

        if (editing.card.id === "ado" && !/^[^/\s]+\/[^/]+$/.test(line))
            return setProblem("Write an ADO project as org/project, like contoso/Web.");

        if (editing.card.id === "github" && !/^[^/\s]+(\/[^/\s]+)?$/.test(line))
            return setProblem("Write a GitHub owner, like octocat, or a repo, like octocat/hello.");

        setProblem(undefined);

        const grouped = inGroups(editing.card, editing.groups, line);
        const known = grouped ?? editing.loose.find(one => same(one, line));
        const ticked = new Set(editing.ticked).add(known ?? line);
        const group = grouped ? editing.groups.find(one => one.items.includes(grouped)) : undefined;

        setEditing({
            ...editing,
            loose: known ? editing.loose : [...editing.loose, line],
            open: group ? new Set(editing.open).add(group.name) : editing.open,
            ticked,
            added: ""
        });
    };

    const toggle = (line: string, on: boolean): void => {

        if (!editing)
            return;

        const ticked = new Set(editing.ticked);

        if (on)
            ticked.add(line);
        else
            ticked.delete(line);

        setEditing({ ...editing, ticked });
    };

    /**
     * The group's own box. GitHub: the owner itself, which covers all its
     * repos, so its repo ticks go. ADO: all its projects, or none.
     */
    const toggleGroup = (group: OfferedGroup): void => {

        if (!editing)
            return;

        const ticked = new Set(editing.ticked);

        if (editing.card.id === "github") {

            if (ticked.has(group.name))
                ticked.delete(group.name);
            else {

                ticked.add(group.name);
                group.items.forEach(item => ticked.delete(item));
            }

        } else if (group.items.every(item => ticked.has(item)))
            group.items.forEach(item => ticked.delete(item));
        else
            group.items.forEach(item => ticked.add(item));

        setEditing({ ...editing, ticked });
    };

    const openGroup = (group: OfferedGroup): void => {

        if (!editing)
            return;

        const open = new Set(editing.open);

        if (open.has(group.name))
            open.delete(group.name);
        else
            open.add(group.name);

        setEditing({ ...editing, open });
    };

    const github = editing?.card.id === "github";

    return (
        <LibraryConnectorsPage
            cards={cards?.map(card => ({
                id: card.id,
                title: card.title,
                cli: Boolean(card.cli),
                account: card.account,
                connected: Boolean(card.config),
                signingIn: Boolean(card.signingIn),
                install: card.install,
                reach: reachLines(card),
                access: card.config
                    ? accessGroups(SOURCES[card.id].map(source => ({
                        label: source.label.replace(/ \(.*\)$/, ""),
                        access: (card.config!.sources as Record<string, ConnectorAccess>)[source.id]
                    })))
                    : undefined,
                signIn: signIns[card.id]
                    ? { ...signIns[card.id]!, waitingText: card.id === "ado" ? "az login is waiting for the browser." : "gh auth login is waiting for the browser." }
                    : undefined
            }))}
            intro={<>
                Connectors are for the agent: once connected, every new session gets tools to read them, and to change them where you allow it. A change always asks you first. In the message box, <code>&gt;</code> picks an item: <code>&gt;ado&gt;workitems&gt;12345</code>.
            </>}
            problem={problem}
            onSignIn={id => void signIn(id as ConnectorId)}
            onStopSignIn={id => stopSignIn(id as ConnectorId)}
            onEdit={id => { const card = cards?.find(one => one.id === id); if (card) startEditing(card); }}
            onDisconnectAsk={id => setRemoving(cards?.find(one => one.id === id))}
            disconnecting={removing
                ? { id: removing.id, text: `Disconnect ${removing.title}? New sessions get no ${removing.title} tools. The ${removing.id === "ado" ? "az" : "gh"} CLI stays signed in.` }
                : undefined}
            onDisconnectCancel={() => setRemoving(undefined)}
            onDisconnectConfirm={() => { if (removing) void remove(removing); }}
            editor={editing
                ? {
                    title: editing.card.title,
                    connected: Boolean(editing.card.config),
                    reachText: github
                        ? "The owners and repos the agent may look at. The list starts with what your folders' git remotes point to, then your GitHub account and its organizations, each with its repos. Tick an owner for all its repos, also ones made later, or open it and tick only some repos."
                        : "The projects the agent may look at. The list starts with what your folders' git remotes point to, then each Azure DevOps organization you belong to, with its projects. Ticking an organization ticks all the projects it has now; a project made later is not included.",
                    loose: looseLines(editing.loose, editing.ticked),
                    groups: connectorGroups(editing.groups, editing.ticked, github, github ? "repos" : "projects"),
                    open: [...editing.open],
                    kind: github ? "repos" : "projects",
                    emptyText: github ? "Nothing found in your folders' remotes - add it below." : "No project found in your folders' remotes or your Azure DevOps organizations - add it below.",
                    addPlaceholder: github ? "owner or owner/repo" : "org/project",
                    added: editing.added,
                    sources: SOURCES[editing.card.id].map(source => ({ id: source.id, label: source.label, options: accessOptions(source.readOnly) })),
                    access: editing.sources,
                    busy,
                    onToggle: toggle,
                    onToggleGroup: name => { const group = editing.groups.find(one => one.name === name); if (group) toggleGroup(group); },
                    onOpenGroup: name => { const group = editing.groups.find(one => one.name === name); if (group) openGroup(group); },
                    onAddedChange: text => setEditing({ ...editing, added: text }),
                    onAdd: addLine,
                    onAccess: (source, value) => setEditing({ ...editing, sources: { ...editing.sources, [source]: value } }),
                    onSave: () => void save(),
                    onCancel: () => setEditing(undefined)
                }
                : undefined}
        />
    );
}
