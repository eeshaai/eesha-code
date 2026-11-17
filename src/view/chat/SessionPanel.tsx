import React from "react";
import { AccountUsage, ContextUsage, McpServerState, ModelSpend, Spend, addModelSpend, addSpend } from "../../core/models/run";
import { LEVEL_NAMES, type PermissionLevel } from "../../core/models/permissionCard";
import { compactReady, contextSegments, COMPACT_FROM_PERCENT, modelFlow, runtimeLabel, shownSpend, spendsText, tokenText } from "../ChatView";
import type { LogEntry } from "../templates/logEntry";
import { Button, ContextWindowMeter, UsageRow, UsageTable } from "../ui";

/*
 * The Session panel: what one session is made of and what it
 * used, one section each - Runtime, Context, Usage, Account, Folders,
 * Tools, MCP servers, Connectors and Steering. Drawn by the chat view
 * into the right panel (see `side.session` in ChatPane).
 *
 * Every figure is one the runtime or Eesha Code itself reported. A
 * section with nothing to show says so in one line; Account, which only
 * some runtimes send, is left out altogether when there is none.
 */

/** What only the page knows - the chat view has none of it. */
export interface SessionExtras {

    /** The session's folders, the working one first. Empty: it works in its own scratch folder. */
    folders: string[];

    /** The runtime's own tools the settings turn off, by runtime id. */
    toolsOff?: Record<string, string[]>;

    /** The MCP servers Eesha Code adds to the session itself - its connectors server, when one is connected. */
    sentServers?: string[];

    /** Each connector and how it stands. Absent until the page has read them. */
    connectors?: SessionConnector[];

    /**
     * The instruction files the session's folders have (`.eesha/system.md`,
     * and `kiro.md`, which only a Kiro runtime gets). Absent until read.
     */
    instructionFiles?: { path: string; kiroOnly?: boolean }[];

    /** Opens the window that changes the session's folders. */
    onEditFolders?(): void;

    /** The settings page for connectors, and for runtimes (where tools are turned off). */
    connectorsHref?: string;
    runtimesHref?: string;
}

export interface SessionConnector {

    title: string;

    /** Connected: the person saved choices for it. */
    connected: boolean;

    /** Who its CLI is signed in as. */
    account?: string;

    /** The widest access any of its sources has. */
    access: "off" | "read" | "write";
}

/** One turn's charge, for the Usage section. */
export interface TurnSpend {

    /** 1-based. */
    number: number;

    /** The first line of what was asked, short. Empty for charges logged before the first message seen. */
    asked: string;

    cost: Spend[];

    models: ModelSpend[];

    /**
     * How many model calls the turn made, added up from its charge
     * lines. Absent when no line said - Kiro and plain ACP agents do not
     * report it, and a guess would be wrong.
     */
    calls?: number;
}

/** How long a turn's label may be before it is cut. */
const ASKED_MAX = 60;

/**
 * Each turn's charge: every charge line after a sent message belongs to
 * that message's turn, added up - a runtime that bills each model call
 * (Kiro) sends several in one turn. A turn that charged nothing has a
 * row with nothing in it; charges seen before any message (a resumed
 * session's) make a turn of their own with no label.
 */
export function turnSpends(entries: readonly LogEntry[]): TurnSpend[] {

    const turns: TurnSpend[] = [];

    for (const entry of entries) {

        if (entry.category === "prompt" && !entry.pending) {

            turns.push({ number: turns.length + 1, asked: askedText(entry.message), cost: [], models: [] });

            continue;
        }

        if (!entry.cost?.length && !entry.models?.length && !entry.calls)
            continue;

        if (!turns.length)
            turns.push({ number: 1, asked: "", cost: [], models: [] });

        const turn = turns[turns.length - 1];

        if (entry.cost?.length)
            turn.cost = addSpend(turn.cost, entry.cost);

        if (entry.models?.length)
            turn.models = addModelSpend(turn.models, entry.models);

        if (entry.calls)
            turn.calls = (turn.calls ?? 0) + entry.calls;
    }

    return turns;
}

/** `3 model calls` - nothing when the count is not known. */
export function callsText(calls: number | undefined): string | undefined {

    return calls ? `${calls} model ${calls === 1 ? "call" : "calls"}` : undefined;
}

/** The tokens a turn's (or the session's) models read and wrote, added up. */
export function tokensOf(models: readonly ModelSpend[]): { input: number; cached: number; output: number } {

    let input = 0;
    let cached = 0;
    let output = 0;

    for (const model of models) {

        input += model.inputTokens ?? 0;
        cached += model.cachedTokens ?? 0;
        output += model.outputTokens ?? 0;
    }

    return { input, cached, output };
}

/** The Usage section as a table - see {@link usageTable}. */
export interface UsageTableData {
    head: { key: string; text: string; title?: string }[];
    rows: { key: string; label: string; cells: { text: string }[]; kind?: "total" }[];
}

/**
 * The Usage section's table: a row per turn and a Total row, with
 * Calls, In, Cached, Out and Charge columns.
 *
 * Tokens always show, whatever the `sessionCost` flag says - the flag
 * only decides whether money joins them in the Charge column. A column
 * no row has a figure for is left out (Calls and Cached on Kiro, Charge
 * when nothing priced is shown), and a missing figure in a kept column
 * is a dash, never a zero.
 *
 * Exported for tests.
 */
export function usageTable(
    turns: readonly TurnSpend[],
    session: readonly Spend[],
    sessionModels: readonly ModelSpend[],
    showCost: boolean
): UsageTableData {

    const count = (value: number) => value > 0 ? tokenText(value) : "—";

    const lines = [
        ...turns.map(turn => ({
            key: String(turn.number),
            label: turn.asked ? `Turn ${turn.number} · ${turn.asked}` : `Turn ${turn.number}`,
            calls: turn.calls,
            tokens: tokensOf(turn.models),
            charge: shownSpend(turn.cost, showCost),
            kind: undefined as "total" | undefined
        })),
        {
            key: "total",
            label: "Total",
            calls: totalCalls(turns),
            tokens: tokensOf(sessionModels),
            charge: shownSpend(session, showCost),
            kind: "total" as const
        }
    ];

    const columns = [
        { key: "calls", text: "Calls", title: "Model calls - only Claude and Copilot say how many", has: lines.some(line => line.calls), cell: (line: typeof lines[number]) => line.calls ? String(line.calls) : "—" },
        { key: "in", text: "In", title: "Tokens read, cache included", has: true, cell: (line: typeof lines[number]) => count(line.tokens.input) },
        { key: "cached", text: "Cached", title: "The part of In read from the prompt cache - cheaper than fresh input", has: lines.some(line => line.tokens.cached), cell: (line: typeof lines[number]) => count(line.tokens.cached) },
        { key: "out", text: "Out", title: "Tokens written", has: true, cell: (line: typeof lines[number]) => count(line.tokens.output) },
        { key: "charge", text: showCost ? "Cost" : "Usage", has: lines.some(line => line.charge.length), cell: (line: typeof lines[number]) => line.charge.length ? spendsText(line.charge) : "—" }
    ].filter(column => column.has);

    return {
        head: [{ key: "turn", text: "" }, ...columns.map(({ key, text, title }) => ({ key, text, title }))],
        rows: lines.map(line => ({
            key: line.key,
            label: line.label,
            cells: columns.map(column => ({ text: column.cell(line) })),
            ...(line.kind ? { kind: line.kind } : {})
        }))
    };
}

/**
 * The session's model calls, only when every turn that used something
 * said its count: a session that switched to Kiro part way would
 * otherwise show a total smaller than the truth.
 */
function totalCalls(turns: readonly TurnSpend[]): number | undefined {

    const used = turns.filter(turn => turn.cost.length || turn.models.length || turn.calls);

    return used.length && used.every(turn => turn.calls)
        ? used.reduce((sum, turn) => sum + (turn.calls ?? 0), 0)
        : undefined;
}

function askedText(message: string): string {

    const line = (message ?? "").split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "";

    return line.length > ASKED_MAX ? `${line.slice(0, ASKED_MAX - 1)}…` : line;
}

/** How many calls of each tool the session made, most used first. */
export function toolCounts(entries: readonly LogEntry[]): { name: string; calls: number }[] {

    const counts = new Map<string, number>();

    for (const entry of entries)
        if (entry.category === "tool.start" && entry.tool)
            counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);

    return [...counts.entries()]
        .map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/** The newest MCP list a runtime reported in this session - a state, so the last one wins. */
export function latestMcp(entries: readonly LogEntry[]): McpServerState[] | undefined {

    for (let index = entries.length - 1; index >= 0; index--)
        if (entries[index].mcp)
            return entries[index].mcp;

    return undefined;
}

export interface SessionPanelProps {

    entries: readonly LogEntry[];

    /** The runtime and model the compose box shows. */
    runtime?: string;
    model?: string;

    /** The runtime's Permissions level, when it has one. */
    level?: PermissionLevel;

    context?: ContextUsage;

    /** The whole session's charge - see `usageFrom`. */
    session: readonly Spend[];
    sessionModels: readonly ModelSpend[];

    accounts: readonly AccountUsage[];

    /** The `sessionCost` flag: money shows only when it is on. */
    showCost: boolean;

    /** Compact, for a session that can - see the context popup in ChatView. */
    onCompact?(): void;
    running: boolean;

    extras: SessionExtras;
}

/** One section: a heading that opens and closes it, and a short summary beside it while it is closed. */
function Section({ title, summary, children, open = true }: { title: string; summary?: string; children: React.ReactNode; open?: boolean }) {

    return (
        <details className="session-panel__section" open={open}>
            <summary className="session-panel__head">
                <span className="session-panel__title">{title}</span>
                {summary ? <span className="session-panel__summary">{summary}</span> : null}
            </summary>
            <div className="session-panel__body">{children}</div>
        </details>
    );
}

function Empty({ children }: { children: React.ReactNode }) {

    return <p className="session-panel__empty">{children}</p>;
}

/** A coloured dot with a word for it - not colour alone. */
function Dot({ tone, label }: { tone: "good" | "bad" | "off"; label: string }) {

    return <span className={`session-panel__dot session-panel__dot--${tone}`} role="img" aria-label={label} title={label} />;
}

/** The MCP status word in plain English. */
function mcpWord(server: McpServerState): string {

    if (server.status === "failed")
        return server.needsSignIn ? "needs sign-in" : "failed";

    return { connected: "connected", connecting: "connecting", disabled: "turned off" }[server.status] ?? server.status;
}

export default function SessionPanel(props: SessionPanelProps) {

    const { entries, runtime, model, level, context, session, sessionModels, accounts, showCost, onCompact, running, extras } = props;

    const turns = turnSpends(entries);

    /** One charge as this reader may see it: the money or allowance, else the tokens. */
    const spent = (cost: readonly Spend[], models: readonly ModelSpend[]): string => {

        const shown = shownSpend(cost, showCost);

        return shown.length ? spendsText(shown) : modelFlow(models) ?? "—";
    };

    const sessionTotal = spent(session, sessionModels);

    const usage = usageTable(turns, session, sessionModels, showCost);

    const started = entries.find(entry => entry.category === "prompt" && !entry.pending)?.at;

    const tools = toolCounts(entries);
    const off = runtime ? extras.toolsOff?.[runtime] ?? [] : [];

    const reported = latestMcp(entries);
    const sent = extras.sentServers ?? [];

    const shownAccounts = accounts.filter(account => account.rows.some(row => showCost || !row.money));

    // kiro.md goes only to a Kiro runtime - the same rule as instructions.ts.
    const kiro = (runtime ?? "").toLowerCase().startsWith("kiro");
    const steering = extras.instructionFiles?.filter(file => kiro || !file.kiroOnly).map(file => file.path);

    const folderName = (folder: string) => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;

    return (
        <div className="session-panel">

            <Section title="Runtime" summary={runtime ? runtimeLabel(runtime) : undefined}>
                <UsageRow label="Runtime" value={runtime ? runtimeLabel(runtime) : "—"} />
                <UsageRow label="Model" value={model || "—"} />
                {level ? <UsageRow label="Permissions" value={LEVEL_NAMES[level]} /> : null}
                <UsageRow label="Turns" value={String(turns.filter(turn => turn.asked).length)} />
                {started ? <UsageRow label="Started" value={new Date(started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} muted /> : null}
            </Section>

            <Section title="Context" summary={context ? `${Math.round(context.percentOnly ? context.used : context.size > 0 ? (context.used / context.size) * 100 : 0)}%` : undefined}>
                {context
                    ? (
                        <>
                            <ContextWindowMeter {...contextSegments(context)} />
                            {onCompact && context.compactable
                                ? (
                                    <div className="session-panel__actions">
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={running || !compactReady(context)}
                                            title={running
                                                ? "Wait for the turn to finish"
                                                : !compactReady(context)
                                                    ? `Available once the context is over ${COMPACT_FROM_PERCENT}% full. On a short conversation the summary can be bigger than the conversation itself.`
                                                    : "Summarise the conversation so far and carry on from the summary. Uses a model call, so it costs credits."}
                                            onClick={onCompact}>
                                            Compact
                                        </Button>
                                    </div>
                                )
                                : null}
                        </>
                    )
                    : <Empty>The runtime has not said how full the context is yet.</Empty>}
            </Section>

            <Section title="Usage" summary={turns.length ? sessionTotal : undefined}>
                {turns.length
                    ? (
                        <div className="session-panel__usage">
                            <UsageTable head={[usage.head]} rows={usage.rows} />
                        </div>
                    )
                    : <Empty>Nothing used yet.</Empty>}
            </Section>

            {shownAccounts.map(account => (
                <Section key={account.runtime ?? ""} title={shownAccounts.length > 1 && account.runtime ? `Account · ${runtimeLabel(account.runtime)}` : "Account"}>
                    <div className="session-panel__rows">
                        {account.rows
                            .filter(row => showCost || !row.money)
                            .map(row => <UsageRow key={row.key} label={row.key} value={row.value} />)}
                        {Number.isFinite(account.at)
                            ? <UsageRow label="As of" value={new Date(account.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} muted />
                            : null}
                    </div>
                </Section>
            ))}

            <Section title="Folders" summary={String(extras.folders.length)}>
                {extras.folders.length
                    ? (
                        <ul className="session-panel__list">
                            {extras.folders.map((folder, index) => (
                                <li key={folder} title={folder}>
                                    <span className="session-panel__name">{folderName(folder)}</span>
                                    <span className="session-panel__note">{index === 0 ? "working folder" : "added"}</span>
                                </li>
                            ))}
                        </ul>
                    )
                    : <Empty>No folder. The agent works in this session's own scratch folder.</Empty>}
                {extras.onEditFolders
                    ? <div className="session-panel__actions"><Button type="button" size="sm" fill="outline" onClick={extras.onEditFolders}>Change folders</Button></div>
                    : null}
            </Section>

            <Section title="Tools" summary={tools.length ? `${tools.reduce((sum, tool) => sum + tool.calls, 0)} calls` : undefined}>
                {tools.length
                    ? (
                        <ul className="session-panel__list">
                            {tools.map(tool => (
                                <li key={tool.name}>
                                    <span className="session-panel__name">{tool.name}</span>
                                    <span className="session-panel__note">{tool.calls} {tool.calls === 1 ? "call" : "calls"}</span>
                                </li>
                            ))}
                        </ul>
                    )
                    : <Empty>No tool calls yet.</Empty>}
                {off.length
                    ? <p className="session-panel__line">Turned off: {off.join(", ")}</p>
                    : null}
                {extras.runtimesHref
                    ? <p className="session-panel__line"><a href={extras.runtimesHref}>Turn tools off in Settings › Runtimes</a></p>
                    : null}
            </Section>

            <Section title="MCP servers" summary={reported?.length ? `${reported.filter(server => server.status === "connected").length} of ${reported.length} connected` : undefined}>
                {reported?.length
                    ? (
                        <ul className="session-panel__list">
                            {reported.map(server => (
                                <li key={server.name} title={server.reason}>
                                    <Dot tone={server.status === "connected" ? "good" : server.status === "failed" ? "bad" : "off"} label={mcpWord(server)} />
                                    <span className="session-panel__name">{server.name}</span>
                                    <span className="session-panel__note">
                                        {mcpWord(server)}
                                        {server.tools !== undefined ? ` · ${server.tools} ${server.tools === 1 ? "tool" : "tools"}` : ""}
                                    </span>
                                    {server.reason ? <span className="session-panel__reason">{server.reason}</span> : null}
                                </li>
                            ))}
                        </ul>
                    )
                    : sent.length
                        ? (
                            <>
                                <ul className="session-panel__list">
                                    {sent.map(name => (
                                        <li key={name}>
                                            <span className="session-panel__name">{name}</span>
                                            <span className="session-panel__note">sent by Eesha Code</span>
                                        </li>
                                    ))}
                                </ul>
                                <p className="session-panel__line">{runtime ? runtimeLabel(runtime) : "This runtime"} does not say whether its MCP servers connected.</p>
                            </>
                        )
                        : <Empty>{runtime ? runtimeLabel(runtime) : "This runtime"} has not reported any MCP server.</Empty>}
            </Section>

            <Section title="Connectors" summary={extras.connectors ? `${extras.connectors.filter(one => one.connected).length} of ${extras.connectors.length}` : undefined}>
                {extras.connectors
                    ? (
                        <ul className="session-panel__list">
                            {extras.connectors.map(connector => (
                                <li key={connector.title}>
                                    <Dot tone={connector.connected ? "good" : "off"} label={connector.connected ? "connected" : "not connected"} />
                                    <span className="session-panel__name">{connector.title}</span>
                                    <span className="session-panel__note">
                                        {connector.connected
                                            ? `${connector.access === "write" ? "read + write" : connector.access === "read" ? "read" : "nothing on"}${connector.account ? ` · ${connector.account}` : ""}`
                                            : "not connected"}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )
                    : <Empty>Reading…</Empty>}
                {extras.connectorsHref
                    ? <p className="session-panel__line"><a href={extras.connectorsHref}>Manage connectors</a></p>
                    : null}
            </Section>

            <Section title="Steering" summary={steering ? String(steering.length) : undefined}>
                {steering
                    ? steering.length
                        ? (
                            <ul className="session-panel__list">
                                {steering.map(file => (
                                    <li key={file} title={file}>
                                        <span className="session-panel__name">{folderName(file)}</span>
                                        <span className="session-panel__note">{file.replace(/[\\/][^\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0] ?? ""}</span>
                                    </li>
                                ))}
                            </ul>
                        )
                        : <Empty>No instruction files. Put a system.md in a folder's .eesha folder to give every session in it standing instructions.</Empty>
                    : <Empty>Reading…</Empty>}
            </Section>
        </div>
    );
}
