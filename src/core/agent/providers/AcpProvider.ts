import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Readable, Writable } from "stream";
import { StringDecoder } from "string_decoder";
import { pathToFileURL } from "url";
import { logger } from "../../logging/logger";
import { SecretMasker } from "../../runner/SecretMasker";

import { AgentProvider, ModelChoice, ModeList, ProviderDeps } from "../AgentProvider";
import { homeDirectory } from "../../runner/runContext";
import { AskPermission, ContextUsage, ModelSpend, Spend, addSpend } from "../../models/run";
import { AcpExtension, AcpExtensionReader, AcpExtensionSession, AcpLocalMcpServer, AcpSessionSetup, extensionsFor } from "./acpExtensions";
import { ENGINE_FEATURES } from "./acpNotes";
import { lastAccount, rememberAccount } from "../accountCache";
import { commandsFrom, keepCommandList, offeredCommands, refusedCommandText } from "../commandListFile";
import { planFromAcp, planText } from "../plan";
import {
    AcpApprovalOutcome, AcpPermissionOption, AcpPermissionToolCall, acpPermission
} from "./acpApproval";
import { EnvService } from "../../env/envService";
import { loadEngineSettings } from "../../settings/engineSettings";
import { appName } from "../../loader/profilePaths";
import { resolveAcpAgent, sessionEnvRuntime } from "./acpConfig";
import { McpResolution, resolveMcpServers, withHostServers } from "./mcpConfig";
import { AcpMcpServer, runnableCommand, toAcpMcpServers } from "./mcpServers";
import { redactSecret } from "./redactSecrets";
import { createJail, engineDirectories, openJail, pathsIn } from "./pathJail";
import type { PathJail } from "./pathJail";
import { acpCall, askCard, gatePermission, UNANSWERED_NOTE, UNANSWERED_TEXT } from "../permissions";
import type { PermissionGate } from "../permissions";
import { LINE_LIMIT, VALUE_LIMIT, asText, clip, describeArguments, toolTitle } from "./describe";
import { ELICITATION_CAPABILITIES, AcpElicitationRequest, AcpElicitationResponse, askElicitation } from "./acpElicitation";
import {
    AgentAttachment,
    AgentEvent,
    AgentMessage,
    AgentSession,
    AgentSessionConfig,
    AgentSessionStatus,
    AskDesk,
    allowedNotice,
    AskHook,
    AskRequest,
    DELTA_INTERVAL_MS,
    DeltaChannel,
    PendingAsk
} from "../AgentSession";

/**
 * Any agent that speaks the Agent Client Protocol, as an
 * {@link AgentProvider}.
 * https://agentclientprotocol.com
 *
 * One file for every ACP agent rather than one per vendor. Which binary
 * runs is `ai.acpAgents.<id>` in settings.json (`{ command, args?, env?
 * }`); this provider is registered once per configured id by
 * `coreProviders`'s fallback (see `AgentProviders.registerFallback`),
 * and spawns that command instead of importing a vendor SDK.
 *
 * Covers only what this build's SDD flow needs:
 *
 *   1. **The agent's response** - `session/prompt` plus the
 *      `agent_message_chunk` / `agent_thought_chunk` updates it streams,
 *      buffered per turn and flushed as one `message` / `reasoning`
 *      event when the turn stops, so a task log gets whole lines, not
 *      word fragments. The buffer is also published as it fills, as an
 *      ephemeral `delta`, so a panel can paint the answer while it is
 *      written - see `AcpEventTranslator.painting`.
 *   2. **Permissions** - `session/request_permission`, answered the same
 *      way `onPermissionRequest` answers it in `CopilotProvider`: approve
 *      once, unattended, so a tool call never hangs a headless task.
 *   3. **Questions** - `elicitation/create`, answered by asking the
 *      person, exactly as `ClaudeProvider` answers `AskUserQuestion`:
 *      one `ask` event per form field, settled by `respond`. See
 *      {@link askElicitation} for what it declines rather than guesses
 *      at, and note the capability is advertised only when
 *      `config.interactive` says somebody is watching.
 *
 *      Not every question arrives that way. An agent that cannot
 *      proceed may just end its turn with the question in its message
 *      and no file written - Claude's ACP wrapper does this: the model
 *      asks clarifying questions in prose rather than calling
 *      `elicitation/create`. Turning that into
 *      "waiting on you" would be a provider-agnostic change to
 *      `aiV1/index.ts`, not something this file should special-case.
 *
 * **MCP servers** declared under `ai.mcpServers` are forwarded on
 * `session/new`, same as `ghcp`/`claude` - resolved and env-gated the
 * same way (`resolveMcpServers`), but reshaped: ACP's `mcpServers` is an
 * array of self-naming objects, not an object keyed by name, and `env`/
 * `headers` are `{ name, value }` pairs rather than a plain object - see
 * {@link AcpMcpServer}. A server whose transport (`http`/`sse`) the
 * agent did not advertise in its own `initialize` response is left out
 * and logged, rather than sent and left to fail inside the agent;
 * `stdio` is assumed baseline, since ACP's own capability flags never
 * name it. A task's per-server tool allowlist (`mcp.tools`) has no ACP
 * equivalent at `session/new`, so it is silently dropped here rather
 * than logged - see `forwardableMcpServers`'s own doc for why.
 *
 * **The model** - ACP has two ways for an agent to list its models,
 * and both are read (see {@link modelList}):
 *
 *   - Session config options: `session/new` answers with
 *     `configOptions`, and the select whose `category` is `model` lists
 *     them. Set with `session/set_config_option`. Claude's wrapper.
 *   - The `models` field (`availableModels`, `currentModelId`), set
 *     with `session/set_model`. Kiro CLI.
 *
 * A `model:` other than `auto` is set right after the session opens -
 * only when the agent offers it, and said in the log either way, so
 * "which model did it run on" is never a guess. {@link AcpProvider.models}
 * reads the same list for the picker. An agent that lists no models
 * picks its own, and `model:` is logged as ignored.
 *
 * **Resume** - `session/load`, when the agent says `loadSession: true`
 * on `initialize`. See {@link loadSession}. An agent without it starts
 * fresh and says why, which `ai@1` turns into a refusal.
 *
 * **Vendor extras** - a vendor's own notifications, its data inside
 * standard updates, and its own requests after a turn are handled by the
 * extensions in `acpExtensions.ts`. Which ones a runtime gets is its
 * `ai.acpAgents.<id>.extensions` - nothing here checks which agent is
 * running.
 *
 * Session list/fork/delete are out of scope: nothing in the SDD
 * flow uses them.
 * `session/request_permission` and `elicitation/create` are the only
 * client-side requests this file answers; `fs/*` and `terminal/*`
 * capabilities are left undeclared because Claude (via
 * `claude-agent-acp`) does its own file and shell I/O as ordinary tool
 * calls rather than asking the client to do it. An unhandled client request is the SDK's to reject, not this
 * file's to guess at.
 */
export class AcpProvider implements AgentProvider {

    constructor(
        private readonly agentId: string,
        private readonly deps: ProviderDeps = {}
    ) { }

    /**
     * The models this agent offers, off a throwaway session's
     * `session/new` response (see {@link modelList}) - the protocol's
     * only way to ask. One agent
     * start per call, which is why this is only reached from a surface
     * offering a choice and cached there, never from a run.
     *
     * Fails quietly, like the other two: no command on PATH, an agent
     * that lists no models, a changed protocol - all mean "no
     * list", and the picker then offers `auto` alone.
     */
    public async models(): Promise<ModelChoice[] | undefined> {

        const listed = await this.listing();

        const list = listed && modelList(listed.response);

        if (!list)
            return undefined;

        return modelChoices(list).map(choice => {

            const multiplier = listed.extensions
                .map(extension => extension.modelMultiplier?.(choice))
                .find(rate => rate !== undefined);

            const price = listed.extensions
                .map(extension => extension.modelPrice?.(choice))
                .find(text => text !== undefined);

            const efforts = listed.efforts?.[choice.value];

            return {
                id: choice.value,
                name: choice.name,
                ...(multiplier !== undefined ? { multiplier } : {}),
                ...(price ? { price } : {}),
                ...(efforts?.length ? { efforts } : {})
            };
        });
    }

    /**
     * The agent's modes, off the same throwaway session as {@link models}
     * - the session config option whose `category` is `mode` (Kiro v3).
     * Undefined when it lists none.
     */
    public async modes(): Promise<ModeList | undefined> {

        const listed = await this.listing();

        const option = modeOption(listed?.response.configOptions);

        if (!option)
            return undefined;

        // Modes that run tools without asking are never offered - see
        // `AcpExtension.modeGuard`.
        const guard = modeGuardOf(listed!.extensions);
        const hidden = new Set(guard?.hidden ?? []);
        const current = typeof option.currentValue === "string" && !hidden.has(option.currentValue)
            ? option.currentValue
            : guard?.fallback;

        return {
            ...(current !== undefined ? { current } : {}),
            modes: choicesOf(option).filter(choice => !hidden.has(choice.value)).map(choice => ({
                id: choice.value,
                name: choice.name,
                ...(choice.description ? { description: choice.description } : {})
            }))
        };
    }

    /**
     * One throwaway session's `session/new` response, shared by
     * {@link models} and {@link modes} while it is in flight, so asking
     * for both starts the agent once. Not kept after it lands: each
     * surface caches its own answer.
     */
    private listingInFlight?: Promise<AcpListing | undefined>;

    private listing(): Promise<AcpListing | undefined> {

        if (!this.listingInFlight) {

            const fetching = this.openListing();

            this.listingInFlight = fetching;

            const clear = () => { if (this.listingInFlight === fetching) this.listingInFlight = undefined; };

            fetching.then(clear, clear);
        }

        return this.listingInFlight;
    }

    private async openListing(): Promise<AcpListing | undefined> {

        const settings = await loadEngineSettings(this.deps.workspaceFolder?.());

        const declared = settings.ai.acpAgents[this.agentId];

        if (!declared)
            return undefined;

        const envs = new EnvService({ allowed: settings.env.allowed, denied: settings.env.denied });
        const agent = resolveAcpAgent(this.agentId, declared, envs);
        // No run to mask for, but the raw log still must not print them.
        const masker = new SecretMasker();
        const env = envs.spawnEnvMasked(value => registerRawSecret(masker, value));

        Object.assign(env, agent.env);

        for (const value of Object.values(agent.env))
            registerRawSecret(masker, value);

        const acp = await loadSdk();

        // The home directory when no working folder is set - see the same
        // choice in CopilotProvider.models. Listing reads no tree either way.
        const cwd = this.deps.workspaceFolder?.() ?? homeDirectory();

        const child = spawnAgent(agent.command, agent.args, cwd, env);

        const stream: AcpStream = acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

        logRawAcp(child, this.agentId, masker);

        try {

            // No request handlers: nothing is prompted, so nothing asks
            // for permission or raises a question.
            const connection = acp.client({ name: appName() }).connect(stream);

            child.once("exit", (code, signal) => connection.close(
                new Error(`'${agent.command}' exited (code ${code ?? "null"}, signal ${signal ?? "null"}).`)));

            await connection.agent.request(INITIALIZE, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

            // A cold start can answer before the model list is in - see
            // `awaitConfigOptions`. Waited for, so the picker is not left
            // with Auto alone.
            const opened = await awaitConfigOptions(
                await connection.agent.buildSession(cwd).start(),
                response => modelList(response) !== undefined,
                CONFIG_OPTIONS_WAIT_MS);

            const response = opened.newSessionResponse;

            // Each model's effort levels, when the agent has an effort
            // option - see `effortsByModel`. Nothing is prompted.
            const efforts = await effortsByModel(connection.agent, opened.sessionId, response);

            opened.dispose();

            // Quietly: a listing has no log to name an unknown id in.
            return { response, extensions: extensionsFor(agent.extensions), ...(efforts ? { efforts } : {}) };

        } finally {

            child.kill();
        }
    }

    public async createSession(config: AgentSessionConfig): Promise<AgentSession> {

        // Read fresh per session, before anything is spawned - same
        // reasoning as CopilotProvider and ClaudeProvider: the file can
        // change while the provider lives.
        const settings = await loadEngineSettings(this.deps.workspaceFolder?.());

        const declared = settings.ai.acpAgents[this.agentId];

        if (!declared)
            throw new Error(
                `No 'ai.acpAgents.${this.agentId}' is declared in settings.json. `
                + "Add { \"command\": ..., \"args\": [...] } under ai.acpAgents to use this provider.");

        const envs = new EnvService({
            allowed: settings.env.allowed,
            denied: settings.env.denied,
            taskEnv: config.env,
            allowedEnv: config.allowedEnv
        });

        const agent = resolveAcpAgent(this.agentId, declared, envs);

        // The spawn baseline (PATH, granted names, task env - see
        // EnvService.spawnEnv) plus this agent's own declared env last,
        // so `ai.acpAgents.<id>.env` can override a granted name the
        // same way a task's own env does. Every value is registered
        // with the masker before the child exists - the run's, and the
        // raw log's own (see `logRawAcp`).
        const rawMasker = new SecretMasker();

        const registerSecret = (value: string) => {

            registerRawSecret(rawMasker, value);
            config.registerSecret?.(value);
        };

        const env = envs.spawnEnvMasked(registerSecret);

        Object.assign(env, agent.env);

        for (const value of Object.values(agent.env))
            registerSecret(value);

        // What the program adds itself, last so the agent's own entry
        // cannot undo it - see `ProviderDeps.sessionEnv`. Throws when a
        // session on this runtime may not start yet.
        Object.assign(env, this.deps.sessionEnv?.(sessionEnvRuntime(this.agentId, agent.extensions)) ?? {});

        const mcp =resolveMcpServers(withHostServers(settings.ai.mcpServers, this.deps.mcpServers?.(this.agentId)), envs, config.mcp);

        // An MCP server's env and header values can be written straight
        // into settings.json, not granted, so the run's masker never
        // sees them. The raw log masks them anyway.
        for (const value of mcpSecretValues(mcp))
            registerRawSecret(rawMasker, value);

        const acp = await loadSdk();

        const cwd = config.workingDirectory;

        // The runtime's own extensions - see `acpExtensions.ts`. Read
        // before the program starts: one may add to its arguments.
        const extensions = extensionsFor(agent.extensions, config.log);

        // The standing instructions and the tools to take away - see
        // `AcpSessionSetup`.
        const setup: AcpSessionSetup = {
            instructions: config.systemInstructions?.trim() ?? "",
            toolsOff: [...this.deps.toolsOff?.(this.agentId) ?? []]
        };

        const launchArgs = extensions.flatMap(extension => extension.launchArgs?.(setup) ?? []);

        // A runtime that takes local tool servers only when it starts
        // gets them in a file now - see `AcpExtension.startMcpServers`.
        // In front of `launchArgs`: Copilot's `--excluded-tools` takes
        // every argument after it.
        const startServers = mcp ? await startMcpFile(extensions, localMcpServers(mcp, env.PATH)) : undefined;

        const child = spawnAgent(agent.command, [...agent.args, ...startServers?.args ?? [], ...launchArgs], cwd, env, config.log);

        // The file may hold a server's `env` values, so it goes as soon
        // as the program has read it: when the session exists (below),
        // or when the program stops before that.
        const removeStartFile = (): void => {

            if (startServers)
                void fs.rm(startServers.folder, { recursive: true, force: true }).catch(() => undefined);
        };

        child.once("exit", removeStartFile);

        // The same boundary the other two providers hold, from the same
        // two sources: where the task said to run, and the chat's other
        // folders. `debug` opens it - a profile-only setting,
        // which the loader makes an error in a workspace file, so the
        // switch cannot arrive with a repository.
        const engine = engineDirectories(this.deps.resources?.());

        const jail = settings.debug
            ? openJail(config.workingDirectory, this.deps.directories?.(), engine)
            : createJail(config.workingDirectory, this.deps.directories?.(), undefined, engine);

        if (settings.debug)
            config.log?.(
                "debug: true in your profile settings - this session may read and write anywhere,"
                + ` not only ${jail.roots.join(", ")}.`,
                "system");

        const stream: AcpStream = acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

        logRawAcp(child, this.agentId, rawMasker);

        try {

            // The elicitation handler needs a session to raise a
            // question on, and the session cannot exist until the
            // connection this handler is being registered on is up - so
            // it reaches the session through a variable assigned at the
            // end of this block. Nothing calls it before the first
            // turn, and there is no first turn before the session
            // exists.
            let session: AcpAgentSession | undefined;

            // Nobody watching means nobody to answer - the same gate
            // `ClaudeProvider` puts in front of `AskUserQuestion`, and
            // the reason the capability below is advertised only when
            // this is on.
            const ask: AskHook | undefined = config.interactive === true
                ? request => {

                    if (!session)
                        throw new Error("The ACP agent asked a question before the session was built.");

                    return session.ask(request);
                }
                : undefined;

            // Our own permission check, when the host hands one in.
            const gate = this.deps.permissions?.(this.agentId, config.workingDirectory, config.chat);

            const clientApp = acp.client({ name: appName() })
                .onRequest(REQUEST_PERMISSION, async ctx => {

                    // "Always" answers are never offered or picked. After
                    // one the agent stops asking about calls like it, and a
                    // call it does not ask about never reaches the folder
                    // check below - Copilot CLI's "Always allow" on one
                    // write covers every later write in the session, and
                    // claude-agent-acp's saves a rule to the repo's
                    // `.claude/settings.local.json`, or switches the
                    // session to Bypass permissions when a plan is
                    // accepted.
                    const options = ctx.params.options.filter(one => one.kind !== "allow_always");

                    // The request with what its own tool call said - see
                    // `withCallInput` - or as the runtime's extension
                    // rewrites it (Copilot CLI's path request). Everything
                    // below, the folder check first, reads this one.
                    const requested = ctx.params.toolCall as AcpPermissionToolCall | undefined;

                    const merged = session
                        ? await session.withCallInput(requested)
                        : requested;

                    const earlier = session?.knownCall(requested?.toolCallId);

                    const toolCall = extensions
                        .map(extension => extension.permissionToolCall?.(requested, earlier))
                        .find(found => found !== undefined) ?? merged;

                    // A tool the host's settings took away, on a runtime
                    // that cannot take it away itself (Kiro v3): refused,
                    // in every mode, before anything else is asked.
                    const off = turnedOffTool(toolCall, extensions, setup.toolsOff);

                    if (off) {

                        const note = `refused: ${off} is turned off for this runtime in Eesha Code's settings`;
                        const shown = acpPermission(toolCall);

                        config.log?.(`Denied ${toolCall?.title ?? off}: ${note}.`, "system");

                        session?.allowedWithoutAsking(
                            gatePermission(shown.tool, shown.input, { note, refused: true }), ctx.params, requested?.toolCallId);

                        const refusal = options.find(one => one.kind === "reject_once")
                            ?? options.find(one => one.kind.startsWith("reject"));

                        return refusal
                            ? { outcome: { outcome: "selected" as const, optionId: refusal.optionId } }
                            : { outcome: { outcome: "cancelled" as const } };
                    }

                    // A file this session was told not to write - a Kiro
                    // spec phase reaching for the next phase's document.
                    // Refused in every mode, before anything is asked.
                    const kept = toolCall?.kind === "read" || toolCall?.kind === "search"
                        ? undefined
                        : refusedWrite(toolCall, config.refuseWrites ?? [], config.workingDirectory);

                    if (kept) {

                        const note = `refused: ${kept} belongs to another phase of this spec - this phase writes only its own document`;
                        const shown = acpPermission(toolCall);

                        config.log?.(`Denied ${toolCall?.title ?? "write"}: ${note}.`, "system");

                        session?.allowedWithoutAsking(
                            gatePermission(shown.tool, shown.input, { note, refused: true }), ctx.params, requested?.toolCallId);

                        const refusal = options.find(one => one.kind === "reject_once")
                            ?? options.find(one => one.kind.startsWith("reject"));

                        return refusal
                            ? { outcome: { outcome: "selected" as const, optionId: refusal.optionId } }
                            : { outcome: { outcome: "cancelled" as const } };
                    }

                    // Outside the session's own directories, the answer
                    // is no - see {@link createJail}. ACP names the
                    // files a call touches in `toolCall.locations`, and
                    // an agent that fills in `rawInput` names them
                    // again there, so both are scanned.
                    //
                    // A refusal has to be one of the options the agent
                    // offered; there is no way to send a reason back on
                    // this request. When it offers no rejecting option
                    // at all, `cancelled` is the outcome that stops the
                    // call - answering `allow_once` because nothing
                    // better was on the list is how a boundary gets
                    // lost.

                    // The protocol names the kind of call - `read`,
                    // `edit`, `execute` and the rest - so the engine's
                    // read-only directories can be offered to the ones
                    // that only look. Anything else, including a kind
                    // this build has not seen, counts as a write.
                    const reads = toolCall?.kind === "read"
                        || toolCall?.kind === "search";

                    // A request the runtime's extension answers itself (Kiro
                    // v3's end-of-turn review of the files it changed) - its
                    // files held to the same boundary, as writes.
                    const answer = extensions
                        .map(extension => extension.permissionAnswer?.(ctx.params))
                        .find(found => found !== undefined);

                    // Our own check: it answers every request the agent
                    // sends.
                    if (gate)
                        return gatedAcpAnswer({
                            gate, jail, toolCall, requested, options, answer, params: ctx.params,
                            session, ask: session && config.interactive === true ? request => session!.askCard(request) : undefined,
                            log: config.log
                        });

                    const escape = jail.escape(toolCall, undefined, !reads)
                        ?? (answer?.paths.length
                            ? jail.escape({ locations: answer.paths.map(one => ({ path: one })) }, undefined, true)
                            : undefined);

                    if (escape) {

                        const refusal = options.find(one => one.kind === "reject_once")
                            ?? options.find(one => one.kind.startsWith("reject"));

                        config.log?.(
                            `Denied ${toolCall?.title ?? "(untitled)"}: `
                            + `${escape.asked} is outside ${jail.roots.join(", ")}`,
                            "system");

                        return refusal
                            ? { outcome: { outcome: "selected" as const, optionId: refusal.optionId } }
                            : { outcome: { outcome: "cancelled" as const } };
                    }

                    if (answer && options.some(one => one.optionId === answer.optionId)) {

                        config.log?.(answer.line, "system");

                        return { outcome: { outcome: "selected" as const, optionId: answer.optionId } };
                    }

                    // No check of our own: the call is allowed once.
                    const chosen = options.find(one => one.kind === "allow_once")
                        ?? options.find(one => one.kind.startsWith("allow"))
                        ?? options[0];

                    // Only "always" was offered, and that is never picked.
                    if (!chosen) {

                        config.log?.(
                            `Denied ${toolCall?.title ?? "(untitled)"}: the agent offered only an "always" answer, `
                            + "which would stop it asking about later calls.",
                            "system");

                        return { outcome: { outcome: "cancelled" as const } };
                    }

                    // Said in the thread, with what was asked, so a call
                    // that ran without a card can still be seen. Before
                    // the session exists there is only the log.
                    if (session)
                        session.allowedWithoutAsking(acpPermission(toolCall), ctx.params, requested?.toolCallId);
                    else
                        config.log?.(
                            `Permission requested: ${toolCall?.title ?? "(untitled)"} `
                            + `- answering '${chosen.kind}'`,
                            "system");

                    return { outcome: { outcome: "selected" as const, optionId: chosen.optionId } };
                })
                .onRequest(ELICITATION_CREATE, async request => {

                    // Every outcome is an action the agent must handle,
                    // never a thrown error: see `askElicitation`. It
                    // declines by itself when nobody is watching, when
                    // the mode is one this build must not render, and
                    // when an answer will not fit the declared field.
                    const answered = await askElicitation(request.params, ask, request.signal);

                    if (answered.action !== "accept")
                        config.log?.(
                            `Elicitation '${clip(asText(request.params.message), VALUE_LIMIT)}' `
                            + `- ${answered.action}`,
                            "system");

                    return answered;
                });

            // The runtime's own extensions' notifications - see
            // `acpExtensions.ts`. Params pass through unparsed: they are
            // the vendor's, and each reader copes with a shape it does
            // not know.
            // One that arrives before the session exists is held and
            // handed over once it does - Kiro v3 reports its MCP servers
            // straight after `session/new`, before it answers.
            const early: [AcpExtensionReader, unknown][] = [];

            for (const extension of extensions)
                for (const [method, read] of Object.entries(extension.notifications ?? {}))
                    clientApp.onNotification(method, raw => raw, ({ params }) => {

                        if (session)
                            session.receive(read, params);
                        else
                            early.push([read, params]);
                    });

            const connection = clientApp.connect(stream);

            child.once("exit", (code, signal) => connection.close(
                new Error(`'${agent.command}' exited (code ${code ?? "null"}, signal ${signal ?? "null"}).`)));

            const ctx = connection.agent;

            // Advertised only when a person is watching. Leaving a
            // capability out is how ACP says "do not send me these",
            // and claiming form support on an unattended run would put
            // the agent in front of a question it can only ever
            // decline.
            //
            // The extensions' own `_meta` goes with it - how a vendor's
            // extras are asked for (Copilot CLI's event feed).
            const clientMeta = Object.assign({}, ...extensions.map(extension => extension.clientMeta ?? {})) as Record<string, unknown>;

            const clientCapabilities = {
                ...(ask ? { elicitation: ELICITATION_CAPABILITIES } : {}),
                ...(Object.keys(clientMeta).length ? { _meta: clientMeta } : {})
            };

            const init = await ctx.request(INITIALIZE, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities
            });

            // `env.PATH` - the same one the agent's own child process
            // just got - not `process.env.PATH`: resolving an MCP
            // server's command against a PATH the agent will not
            // actually run under would be answering the wrong question.
            // Less the local ones the program was started with.
            const servers = (mcp ? forwardableMcpServers(mcp, init.agentCapabilities, config.log, env.PATH) : [])
                .filter(server => !(startServers && server.type === "stdio"));

            // Every other folder of the session - see `extraFolders`.
            const extra = extraFolders(cwd, this.deps.directories?.() ?? []);

            // Everything decided about this session in one block, full
            // server details included - "what did we actually ask for"
            // should not need a second run with more logging.
            config.log?.(
                `ACP agent '${this.agentId}' session:\n${describeAcpSession(init, cwd, servers, clientCapabilities, extra)}`,
                "system");

            // Where the instructions and the turned-off tools go for this
            // agent - see `sessionSetupRequest`.
            const { systemPrompt, meta, instructionsGo } = sessionSetupRequest(setup, init.agentCapabilities, extensions);

            if (setup.instructions)
                config.log?.(
                    instructionsGo === "systemPrompt"
                        ? `Standing instructions (${setup.instructions.length} characters) sent as the session's system prompt, added to the agent's own.`
                        : instructionsGo === "meta"
                            ? `Standing instructions (${setup.instructions.length} characters) sent with the session.`
                            : `Standing instructions (${setup.instructions.length} characters) go in front of the first message - this runtime has no system prompt over ACP.`,
                    "system");

            let builder = meta || systemPrompt
                ? ctx.buildSession({ cwd, mcpServers: [], ...(systemPrompt ? { systemPrompt } : {}), ...(meta ? { _meta: meta } : {}) })
                : ctx.buildSession(cwd);

            if (extra.length)
                builder = builder.withAdditionalDirectories(extra);

            for (const server of servers)
                builder = builder.withMcpServer(server);

            // A resume goes through `session/load` when the agent offers
            // it. When it does not, or the load fails, a fresh session
            // starts and the reason is said plainly, before the session
            // exists, so a caller failing the run over it (`ai@1` does)
            // can say why in its own words.
            let resumeFailure: string | undefined;
            let loaded: AcpActiveSession | undefined;

            if (config.resume) {

                if (!offersLoad(init.agentCapabilities))
                    resumeFailure = "this ACP agent cannot resume a conversation - it does not offer session/load";

                else
                    try {

                        loaded = await loadSession(ctx, config.resume, cwd, servers, extra, meta, systemPrompt);

                        config.log?.(`Resumed conversation ${config.resume} with session/load.`, "system");

                    } catch (error) {

                        resumeFailure = `the agent could not reopen conversation ${config.resume}: `
                            + (error instanceof Error ? error.message : String(error));
                    }

                if (resumeFailure)
                    config.log?.(`${resumeFailure}, so this starts a new one.`, "system");
            }

            // What this session will set, waited for when the agent's
            // answer left it out - see `awaitConfigOptions`. A model or
            // mode that was asked for, and the extension's permission
            // switch (Kiro v3's Autopilot, which must be turned off for
            // the folder boundary to see any call).
            const wantsModel = config.model !== undefined && config.model.trim() !== "" && config.model.trim() !== "auto";
            const guard = modeGuardOf(extensions);
            const wantsMode = (config.agentMode !== undefined && config.agentMode.trim() !== "") || guard !== undefined;
            const switchId = extensions.map(extension => extension.permissionOption?.id).find(Boolean);

            const activeSession = await awaitConfigOptions(
                loaded ?? await builder.start(),
                response => (!wantsModel || modelList(response) !== undefined)
                    && (!wantsMode || modeOption(response.configOptions) !== undefined)
                    && (!switchId || (response.configOptions ?? []).some(option => option.id === switchId)),
                CONFIG_OPTIONS_WAIT_MS);

            removeStartFile();

            // The model, once the session exists to set it on. A wrong
            // id fails here, before the first prompt, naming what the
            // agent does offer. Set again on a loaded session too: the
            // model an old conversation ran on is not necessarily the
            // one asked for now.
            const model = await applyModel(ctx, activeSession, config.model, config.log);

            // The mode picked in the compose box, then whether the agent
            // asks before it uses a tool. Both set again on a loaded
            // session, like the model.
            const agentMode = await applyAgentMode(ctx, activeSession, config.agentMode, config.log, undefined, guard);
            const effort = await applyEffort(ctx, activeSession, config.effort, config.log);
            await applyPermissionOption(
                ctx, activeSession, extensions, config.log);

            session = new AcpAgentSession(
                child, connection, ctx, activeSession, config.signal, resumeFailure,
                config.resume ? loaded !== undefined : undefined, extensions, this.agentId,
                undefined);

            session.agentMode = agentMode;
            session.effort = effort;

            // A reopened conversation has them already, in its first message.
            if (instructionsGo === "preface" && !loaded)
                session.preface = prefaceOf(setup.instructions);
            session.takesImages = takesImages(init.agentCapabilities);
            session.runsOn(model);
            session.noteForExtensions(ENGINE_FEATURES, settings.features);

            for (const [read, params] of early.splice(0))
                session.receive(read, params);

            return session;

        } catch (error) {

            // A session that never came into being has nobody to stop
            // the child process later.
            child.kill();

            throw error;
        }
    }
}

/**
 * Everything decided about one session, as text - the `initialize`
 * result and the `session/new` about to be sent, in one block. Never
 * throws: a log line is not worth failing a session over.
 *
 * Exported for tests.
 */
export function describeAcpSession(
    init: { protocolVersion: number; agentCapabilities?: unknown },
    cwd: string,
    servers: AcpMcpServer[],
    clientCapabilities: Record<string, unknown> = {},
    additionalDirectories: string[] = []
): string {

    try {

        return JSON.stringify({
            protocolVersion: init.protocolVersion,

            // Ours as well as theirs: an unattended run advertises no
            // elicitation support, which is why an agent on it never
            // asks anything.
            clientCapabilities,
            agentCapabilities: init.agentCapabilities ?? {},
            cwd,
            ...(additionalDirectories.length ? { additionalDirectories } : {}),
            mcpServers: servers

        // Never print a secret - see `redactSecrets`.
        }, (key, value) => redactSecret(key, value) ?? value, 2);

    } catch (error) {

        return `<could not be printed: ${error instanceof Error ? error.message : String(error)}>`;
    }
}

/** ACP method names this file uses, spelled once. */
const REQUEST_PERMISSION = "session/request_permission";
const ELICITATION_CREATE = "elicitation/create";
const INITIALIZE = "initialize";
const SET_CONFIG_OPTION = "session/set_config_option";
const SET_MODEL = "session/set_model";
const SESSION_LOAD = "session/load";
const SESSION_CANCEL = "session/cancel";

/** The event name for a message the running turn did not take - see `AcpExtension.steer`. */
const STEER = "steer";

/**
 * A `tool.start` with the runtime's own tool name added, when one of its
 * extensions can read it off the `tool_call` (Claude's `_meta`, Kiro v3's
 * known titles) - see `AcpExtension.toolName`. Unchanged otherwise.
 *
 * Exported for tests.
 */
export function withToolName(
    event: Extract<AgentEvent, { kind: "tool.start" }>,
    toolCall: AcpPermissionToolCall | undefined,
    extensions: readonly AcpExtension[]
): AgentEvent {

    const toolName = extensions.map(extension => extension.toolName?.(toolCall)).find(Boolean);

    return toolName ? { ...event, toolName } : event;
}

/**
 * The tool a permission request is for, when the host turned it off -
 * see `ProviderDeps.toolsOff`. Named by the runtime's extension when it
 * can tell (Kiro v3), else by the request's title. Case is ignored.
 *
 * Exported for tests.
 */
export function turnedOffTool(
    toolCall: AcpPermissionToolCall | undefined,
    extensions: readonly AcpExtension[],
    toolsOff: readonly string[]
): string | undefined {

    if (!toolsOff.length)
        return undefined;

    const names = [
        ...extensions.map(extension => extension.toolName?.(toolCall)),
        toolCall?.title?.trim()
    ].filter((one): one is string => typeof one === "string" && one.length > 0).map(one => one.toLowerCase());

    return toolsOff.find(off => names.includes(off.toLowerCase()));
}

/**
 * The first path a permission request names that is one of `refuse` -
 * see `AgentSessionConfig.refuseWrites`. Read from the call's
 * `locations` and its input, the same places the folder check reads.
 * Case is ignored on Windows, where the disk ignores it.
 *
 * Exported for tests.
 */
export function refusedWrite(
    toolCall: AcpPermissionToolCall | undefined,
    refuse: readonly string[],
    workingDirectory: string | undefined,
    isWindows: boolean = process.platform === "win32"
): string | undefined {

    if (!refuse.length || !toolCall)
        return undefined;

    const key = (one: string) => {

        const resolved = path.resolve(workingDirectory ?? ".", one);

        return isWindows ? resolved.toLowerCase() : resolved;
    };

    const refused = new Set(refuse.map(key));

    return pathsIn(toolCall).find(one => refused.has(key(one)));
}

/** The first thing in {@link prefaceOf}'s text. */
const PREFACE_OPEN = "<system-instructions>";

/**
 * The title an agent gave the conversation, or nothing for one made from
 * the start of {@link prefaceOf}'s text. Copilot CLI and Kiro v3 name a
 * conversation after the start of its first message, and on a runtime
 * with no system prompt over ACP that start is the standing
 * instructions, not what the person typed. With no title from the
 * agent, the chat keeps its own: the person's first message.
 *
 * Exported for tests.
 */
export function agentTitle(title: unknown): string {

    const given = typeof title === "string" ? title.trim() : "";

    return given.startsWith(PREFACE_OPEN) ? "" : given;
}

/**
 * The standing instructions in front of a session's first message, for
 * a runtime with no system prompt over ACP. Said to hold for the whole
 * conversation, a compact included, since there is no other channel.
 *
 * Exported for tests.
 */
export function prefaceOf(instructions: string): string {

    return `${PREFACE_OPEN}\n`
        + "Follow these instructions for this whole conversation, as if they were your system prompt."
        + " Keep them after the conversation is compacted or summarized.\n\n"
        + instructions
        + "\n</system-instructions>";
}

/**
 * ACP's own system prompt, as `session/new` and `session/load` take it.
 * `append` adds the text to the agent's own instructions and is the one
 * mode every agent that offers a system prompt must take.
 */
export interface AcpSystemPrompt {

    mode: "append";

    content: { type: "text"; text: string }[];
}

/**
 * Whether the agent said on `initialize` that it takes a system prompt
 * from the client (`sessionCapabilities.systemPrompt`, an object - empty
 * is enough). ACP forbids sending one to an agent that did not say so.
 *
 * Exported for tests.
 */
export function offersSystemPrompt(agentCapabilities: unknown): boolean {

    const offered = (agentCapabilities as { sessionCapabilities?: { systemPrompt?: unknown } | null } | undefined)
        ?.sessionCapabilities?.systemPrompt;

    return typeof offered === "object" && offered !== null && !Array.isArray(offered);
}

/**
 * The standing instructions as ACP's `systemPrompt`: one text block,
 * added to the agent's own instructions.
 *
 * Exported for tests.
 */
export function systemPromptOf(instructions: string): AcpSystemPrompt {

    return { mode: "append", content: [{ type: "text", text: instructions }] };
}

/**
 * How one session's standing instructions and turned-off tools are sent,
 * given what the agent said on `initialize`:
 *
 * 1. `systemPrompt` - the agent takes ACP's own. Its extensions are asked
 *    for the tools alone, so the instructions are not sent twice.
 * 2. `meta` - an extension sends them the vendor's way.
 * 3. `preface` - neither: they go in front of the first message.
 *
 * `instructionsGo` is `none` when there are no instructions.
 *
 * Exported for tests.
 */
export function sessionSetupRequest(
    setup: AcpSessionSetup,
    agentCapabilities: unknown,
    extensions: readonly AcpExtension[]
): { systemPrompt?: AcpSystemPrompt; meta?: Record<string, unknown>; instructionsGo: "systemPrompt" | "meta" | "preface" | "none" } {

    const systemPrompt = setup.instructions && offersSystemPrompt(agentCapabilities)
        ? systemPromptOf(setup.instructions)
        : undefined;

    const metaSetup: AcpSessionSetup = systemPrompt ? { ...setup, instructions: "" } : setup;
    const merged = Object.assign({}, ...extensions.map(extension => extension.sessionMeta?.(metaSetup) ?? {})) as Record<string, unknown>;

    return {
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(Object.keys(merged).length ? { meta: merged } : {}),
        instructionsGo: !setup.instructions
            ? "none"
            : systemPrompt
                ? "systemPrompt"
                : extensions.some(extension => extension.sessionMeta) ? "meta" : "preface"
    };
}

/** Whether the agent said `loadSession: true` on `initialize` - ACP's only promise that `session/load` works. */
export function offersLoad(agentCapabilities: unknown): boolean {

    return (agentCapabilities as { loadSession?: unknown } | undefined)?.loadSession === true;
}

/**
 * Reopens an earlier conversation with `session/load`, and follows it
 * the way `builder.start()` follows a new one.
 *
 * The SDK has a builder for `session/new` only. What it does after
 * `session/new` answers - route that session id's updates into a queue
 * and wrap it - is `ClientContext.attachSession`, which its types mark
 * private but its JavaScript exposes. This calls it with the load's
 * response. If a later SDK drops it, this fails before anything is
 * sent, so the agent never loads a session nobody is listening to.
 *
 * The agent replays the whole conversation as `session/update`s before
 * it answers the load. Nothing is attached yet at that point, so the
 * SDK drops them - on purpose: the log already has that conversation,
 * and printing it again would read as new work.
 *
 * Exported for tests.
 */
export async function loadSession(
    ctx: AcpAgentContext,
    sessionId: string,
    cwd: string,
    mcpServers: AcpMcpServer[],
    additionalDirectories: string[] = [],

    /** The extensions' `_meta` - see `AcpExtension.sessionMeta`. */
    meta?: Record<string, unknown>,

    /**
     * Sent again on every load: ACP leaves it to the agent what happens
     * to the prompt when a load names none.
     */
    systemPrompt?: AcpSystemPrompt
): Promise<AcpActiveSession> {

    const attach = ctx.attachSession;

    if (typeof attach !== "function")
        throw new Error("this build's ACP library cannot follow a loaded session");

    const response = await ctx.request(SESSION_LOAD, {
        sessionId,
        cwd,
        ...(additionalDirectories.length ? { additionalDirectories } : {}),
        mcpServers,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(meta ? { _meta: meta } : {})
    });

    return attach.call(ctx, { ...(response ?? {}), sessionId });
}

/**
 * The session's local tool servers - the ones the runtime starts itself
 * as a program - in ACP's own shape.
 *
 * Exported for tests.
 *
 * @param pathEnv The PATH the agent's own process runs under - see
 *                `forwardableMcpServers`.
 */
export function localMcpServers(
    mcp: McpResolution,
    pathEnv: string = process.env.PATH ?? "",
    isWindows: boolean = process.platform === "win32"
): AcpLocalMcpServer[] {

    return toAcpMcpServers(mcp.servers, isWindows, pathEnv).filter((server): server is AcpLocalMcpServer => server.type === "stdio");
}

/**
 * Writes the file a runtime reads its local tool servers from when it
 * starts, and says the arguments that name it - see
 * `AcpExtension.startMcpServers`. Nothing for a runtime that takes them
 * at `session/new`, or with no local server.
 *
 * The file is in a new folder of its own under the system temp folder,
 * readable by this user only: a server's `env` values are in it. The
 * caller removes the folder when the program stops.
 *
 * Exported for tests.
 */
export async function startMcpFile(
    extensions: readonly AcpExtension[],
    servers: readonly AcpLocalMcpServer[]
): Promise<{ folder: string; args: string[] } | undefined> {

    const extension = extensions.find(one => one.startMcpServers);

    if (!extension?.startMcpServers || !servers.length)
        return undefined;

    const start = extension.startMcpServers(servers);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), `${appName().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-mcp-`));
    const file = path.join(folder, "mcp-config.json");

    await fs.writeFile(file, start.text, { encoding: "utf8", mode: 0o600 });

    return { folder, args: [...start.args(file)] };
}

/**
 * The resolved MCP servers this agent actually advertised support for,
 * converted to ACP's own shape - and a log line for every one left out,
 * naming why, rather than a session that silently has fewer tools than
 * `ai.mcpServers` promised.
 *
 * `stdio` is never filtered: ACP's `mcpCapabilities` names `http`, `sse`
 * and the experimental `acp` transport, never `stdio` - it is the
 * protocol's own baseline, assumed rather than negotiated.
 *
 * A per-server tool allowlist has no ACP equivalent at `session/new`,
 * so it is silently dropped rather than logged - see {@link AcpProvider}'s
 * own class doc for the same gap stated once.
 *
 * Exported for tests - `pathEnv`/`isWindows` are injectable so a
 * platform difference can be tested from either platform.
 *
 * @param pathEnv The PATH the *agent's* child process runs under - see
 *                `resolveMcpServerCommand` - not necessarily this
 *                process's own.
 */
export function forwardableMcpServers(
    mcp: McpResolution,
    agentCapabilities: unknown,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void,
    pathEnv: string = process.env.PATH ?? "",
    isWindows: boolean = process.platform === "win32"
): AcpMcpServer[] {

    const capabilities = agentCapabilities as { mcpCapabilities?: { http?: boolean; sse?: boolean } } | undefined;

    return toAcpMcpServers(mcp.servers, isWindows, pathEnv).filter(server => {

        if (server.type === "stdio")
            return true;

        const supported = server.type === "http"
            ? capabilities?.mcpCapabilities?.http === true
            : capabilities?.mcpCapabilities?.sse === true;

        if (!supported)
            log?.(
                `MCP server '${server.name}' declares type '${server.type}', which this agent did not `
                + "advertise support for on initialize - not forwarded.",
                "stderr");

        return supported;
    });
}

/**
 * The select that lists the agent's models, if it returned one - the
 * option whose `category` is `model`. Boolean options never qualify.
 */
export function modelOption(options: AcpConfigOption[] | null | undefined): AcpConfigOption | undefined {

    return (options ?? []).find(option => option.category === "model" && option.type === "select");
}

/** Every choice of a select option, flattened across groups. */
export function choicesOf(option: AcpConfigOption): AcpConfigChoice[] {

    const listed = option.options ?? [];

    return listed.flatMap(entry => "group" in entry ? entry.options : [entry]);
}

/**
 * Where an agent listed its models, and so how one is set.
 *
 * `config_option` is the protocol's session config options (set with
 * `session/set_config_option`); `set_model` is the `models` field (set
 * with `session/set_model`). An agent sending both is read through its
 * config option.
 */
export type AcpModelList =
    | { via: "config_option"; option: AcpConfigOption }
    | { via: "set_model"; state: AcpModelState };

/** The agent's model list off a `session/new` or `session/load` response, or nothing when it lists none. */
export function modelList(response: Partial<AcpSessionResponse> | undefined): AcpModelList | undefined {

    const option = modelOption(response?.configOptions);

    if (option)
        return { via: "config_option", option };

    const state = response?.models;

    if (state && Array.isArray(state.availableModels) && state.availableModels.length)
        return { via: "set_model", state };

    return undefined;
}

/** Every model on the list, in the config option's shape. A model with no name goes by its id. */
export function modelChoices(list: AcpModelList): AcpConfigChoice[] {

    return list.via === "config_option"
        ? choicesOf(list.option)
        : list.state.availableModels.map(model => ({ value: model.modelId, name: model.name || model.modelId }));
}

/**
 * Puts the session on the model the task asked for, when it asked for
 * one and the agent offers it.
 *
 * `auto` (or nothing) leaves the agent's own choice alone and only
 * logs it. A model the agent does not list is refused here, naming
 * what it does list - the alternative is a session that quietly runs
 * on something else. An agent that listed no models at all picks its
 * own; that is logged, not failed, since the person may not have asked
 * for anything the agent could honour.
 *
 * Returns the model the session runs on - the one set, or the agent's
 * own current one - or nothing when the agent lists no models.
 */
export async function applyModel(
    ctx: AcpAgentContext,
    session: AcpActiveSession,
    model: string | undefined,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): Promise<string | undefined> {

    const list = modelList(session.newSessionResponse);
    const wanted = model?.trim();
    const asked = wanted !== undefined && wanted !== "" && wanted !== "auto";

    if (!list) {

        log?.(
            asked
                ? `Model: this agent offers no model option, so 'model: ${wanted}' is ignored - it picks its own.`
                : "Model: the agent's own choice (it offers no model option).",
            "system");

        return undefined;
    }

    const choices = modelChoices(list);
    const nameOf = (value: unknown): string =>
        choices.find(choice => choice.value === value)?.name ?? String(value);

    if (!asked) {

        const current = list.via === "config_option" ? list.option.currentValue : list.state.currentModelId;

        log?.(`Model: ${nameOf(current)} (the agent's own choice).`, "system");

        return typeof current === "string" && current ? current : undefined;
    }

    if (!choices.some(choice => choice.value === wanted))
        throw new Error(
            `This agent does not offer model '${wanted}'. It offers: `
            + `${choices.map(choice => choice.value).join(", ") || "(nothing)"}.`);

    if (list.via === "config_option")
        await ctx.request(SET_CONFIG_OPTION, { sessionId: session.sessionId, configId: list.option.id, value: wanted });

    else
        await ctx.request(SET_MODEL, { sessionId: session.sessionId, modelId: wanted });

    log?.(`Model: ${nameOf(wanted)} (set on the session).`, "system");

    return wanted;
}

/**
 * The session, once its config options hold what this caller needs.
 *
 * Kiro v3 can open a session before it has its model list: on a cold
 * start the `session/new` answer carries no model option, and the list
 * comes a moment later as a `config_option_update`. Read only off the
 * answer, a picked model would be "not offered" and silently dropped -
 * and the turn would run on Auto, at twice the credits.
 *
 * So when `ready` says something is missing, the session's updates are
 * read here until a `config_option_update` makes it ready, or `waitMs`
 * passes. Every update read while waiting is kept and handed back first
 * by the returned session's `nextUpdate`, so the session's own reading
 * misses nothing. Ready at once, the session comes back as it was.
 *
 * Exported for tests.
 */
export async function awaitConfigOptions(
    active: AcpActiveSession,
    ready: (response: Partial<AcpSessionResponse>) => boolean,
    waitMs: number
): Promise<AcpActiveSession> {

    let response = active.newSessionResponse;

    if (ready(response))
        return active;

    const held: AcpSessionMessage[] = [];
    let pending: Promise<AcpSessionMessage> | undefined;
    let failure: { error: unknown } | undefined;

    const deadline = Date.now() + waitMs;

    while (!ready(response) && !failure) {

        const left = deadline - Date.now();

        if (left <= 0)
            break;

        pending ??= active.nextUpdate();

        let timer: ReturnType<typeof setTimeout> | undefined;

        // eslint-disable-next-line no-await-in-loop
        const next = await Promise.race([
            pending.then(message => ({ message }), (error: unknown) => ({ error })),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), left); })
        ]);

        clearTimeout(timer);

        // Out of time with a read still waiting: it is handed on below,
        // never dropped, so the session's reading picks it up.
        if (!next)
            break;

        pending = undefined;

        if ("error" in next) {

            failure = next;
            break;
        }

        held.push(next.message);

        const update = next.message.kind === "session_update" ? next.message.update : undefined;

        if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions))
            response = { ...response, configOptions: update.configOptions };
    }

    return {
        sessionId: active.sessionId,
        newSessionResponse: response,
        prompt: prompt => active.prompt(prompt),
        nextUpdate: () => {

            if (held.length)
                return Promise.resolve(held.shift()!);

            if (failure) {

                const { error } = failure;

                failure = undefined;

                return Promise.reject(error);
            }

            if (pending) {

                const waiting = pending;

                pending = undefined;

                return waiting;
            }

            return active.nextUpdate();
        },
        dispose: () => active.dispose()
    };
}

/** How long a session waits for config options its `session/new` answer left out - see {@link awaitConfigOptions}. */
const CONFIG_OPTIONS_WAIT_MS = 10_000;

/**
 * The select that lists the agent's modes, if it returned one - the
 * option whose `category` is `mode` (Kiro v3: Default, Spec, Plan...).
 * The `modes` field is not read: the mode picker is for agents that
 * list modes this way.
 */
export function modeOption(options: AcpConfigOption[] | null | undefined): AcpConfigOption | undefined {

    return (options ?? []).find(option => option.category === "mode" && option.type === "select");
}

/** What one throwaway listing session learned - see `AcpProvider.listing`. */
interface AcpListing {

    response: Partial<AcpSessionResponse>;

    extensions: AcpExtension[];

    /** Each model's effort levels, by model id - see {@link effortsByModel}. */
    efforts?: Record<string, string[]>;
}

/**
 * The select that sets how hard the model thinks - the option whose
 * `category` is `thought_level` (claude-agent-acp's `effort`).
 */
export function effortOption(options: AcpConfigOption[] | null | undefined): AcpConfigOption | undefined {

    return (options ?? []).find(option => option.category === "thought_level" && option.type === "select");
}

/** The effort option's own "no level" value - left out of the picker, which offers it as Default. */
const EFFORT_DEFAULT = "default";

/**
 * Each model's effort levels. claude-agent-acp lists the effort option
 * for the model in use only, with that model's levels, so the listing
 * session is put on each model in turn and the option read off the
 * answer (`session/set_config_option` answers with every option). No
 * prompt is sent, so nothing is charged. Undefined when the agent has no
 * effort option or no model option. A model that fails to set is left
 * without levels.
 *
 * Exported for tests.
 */
export async function effortsByModel(
    ctx: Pick<AcpAgentContext, "request">,
    sessionId: string,
    response: Partial<AcpSessionResponse>
): Promise<Record<string, string[]> | undefined> {

    const models = modelOption(response.configOptions);

    if (!models || !effortOption(response.configOptions))
        return undefined;

    const levels = (options: AcpConfigOption[] | undefined) => {

        const option = effortOption(options);

        return option ? choicesOf(option).map(choice => choice.value).filter(value => value !== EFFORT_DEFAULT) : [];
    };

    const found: Record<string, string[]> = {};

    for (const choice of choicesOf(models)) {

        try {

            // eslint-disable-next-line no-await-in-loop
            const answer = await withTimeout(
                ctx.request(SET_CONFIG_OPTION, { sessionId, configId: models.id, value: choice.value }) as Promise<{ configOptions?: AcpConfigOption[] }>,
                EFFORT_PROBE_TIMEOUT_MS);

            const own = levels(answer?.configOptions);

            if (own.length)
                found[choice.value] = own;

        } catch {

            // Left without levels: no picker for this model.
        }
    }

    return found;
}

/** How long one model switch may take while the listing reads effort levels. */
const EFFORT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Sets how hard the model thinks, with `session/set_config_option` on the
 * agent's effort option. Nothing picked leaves the agent's default. Not a
 * failure when the agent refuses - the model in use may take no level, or
 * not this one: the reason is logged and the session runs at its default.
 *
 * @returns the level set, or undefined when none was.
 */
export async function applyEffort(
    ctx: AcpAgentContext,
    session: { sessionId: string; newSessionResponse: Partial<AcpSessionResponse> },
    effort: string | undefined,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): Promise<string | undefined> {

    const wanted = effort?.trim();

    if (!wanted)
        return undefined;

    const option = effortOption(session.newSessionResponse.configOptions);

    try {

        await ctx.request(SET_CONFIG_OPTION, { sessionId: session.sessionId, configId: option?.id ?? "effort", value: wanted });

    } catch (error) {

        log?.(
            `Effort: '${wanted}' was not set - ${error instanceof Error ? error.message : String(error)}. `
            + "The model runs at its default.",
            "system");

        return undefined;
    }

    log?.(`Effort: ${wanted === EFFORT_DEFAULT ? "the model's default" : wanted} (set on the session).`, "system");

    return wanted;
}

/** The first mode guard a runtime's extensions name - see `AcpExtension.modeGuard`. */
export function modeGuardOf(extensions: readonly AcpExtension[]): { hidden: readonly string[]; fallback: string } | undefined {

    return extensions.map(extension => extension.modeGuard).find(Boolean);
}

/**
 * The slash command a message starts with, when the runtime's extensions
 * refuse it - see `AcpExtension.blockedCommands`. `/allow-all on` gives
 * `allow-all`.
 *
 * Exported for tests.
 */
export function blockedCommandIn(prompt: string, extensions: readonly AcpExtension[]): string | undefined {

    const name = /^\s*\/([^\s/]+)/.exec(prompt)?.[1]?.toLowerCase();

    return name && extensions.some(extension => extension.blockedCommands?.includes(name)) ? name : undefined;
}

/**
 * Puts the session in the mode picked in the compose box, with
 * `session/set_config_option`. Nothing picked leaves the agent's own
 * default, and only logs it.
 *
 * A mode the agent does not list is refused, naming what it does list -
 * the same rule as a model, so a turn never runs in a mode nobody picked.
 *
 * A mode the runtime's extension holds back (see `AcpExtension.modeGuard`)
 * is refused when asked for, and when the agent opened in one by itself,
 * the session is put in the guard's fallback instead.
 *
 * @param current the mode the session is in now, when the caller knows
 *                it better than `session/new` did (a held session that
 *                was switched since).
 * @returns the mode the session is in afterwards, when the agent has modes.
 */
export async function applyAgentMode(
    ctx: AcpAgentContext,
    session: { sessionId: string; newSessionResponse: Partial<AcpSessionResponse> },
    mode: string | undefined,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void,
    current?: string,
    guard?: { hidden: readonly string[]; fallback: string }
): Promise<string | undefined> {

    const option = modeOption(session.newSessionResponse.configOptions);
    let wanted = mode?.trim() || undefined;

    if (!option) {

        if (wanted)
            log?.(`Mode: this agent offers no modes, so '${wanted}' is ignored.`, "system");

        return undefined;
    }

    const choices = choicesOf(option);
    const nameOf = (value: unknown): string => choices.find(choice => choice.value === value)?.name ?? String(value);
    const now = current ?? (typeof option.currentValue === "string" ? option.currentValue : undefined);
    const hidden = new Set(guard?.hidden ?? []);

    // Not a failure: a saved pick of a held-back mode would otherwise
    // stop every session it opens.
    if (wanted && hidden.has(wanted)) {

        log?.(
            `Mode: ${nameOf(wanted)} is not offered - in it the agent runs tools without asking, `
            + `so the folder boundary would not see them. Using ${nameOf(guard!.fallback)}.`,
            "system");

        wanted = guard!.fallback;
    }

    else if (!wanted && now !== undefined && hidden.has(now)) {

        log?.(
            `Mode: the agent opened in ${nameOf(now)}, which runs tools without asking `
            + `- switching to ${nameOf(guard!.fallback)}.`,
            "system");

        wanted = guard!.fallback;
    }

    if (!wanted) {

        log?.(`Mode: ${nameOf(now)} (the agent's own default).`, "system");

        return now;
    }

    if (!choices.some(choice => choice.value === wanted))
        throw new Error(
            `This agent does not offer mode '${wanted}'. It offers: `
            + `${choices.map(choice => choice.value).join(", ") || "(nothing)"}.`);

    if (wanted !== now)
        await ctx.request(SET_CONFIG_OPTION, { sessionId: session.sessionId, configId: option.id, value: wanted });

    log?.(`Mode: ${nameOf(wanted)} (set on the session).`, "system");

    return wanted;
}

/**
 * One `session/request_permission` under our own check: the
 * same decision every provider gets, answered with the agent's own
 * options. ACP cannot carry a reason back, so a "no" is the agent's
 * "reject once"; "always" is never picked.
 */
export async function gatedAcpAnswer(input: {
    gate: PermissionGate;
    jail: PathJail;
    toolCall: AcpPermissionToolCall | undefined;
    requested: AcpPermissionToolCall | undefined;
    options: readonly AcpPermissionOption[];
    answer: { optionId: string; paths: string[]; line: string } | undefined;
    params: unknown;
    session: AcpAgentSession | undefined;
    ask: AskHook | undefined;
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void;
}): Promise<AcpApprovalOutcome> {

    const { gate, jail, toolCall, requested, options, answer, params, session, log } = input;

    const title = toolCall?.title ?? "(untitled)";

    const yes = (): AcpApprovalOutcome => {

        const chosen = options.find(one => one.kind === "allow_once") ?? options.find(one => one.kind === "allow");

        if (chosen)
            return { outcome: { outcome: "selected", optionId: chosen.optionId } };

        log?.(`Denied ${title}: the agent offered only an "always" answer, which would stop it asking about later calls.`, "system");

        return { outcome: { outcome: "cancelled" } };
    };

    const no = (): AcpApprovalOutcome => {

        const refusal = options.find(one => one.kind === "reject_once") ?? options.find(one => one.kind.startsWith("reject"));

        return refusal
            ? { outcome: { outcome: "selected", optionId: refusal.optionId } }
            : { outcome: { outcome: "cancelled" } };
    };

    // The runtime's extension answers this one itself (Kiro v3's review
    // of the files it changed). Its files are still held to the folders.
    if (answer && options.some(one => one.optionId === answer.optionId)) {

        const escape = answer.paths.length
            ? jail.escape({ locations: answer.paths.map(one => ({ path: one })) }, undefined, true)
            : undefined;

        if (escape) {

            log?.(`Denied ${title}: ${escape.asked} is outside ${jail.roots.join(", ")}`, "system");

            return no();
        }

        log?.(answer.line, "system");

        return { outcome: { outcome: "selected", optionId: answer.optionId } };
    }

    const call = acpCall(toolCall);
    const shown = acpPermission(toolCall);
    const decision = gate.decide(call, jail);

    const mark = (note: string, refused = false): void =>
        session?.allowedWithoutAsking(
            gatePermission(shown.tool, shown.input, { note, ...(refused ? { refused: true } : {}) }), params, requested?.toolCallId);

    if (decision.verdict === "allow") {

        if (decision.note)
            mark(decision.note);

        return yes();
    }

    if (decision.verdict === "deny") {

        log?.(`Denied ${title}: ${decision.note}`, "system");

        mark(decision.note, true);

        return no();
    }

    if (!input.ask) {

        if (decision.card.type === "outside") {

            log?.(`Denied ${title}: ${decision.card.shown} is outside the chat's folders, and nobody is watching to ask.`, "system");

            return no();
        }

        log?.("A permission card is due, but nobody is watching this session, so the request was allowed once.", "system");

        return yes();
    }

    const answered = await askCard(input.ask, gate, call, decision.card, shown.input);

    if (!answered) {

        log?.(`Permission request (${title}): ${UNANSWERED_TEXT}`, "system");

        mark(UNANSWERED_NOTE, true);

        return { outcome: { outcome: "cancelled" } };
    }

    log?.(`Permission request (${title}) answered: ${answered.note}`, "system");

    mark(answered.note, !answered.allow);

    return answered.allow ? yes() : no();
}

/**
 * Sets the agent's own "ask before using a tool" option to the value its
 * extension names - see `AcpExtension.permissionOption`. Does nothing
 * when no extension names one, or the agent did not offer it on this
 * session.
 *
 * @returns the line to log, or undefined when nothing was set.
 */
export async function applyPermissionOption(
    ctx: AcpAgentContext,
    session: { sessionId: string; newSessionResponse: Partial<AcpSessionResponse> },
    extensions: readonly AcpExtension[],
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): Promise<string | undefined> {

    const wanted = extensions.map(extension => extension.permissionOption).find(Boolean);

    if (!wanted)
        return undefined;

    const option = (session.newSessionResponse.configOptions ?? [])
        .find(one => one.id === wanted.id && one.type === "select");

    if (!option)
        return undefined;

    const value = wanted.value;

    await ctx.request(SET_CONFIG_OPTION, { sessionId: session.sessionId, configId: option.id, value });

    const choice = choicesOf(option).find(one => one.value === value);
    const line = `${option.name}: ${value}${choice ? ` (${choice.name})` : ""}.`;

    log?.(line, "system");

    return line;
}

/**
 * The session's folders other than `cwd`, each once, for
 * `additionalDirectories` on `session/new` and `session/load`.
 *
 * Kiro keeps a copy of every file before it edits it, filed under the
 * file's path inside one of the session's folders - `cwd` and these.
 * A file in none of them (a second folder of the chat)
 * gets its whole path, drive letter included, and Windows refuses the
 * folder. The edit then fails with ENOENT on every try.
 *
 * Sent whether or not the agent lists the capability: Kiro reads the
 * field but does not list it, and an agent that does not know it
 * ignores an optional field.
 *
 * Exported for tests.
 */
export function extraFolders(cwd: string, directories: readonly string[], isWindows: boolean = process.platform === "win32"): string[] {

    const key = (folder: string) => {

        const resolved = path.resolve(folder);

        return isWindows ? resolved.toLowerCase() : resolved;
    };

    const seen = new Set([key(cwd)]);
    const extra: string[] = [];

    for (const folder of directories) {

        if (!folder || !path.isAbsolute(folder) || seen.has(key(folder)))
            continue;

        seen.add(key(folder));
        extra.push(folder);
    }

    return extra;
}

function spawnAgent(
    declaredCommand: string,
    declaredArgs: string[],
    cwd: string,
    env: Record<string, string>,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): ChildProcessWithoutNullStreams {

    // Most `ai.acpAgents` commands are npm-installed CLIs - `kiro-cli`,
    // `claude-agent-acp`, `copilot` - and on Windows those resolve to a
    // `.cmd` shim, not a real executable. `CreateProcess` does not
    // consult `PATHEXT`, so `spawn("claude-agent-acp", ...)` fails with
    // ENOENT even though the same bare name works in any real shell.
    // Same fix `mcpServers.ts` applies to `command: npx`, applied here
    // for the same reason.
    const { command, args } = runnableCommand(declaredCommand, declaredArgs) ?? { command: declaredCommand, args: declaredArgs };

    // windowsHide: without it, Windows can open a terminal window for
    // the agent (or the `cmd` that wraps it) when the host has none.
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    child.on("error", error => {

        // The declared command, not the (possibly `cmd`-wrapped) one
        // actually spawned - an implementation detail nobody
        // configuring `ai.acpAgents` should have to know.
        log?.(
            `Could not start ACP agent '${declaredCommand}': ${error instanceof Error ? error.message : String(error)}. `
            + "Check ai.acpAgents in settings.json and that the command is on PATH.",
            "stderr");
    });

    forwardStderr(child, log);

    return child;
}

/**
 * Every line the agent writes on stdout - each ACP response,
 * notification and request it sends - copied to Eesha Code's own log
 * file as `[ACP_RAW] <agent>: <line>`. For finding out what the agent
 * actually said when the chat shows nothing.
 *
 * The log file, not the run log: a turn streams hundreds of chunks, and
 * the run log is what the chat shows.
 *
 * Each line is masked first, with `masker`'s values - see
 * {@link registerRawSecret} for what goes in it. A secret the agent
 * picked up on its own (its own config, a file a tool read) is not
 * known here and prints as sent.
 *
 * Call it after `Readable.toWeb(child.stdout)`, so the SDK's own reader
 * is attached first and misses nothing. A second `data` listener gets
 * the same chunks and does not take any away from it.
 *
 * Exported for tests.
 */
export function logRawAcp(child: ChildProcessWithoutNullStreams, agentId: string, masker: SecretMasker): void {

    const decoder = new StringDecoder("utf8");

    const write = (lines: string[]) => {

        for (const line of lines) {

            const trimmed = line.trim();

            if (trimmed)
                logger.info(`[ACP_RAW] ${agentId}: ${trimmed}`);
        }
    };

    // The masker splits into lines before masking, so a secret cut in
    // half by a chunk boundary is still matched whole.
    child.stdout.on("data", (chunk: Buffer) => write(masker.push(decoder.write(chunk), RAW_STREAM)));

    child.stdout.once("end", () => {

        write(masker.push(decoder.end(), RAW_STREAM));
        write(masker.flush(RAW_STREAM));
    });
}

/** The masker buffer `logRawAcp` uses. */
const RAW_STREAM = "acp-raw";

/**
 * A value for the raw log's masker, as written and as it appears inside
 * a JSON string. Every ACP line is JSON, so a secret with a quote or a
 * backslash in it arrives escaped and would not match as written.
 *
 * Exported for tests.
 */
export function registerRawSecret(masker: SecretMasker, value: string | undefined): void {

    if (!value)
        return;

    masker.register(value);
    masker.register(JSON.stringify(value).slice(1, -1));
}

/**
 * Every env and header value of the servers sent on `session/new`, in
 * either shape a server can be written in (`{ NAME: value }` or ACP's
 * `[{ name, value }]`).
 *
 * Exported for tests.
 */
export function mcpSecretValues(mcp: McpResolution | undefined): string[] {

    const values: string[] = [];

    for (const server of Object.values(mcp?.servers ?? {})) {

        if (!server || typeof server !== "object")
            continue;

        for (const key of ["env", "headers"]) {

            const held = (server as Record<string, unknown>)[key];

            const entries = Array.isArray(held)
                ? held.map(pair => (pair as { value?: unknown } | undefined)?.value)
                : held && typeof held === "object" ? Object.values(held) : [];

            for (const entry of entries)
                if (typeof entry === "string")
                    values.push(entry);
        }
    }

    return values;
}

/**
 * Chatter an ACP agent's own stderr is known to carry that names
 * nothing a person reading a task log can act on - Kiro CLI reports
 * a client capability it did not get
 * (`elicitation/create` forms) and an OAuth registration attempt
 * failing, both for state this engine never asked for. Matched on
 * substrings of the agent's own wording, not shortened, so a genuine
 * error sharing a keyword still gets through.
 *
 * The form-elicitation line is only half true, since an interactive
 * session does advertise form support. It is listed because an
 * unattended one does not (see the `initialize` call), and that is the
 * run where nobody is watching the log.
 */
const KNOWN_STDERR_NOISE = [
    /does(?:n'|no)t support form elicitation/i,
    /dynamic client registration.*not supported/i,

    // Kiro's v3 engine runs on Node and prints Node's own warning about
    // its SQLite module on every start - at ERROR level, about nothing
    // the engine or a person can act on - plus Node's hint below it.
    /ExperimentalWarning: SQLite is an experimental feature/i,
    /^\s*\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\s*$/
];

/** Exported for tests - matched against one already-trimmed stderr line. */
export function isKnownAcpNoise(line: string): boolean {

    return KNOWN_STDERR_NOISE.some(pattern => pattern.test(line));
}

/**
 * Kiro's v3 engine writes its ordinary log lines to stderr too, each
 * one starting with its level in brackets (`[INFO] ...`,
 * `[ERROR] ...`). An info, debug or trace line is not an error, so it
 * goes to the log as a normal line. Every other line - `[WARN]`,
 * `[ERROR]`, or no tag at all - stays an error.
 *
 * Exported for tests.
 */
export function acpStderrStream(line: string): "stderr" | "system" {

    return /^\s*\[(?:INFO|DEBUG|TRACE)\]/i.test(line) ? "system" : "stderr";
}

/** The agent's own stderr, line by line, into the task's log - the same channel a shell task's stderr reaches. */
function forwardStderr(
    child: ChildProcessWithoutNullStreams,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): void {

    if (!log)
        return;

    child.stderr.setEncoding("utf8");

    let buffered = "";

    child.stderr.on("data", (chunk: string) => {

        buffered += chunk;

        const lines = buffered.split("\n");

        buffered = lines.pop() ?? "";

        for (const line of lines)
            if (line.trim() && !isKnownAcpNoise(line))
                log(line, acpStderrStream(line));
    });
}

/**
 * One ACP conversation.
 *
 * Holds its own child process and connection - closing one ends the
 * agent and this session together, so two sessions never share a
 * process.
 *
 * A background pump drains `activeSession.nextUpdate()` for the whole
 * life of the session, independent of any one `send`/`sendAndWait`
 * call - `session/update` notifications can arrive between turns
 * (`available_commands_update`, `usage_update`) and the SDK's own queue
 * has to be drained regardless of whether anything is currently
 * awaiting a turn.
 *
 * Exported so tests can construct one directly, with fake ACP
 * dependencies - no SDK, no child process.
 */
export class AcpAgentSession implements AgentSession {

    public readonly id: string;

    /**
     * `true` when a resume was asked for and `session/load` reopened it,
     * `false` when it was asked for and could not be, `undefined` when
     * nothing was asked. See {@link AgentSession.resumed}.
     */
    public readonly resumed?: boolean;

    public readonly resumeFailure?: string;

    private state: AgentSessionStatus = "idle";

    private readonly handlers = new Set<(event: AgentEvent) => void>();

    private readonly translator = new AcpEventTranslator();

    /**
     * Questions waiting on a person, by id - each holding the promise
     * `askElicitation` is blocked on while the agent's own
     * `elicitation/create` request sits open on the connection. See
     * {@link AskDesk}.
     */
    private readonly asks = new AskDesk(event => this.publish(event));

    private disposed = false;

    /**
     * Called by the pump once it has published everything a turn's
     * `stop` brings - the stored answer, the bill, the stop reason, the
     * idle. Set by {@link stopRead} just before a prompt goes out.
     *
     * Needed because `prompt()` resolves at the same moment the SDK
     * queues that `stop`, not after the pump has read it. With updates
     * still queued ahead of it (the last chunks and the reply often come
     * in one read), `sendAndWait` would return first and `ai@1` would
     * dispose the session - the turn's stored answer would reach nobody.
     */
    private onStop?: () => void;

    /** What vendor extensions keep for this session - see `AcpExtensionTurn.note`. */
    private readonly notes = new Map<string, unknown>();

    /**
     * The session as vendor extensions see it: the translator's bill,
     * this session's notes, and a way to ask the agent something.
     */
    private readonly extensionView: AcpExtensionSession = {
        sessionId: "",
        charge: (spend, note, calls) => this.translator.charge(spend, note, calls),
        note: (key, value) => { this.notes.set(key, value); },
        noted: key => this.notes.get(key),
        request: (method, params) => this.ctx.request(method, params),
        prompt: text => this.answerTo(text)
    };

    constructor(
        private readonly child: ChildProcessWithoutNullStreams,
        private readonly connection: AcpConnection,
        private readonly ctx: AcpAgentContext,
        private readonly activeSession: AcpActiveSession,
        signal?: AbortSignal,

        /** Set only when a resume was actually asked for and could not be honoured. */
        resumeFailure?: string,

        /** Whether a resume that was asked for worked. Left out, a failure implies `false` and no failure implies nothing was asked. */
        resumed?: boolean,

        /** This runtime's vendor extensions - see `acpExtensions.ts`. None, left out. */
        private readonly extensions: readonly AcpExtension[] = [],

        /**
         * The runtime's id (`kiro-cli`) - what account usage is kept
         * under, see `accountCache.ts`. Left out, nothing is kept or
         * shown from the cache.
         */
        private readonly runtime?: string,

        /** Where account usage is kept - for tests; the real file is in the profile folder. */
        private readonly accounts: { remember: typeof rememberAccount; last: typeof lastAccount } =
            { remember: rememberAccount, last: lastAccount }
    ) {

        this.id = activeSession.sessionId;
        this.extensionView = { ...this.extensionView, sessionId: this.id };
        this.resumeFailure = resumeFailure;
        this.resumed = resumed ?? (resumeFailure !== undefined ? false : undefined);

        void this.pump();

        signal?.addEventListener("abort", () => void this.abort("the run was stopped"));
    }

    public get status(): AgentSessionStatus {

        return this.state;
    }

    public async send(message: AgentMessage): Promise<void> {

        const refused = this.refusedCommand(message);

        if (refused) {

            this.publishError(refused);
            this.publish({ name: PROMPT, raw: refused, kind: "idle" });

            return;
        }

        // A message sent while a turn runs: to that turn, on a runtime
        // whose extension can (Kiro v3). Nothing about the running turn is
        // reset - it is still the same turn.
        if (this.state === "working" && !message.attachments?.length) {

            const steering = this.extensions.find(extension => extension.steer);

            if (steering?.steer) {

                const result = await steering.steer(this.extensionView, message.prompt);

                if (!result.ok)
                    this.publish({ name: STEER, raw: result, kind: "notice", text: result.reason ?? "The agent did not take the message. Send it again." });

                return;
            }
        }

        this.state = "working";
        this.translator.reset();
        this.start();

        const stopped = this.stopRead();

        message = this.withPreface(message);

        // Fired, not awaited - `send` delivers and returns. The pump
        // loop still reads every update this turn produces; only the
        // resolution of the turn itself goes unawaited here. The
        // extensions' after-turn step runs once the pump has read the
        // turn's `stop`, so what it says comes after the turn's answer,
        // and the panel that called this is still listening then.
        this.prompt(message)
            .then(() => stopped)
            .then(() => this.afterTurn())
            .catch(error => {

                this.publishError(error);

                // The turn is over, failed. Said as idle too - the same
                // as `ClaudeProvider` does on a failed result - since a
                // failed turn sends no `stop` for the pump to report.
                // Without it the chat would show "working" forever after a
                // network drop, and the plan would never hear the wave end.
                if (this.disposed)
                    return;

                this.state = "idle";
                this.asks.abandon("The turn ended without an answer.");
                this.publish({ name: PROMPT, raw: error, kind: "idle" });
            });
    }

    /**
     * `session/prompt`'s own response resolves exactly when the turn is
     * truly finished - including any tool call it spawned - which is a
     * protocol-level guarantee this SDK honours (`claude-agent-acp` holds
     * the response until a long tool call completes). No drain-polling is needed here for that reason -
     * the timeout below is only a backstop against a session that never
     * settles at all.
     */
    public async sendAndWait(message: AgentMessage, timeoutMs: number | null = IDLE_TIMEOUT_MS): Promise<void> {

        const refused = this.refusedCommand(message);

        if (refused) {

            this.publishError(refused);

            throw refused;
        }

        this.state = "working";
        this.translator.reset();
        this.start();

        const stopped = this.stopRead();

        try {

            const turn = this.prompt(this.withPreface(message));

            // `null` is no backstop - see `AgentSession.sendAndWait`.
            await (timeoutMs === null ? turn : withTimeout(turn, timeoutMs));

            // The turn is over, but the pump may not have read its
            // `stop` yet - see `onStop`.
            await stopped;

            // Before this returns, not after: `ai@1` stops listening and
            // disposes the session the moment it is released, so an
            // event published later would reach nobody. The same reason
            // `ClaudeProvider` waits for its context report here.
            await this.afterTurn();

        } catch (error) {

            // Published as well as thrown. The caller gets the failure
            // either way, but a surface watching the conversation only
            // ever sees events - without this, a `sendAndWait` failure
            // would leave a chat that simply stopped.
            this.publishError(error);

            throw error;

        } finally {

            this.state = "idle";

            // A question still open here is not a real one: the
            // protocol's own guarantee is that `session/prompt` does not
            // resolve while a tool call it spawned is still running, and
            // an elicitation is exactly that. Closed here rather than
            // left to lock the next turn's box forever over a question
            // nobody is still asking.
            this.asks.abandon("The turn ended without an answer.");
        }
    }

    /**
     * Tells the agent to stop the turn, and says so in the log with
     * `reason`. The agent marks every tool still running as "cancelled
     * by the user" - but it does the same when it aborts on its own, so
     * without this line the log cannot tell the two apart.
     */
    public async abort(reason: string = "Stop was pressed"): Promise<void> {

        // Before the notify, not after: the agent is about to be told
        // the turn is over, and a question still sitting open on the
        // connection is one nothing will ever answer.
        this.asks.abandon("The turn was stopped before the question was answered.");

        this.publish({ name: SESSION_CANCEL, raw: { reason }, kind: "notice", text: `Sent session/cancel: ${reason}.` });

        await this.ctx.notify(SESSION_CANCEL, { sessionId: this.id }).catch(() => undefined);
    }

    public async dispose(): Promise<void> {

        if (this.disposed)
            return;

        this.disposed = true;
        this.state = "ended";
        this.handlers.clear();

        // The pump stops reading, so no `stop` is coming.
        this.onStop?.();

        this.asks.abandon("The session ended before the question was answered.");

        this.activeSession.dispose();
        this.connection.close();
        this.child.kill();
    }

    public on(handler: (event: AgentEvent) => void): () => void {

        this.handlers.add(handler);

        return () => this.handlers.delete(handler);
    }

    /**
     * Puts a question to whoever is watching, and waits.
     *
     * Raised as an `ask` event with a fresh id; the promise settles when
     * {@link respond} names that id. Called from the elicitation handler
     * while the agent's own request is blocked on the connection, so the
     * wait here is the agent's wait - which is what makes a pending
     * question read as `working` rather than `idle`.
     *
     * The event is named for what carried it - `elicitation/create` -
     * so a log line says where the question came from.
     */
    public ask(request: AskRequest): PendingAsk {

        if (this.disposed)
            throw new Error("The ACP session has ended.");

        return this.asks.ask(request, ELICITATION_CREATE);
    }

    public async respond(askId: string, answer: string): Promise<void> {

        this.asks.respond(askId, answer);
    }

    /**
     * The mode this session is in, when its agent has modes - set when
     * the session opens and on each {@link setAgentMode}.
     */
    public agentMode?: string;

    /** Whether the agent takes `image` blocks - set when the session opens. See {@link sdkMessage}. */
    public takesImages = false;

    /**
     * The standing instructions, waiting to go in front of the first
     * message - see {@link prefaceOf}. Set when the session opens, on a
     * runtime with no other way to take them; cleared once sent.
     */
    public preface?: string;

    /**
     * The message with {@link preface} in front, the first time. A slash
     * command is sent as typed - the runtime reads it only as the first
     * thing in the message - and the preface waits for the next one.
     */
    private withPreface(message: AgentMessage): AgentMessage {

        if (!this.preface || message.prompt.trimStart().startsWith("/"))
            return message;

        const preface = this.preface;

        this.preface = undefined;

        return { ...message, prompt: `${preface}

${message.prompt}` };
    }

    /** Sends `session/prompt` - at once unless an image has to be read first. */
    private prompt(message: AgentMessage): Promise<AcpPromptResponse> {

        const prompt = sdkMessage(message, this.takesImages);

        return prompt instanceof Promise
            ? prompt.then(blocks => this.activeSession.prompt(blocks))
            : this.activeSession.prompt(prompt);
    }

    /**
     * Shrinks the context with the runtime extension's own request - see
     * `AgentSession.compact`. Refused here while a turn runs, and on a
     * runtime whose extensions cannot.
     */
    public async compact(): Promise<{ ok: boolean; reason?: string }> {

        const compacting = this.extensions.find(extension => extension.compact);

        if (!compacting?.compact)
            return { ok: false, reason: "This runtime cannot compact a conversation." };

        if (this.disposed)
            return { ok: false, reason: "The session has ended." };

        if (this.state === "working")
            return { ok: false, reason: "A turn is still running. Compact once it has finished." };

        return compacting.compact(this.extensionView);
    }

    /**
     * What each tool call in flight was given - its title, kind, paths
     * and raw input, from its `tool_call` and `tool_call_update`s. See
     * {@link withCallInput}.
     */
    private readonly callInputs = new Map<string, AcpPermissionToolCall>();

    /** Permission requests waiting for their tool call to be read - see {@link withCallInput}. */
    private readonly callWaiters = new Map<string, (() => void)[]>();

    /** Keeps what a tool call update says about its input, and wakes anyone waiting on it. */
    private noteCallInput(update: AcpSessionUpdate): void {

        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
            return;

        const id = asText(update.toolCallId);

        if (!id)
            return;

        const known = this.callInputs.get(id) ?? {};
        const seen: AcpPermissionToolCall = { ...known, toolCallId: id };

        if (typeof update.title === "string" && update.title)
            seen.title = update.title;

        if (typeof update.kind === "string" && update.kind)
            seen.kind = update.kind;

        if (Array.isArray(update.locations) && update.locations.length)
            seen.locations = update.locations as { path: string }[];

        if (update.rawInput !== undefined && update.rawInput !== null)
            seen.rawInput = update.rawInput;

        this.callInputs.set(id, seen);

        for (const wake of this.callWaiters.get(id) ?? [])
            wake();

        this.callWaiters.delete(id);
    }

    /**
     * A permission request's tool call with the paths and input its own
     * `tool_call` carried. Kiro v3 sends a request with the title alone
     * ("Write File") - no path, no input - so without this the card could
     * not say which file, and the folder boundary had no path to check.
     *
     * The request can arrive before the update that describes the call
     * has been read off the queue, so this waits for it - briefly: a call
     * the agent never described is judged on what the request says.
     */
    public async withCallInput(toolCall: AcpPermissionToolCall | undefined, waitMs = CALL_INPUT_WAIT_MS): Promise<AcpPermissionToolCall | undefined> {

        const id = toolCall?.toolCallId;

        if (!toolCall || !id)
            return toolCall;

        if (!this.callInputs.has(id))
            await new Promise<void>(resolve => {

                const timer = setTimeout(done, waitMs);

                function done() {

                    clearTimeout(timer);
                    resolve();
                }

                this.callWaiters.set(id, [...(this.callWaiters.get(id) ?? []), done]);
            });

        const known = this.callInputs.get(id);

        if (!known)
            return toolCall;

        // The request's own fields win where it has them.
        return {
            ...known,
            ...Object.fromEntries(Object.entries(toolCall).filter(([, value]) =>
                value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)))
        };
    }

    /**
     * Switches the agent's mode in place, between turns - see
     * `AgentSession.setAgentMode`. Nothing picked leaves it as it is.
     */
    public async setAgentMode(mode: string | undefined): Promise<void> {

        if (!mode || mode === this.agentMode)
            return;

        const lines: string[] = [];

        this.agentMode = await applyAgentMode(
            this.ctx, this.activeSession, mode, text => lines.push(text), this.agentMode, modeGuardOf(this.extensions));

        for (const text of lines)
            this.publish({ name: SET_CONFIG_OPTION, raw: { mode }, kind: "notice", text });
    }

    /** The effort level this session runs at, when one was set - see {@link setEffort}. */
    public effort?: string;

    /**
     * Changes how hard the model thinks, between turns - the compose
     * box's Effort pick. Undefined goes back to the agent's default.
     */
    public async setEffort(effort: string | undefined): Promise<void> {

        const wanted = effort?.trim() || undefined;

        if (wanted === this.effort)
            return;

        const lines: string[] = [];

        const set = await applyEffort(this.ctx, this.activeSession, wanted ?? EFFORT_DEFAULT, text => lines.push(text));

        this.effort = set === EFFORT_DEFAULT ? undefined : set;

        for (const text of lines)
            this.publish({ name: SET_CONFIG_OPTION, raw: { effort }, kind: "notice", text });
    }

    /**
     * The model this session was opened on, so each turn's bill is
     * filed under it - see `AcpEventTranslator.model`. Nothing when the
     * agent lists no models; its bills then name none.
     */
    public runsOn(model: string | undefined): void {

        this.translator.model = model;
    }

    /**
     * Keeps a value where this session's extensions read it (see
     * `AcpExtensionTurn.noted`) - for what only the provider knows, such
     * as the feature flags (`engine.features`).
     */
    public noteForExtensions(key: string, value: unknown): void {

        this.notes.set(key, value);
    }

    /** Runs one turn and resolves with what the agent said in it - see `AcpExtensionSession.prompt`. */
    private async answerTo(text: string): Promise<string> {

        let answer = "";

        const stop = this.on(event => {

            if (event.kind === "message")
                answer += event.text;
        });

        try {

            await this.sendAndWait({ prompt: text });

        } finally {

            stop();
        }

        return answer;
    }

    /** What a tool call's own `tool_call` said, if it was seen and is still running - see {@link withCallInput}. */
    public knownCall(toolCallId: string | undefined): AcpPermissionToolCall | undefined {

        return toolCallId ? this.callInputs.get(toolCallId) : undefined;
    }

    /** The error for a message that starts with a slash command the runtime refuses, or undefined. */
    private refusedCommand(message: AgentMessage): Error | undefined {

        const name = blockedCommandIn(message.prompt, this.extensions);

        if (!name)
            return undefined;

        const reason = this.extensions.map(extension => extension.blockedReasons?.[name]).find(Boolean);

        return new Error(refusedCommandText(name, reason));
    }

    /** Options a guard change is on its way to the agent for, by id - see {@link guard}. */
    private readonly guarding = new Set<string>();

    /**
     * Keeps the session out of what the folder boundary cannot see, as the
     * agent reports its state: a mode the extension holds back (Copilot
     * CLI's Autopilot, Claude's Bypass permissions - reached by a typed
     * command, a settings file or an accepted plan), and the extension's
     * own "ask first" switch turned back on (Copilot CLI's `allow_all`,
     * which Autopilot turns on). Each is set back and said in the chat.
     * Also keeps {@link agentMode} true to what the agent says it is in.
     */
    private guard(update: AcpSessionUpdate): void {

        const guard = modeGuardOf(this.extensions);
        const wanted = this.extensions.map(extension => extension.permissionOption).find(Boolean);

        let mode: string | undefined;
        let options: AcpConfigOption[] | undefined;

        if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string")
            mode = update.currentModeId;

        if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {

            options = update.configOptions;

            const current = modeOption(options)?.currentValue;

            if (typeof current === "string")
                mode = current;

            // The model the next bills are filed under.
            const model = modelOption(options)?.currentValue;

            if (typeof model === "string" && model)
                this.translator.model = model;
        }

        if (mode !== undefined)
            this.agentMode = mode;

        if (this.disposed)
            return;

        // `what` is what the agent did, `back` what it is set back to.
        const fixes: { configId: string; value: string; what: string; back: string }[] = [];

        const modes = modeOption(options ?? this.activeSession.newSessionResponse.configOptions);

        if (guard && mode !== undefined && guard.hidden.includes(mode)) {

            const nameOf = (value: string) =>
                (modes ? choicesOf(modes).find(choice => choice.value === value)?.name : undefined) ?? value;

            fixes.push({
                configId: modes?.id ?? "mode",
                value: guard.fallback,
                what: `The agent switched itself to ${nameOf(mode)} mode, which runs tools without asking`,
                back: `switched back to ${nameOf(guard.fallback)}`
            });
        }

        const switched = wanted && options?.find(option => option.id === wanted.id);
        const value = wanted?.value;

        if (switched && value !== undefined && switched.currentValue !== value)
            fixes.push({
                configId: switched.id,
                value,
                what: `The agent turned its ${switched.name} switch to '${String(switched.currentValue)}', which stops it asking`,
                back: `set back to '${value}'`
            });

        // One already on its way covers this update too: Copilot reports
        // Autopilot twice, as a mode update and in the full option list.
        const due = fixes.filter(fix => !this.guarding.has(fix.configId));

        if (!due.length)
            return;

        for (const fix of due)
            this.guarding.add(fix.configId);

        const quiet = !this.started;

        void (async () => {

            for (const fix of due) {

                try {

                    // eslint-disable-next-line no-await-in-loop
                    await this.ctx.request(SET_CONFIG_OPTION, { sessionId: this.id, configId: fix.configId, value: fix.value });

                    if (fix.configId === modes?.id)
                        this.agentMode = fix.value;

                    // Before the first message, the update is most likely
                    // one sent before the session's own settings went in
                    // (Kiro v3 reports its options late) - set again
                    // quietly, since nothing ran in between.
                    if (quiet)
                        continue;

                    this.publish({ name: SET_CONFIG_OPTION, raw: fix, kind: "notice", text: `${fix.what} - ${fix.back}.` });

                } catch (error) {

                    // Nothing more this side can do but stop the turn:
                    // the agent may run tools the boundary cannot see.
                    this.publishError(new Error(
                        `${fix.what}, and it could not be ${fix.back.split(" to ")[0]} `
                        + `(${error instanceof Error ? error.message : String(error)}). `
                        + "The turn is stopped."));

                    void this.abort(`${fix.what}, and it could not be set back`);

                } finally {

                    this.guarding.delete(fix.configId);
                }
            }
        })();
    }

    /** One of our own permission cards, raised as a permission request. */
    public askCard(request: AskRequest): PendingAsk {

        return this.asks.ask(request, REQUEST_PERMISSION);
    }

    /** A permission request answered "yes" by itself - see `allowedNotice`. */
    public allowedWithoutAsking(permission: AskPermission, raw: unknown, callId?: string): void {

        if (!this.disposed)
            this.publish(allowedNotice(REQUEST_PERMISSION, raw, permission, callId));
    }

    /**
     * One vendor notification, read by the extension that knows it - see
     * `acpExtensions.ts`. A message naming another session is not this
     * one's. A reader that throws costs that one message, never the
     * session: vendor messages change without notice.
     */
    public receive(read: AcpExtensionReader, params: unknown): void {

        if (this.disposed)
            return;

        const named = (params as { sessionId?: unknown } | undefined)?.sessionId;

        if (typeof named === "string" && named !== this.id)
            return;

        let event: AgentEvent | undefined;

        try {

            event = read(params, this.extensionView);

        } catch {

            return;
        }

        if (event)
            this.publish(event);
    }

    /**
     * Every extension's `afterTurn`, one after another, each capped at
     * {@link AFTER_TURN_TIMEOUT_MS}. Never throws: a report that fails or
     * times out costs its event, never the turn.
     */
    private async afterTurn(): Promise<void> {

        for (const extension of this.extensions) {

            if (!extension.afterTurn || this.disposed)
                continue;

            try {

                // eslint-disable-next-line no-await-in-loop
                const events = await withTimeout(extension.afterTurn(this.extensionView), AFTER_TURN_TIMEOUT_MS);

                for (const event of events)
                    if (!this.disposed)
                        this.publish(event);

            } catch {

                // A missing report is not a failed turn.
            }
        }
    }

    /**
     * Drains `session/update` notifications for the life of the
     * session - not scoped to one turn, since the SDK routes every
     * update for this session id through the same queue regardless of
     * which `prompt()` call, if any, is in flight.
     */
    private async pump(): Promise<void> {

        // The last error the queue threw. The SDK throws two kinds: one
        // turn failing (a network drop mid-turn), thrown once, and the
        // whole connection closing, thrown again on every read after.
        let failure: unknown;

        for (; !this.disposed;) {

            let message: AcpSessionMessage;

            try {

                // eslint-disable-next-line no-await-in-loop
                message = await this.activeSession.nextUpdate();

            } catch (error) {

                // The same error twice: the connection closed - dispose()
                // or the agent's own process exiting. Nothing more to
                // drain.
                //
                // A new one is only that turn failing. The session is
                // still alive and the next message is a new turn, so the
                // reading goes on. Stopping here would leave a "resume" after a
                // network drop doing its work with nobody reading it:
                // no replies on screen and no end of turn, ever.
                if (failure !== undefined && error === failure)
                    return;

                failure = error;

                continue;
            }

            failure = undefined;

            if (message.kind === "stop") {

                // The turn's own token counts, where the runtime's
                // extension knows the agent reports something else - see
                // `AcpExtension.turnUsage`.
                const rewrite = this.extensions.find(extension => extension.turnUsage)?.turnUsage;
                const response = rewrite && message.response
                    ? { ...message.response, usage: rewrite(message.response.usage ?? undefined, this.extensionView) }
                    : message.response;

                for (const event of this.translator.flush(response))
                    this.publish(event);

                this.state = "idle";
                this.publish({ name: PROMPT, raw: message.response, kind: "idle" });

                this.onStop?.();

                continue;
            }

            // A vendor's data inside a standard update (Kiro v3 puts its
            // credits and context share in `session_info_update`), read
            // by its extension - in addition to the engine's own
            // handling below, never instead of it.
            for (const extension of this.extensions) {

                const read = extension.updates?.[message.update.sessionUpdate];

                if (read)
                    this.receive(read, message.update);
            }

            this.noteCallInput(message.update);
            this.guard(message.update);

            // The agent's slash commands, kept for the compose box - the
            // ones the extensions refuse left out.
            if (message.update.sessionUpdate === "available_commands_update" && this.runtime)
                void keepCommandList(this.runtime, offeredCommands(
                    commandsFrom(message.update.availableCommands),
                    this.extensions.flatMap(extension => extension.blockedCommands ?? [])));

            // What the agent wrote before this call is finished, so it
            // goes out first and the text after the call starts fresh
            // below it - see `AcpEventTranslator.settle`.
            if (message.update.sessionUpdate === "tool_call")
                for (const event of this.translator.settle())
                    this.publish(event);

            const translated = this.translator.translate(message.update);
            const event = translated?.kind === "tool.start"
                ? withToolName(translated, message.update as AcpPermissionToolCall, this.extensions)
                : translated;

            if (event)
                this.publish(event);

            // A finished call asks nothing more.
            const status = asText((message.update as { status?: unknown }).status);

            if (message.update.sessionUpdate === "tool_call_update"
                && (status === "completed" || status === "failed" || status === "cancelled"))
                this.callInputs.delete(asText(message.update.toolCallId));
        }
    }

    private publish(event: AgentEvent): void {

        // A context reading from a session that can compact says so, which
        // is what puts the Compact button in the meter.
        if (event.kind === "notice" && event.context && this.extensions.some(extension => extension.compact))
            event = { ...event, context: { ...event.context, compactable: true } };

        // Account usage is stamped with the runtime that reported it and
        // kept for the next session - see `accountCache.ts`.
        if (event.kind === "notice" && event.account) {

            this.accountShown = true;

            if (this.runtime) {

                event = { ...event, account: { ...event.account, runtime: event.account.runtime ?? this.runtime } };

                void this.accounts.remember(this.runtime, event.account!);
            }
        }

        for (const handler of [...this.handlers])
            handler(event);
    }

    /** An account notice has gone out this session - a kept copy arriving later is older, and not shown. */
    private accountShown = false;

    private started = false;

    /**
     * Once, on the first message - the first point anything is listening,
     * since a caller subscribes after the session is built. Two things,
     * neither awaited, so the message is not held up:
     *
     *   1. The account usage kept from an earlier session, if there is
     *      one - shown at once, dated, so the card is not empty until the
     *      runtime answers.
     *   2. Each extension's `atStart` - a fresh account fetch, for Kiro -
     *      published when it lands, capped like `afterTurn`.
     */
    /**
     * Settles once the pump has read the next `stop` - see `onStop`.
     *
     * Never rejects, and gives up after {@link STOP_READ_WAIT_MS}: it is
     * waited on only after `prompt()` resolved, and the SDK queues the
     * `stop` at that same moment, so a long wait means the pump is gone,
     * not that the turn is still running. A failed prompt queues no
     * `stop`; the next turn settles this one's wait before its own.
     */
    private stopRead(): Promise<void> {

        this.onStop?.();

        return new Promise(resolve => {

            const done = () => {

                clearTimeout(timer);

                if (this.onStop === done)
                    this.onStop = undefined;

                resolve();
            };

            const timer = setTimeout(done, STOP_READ_WAIT_MS);

            this.onStop = done;
        });
    }

    private start(): void {

        if (this.started)
            return;

        this.started = true;

        if (this.runtime)
            void this.accounts.last(this.runtime).then(kept => {

                if (kept && !this.accountShown && !this.disposed)
                    this.publish({
                        name: "account.kept",
                        raw: kept,
                        kind: "notice",
                        progress: true,
                        text: `Account usage as of ${new Date(kept.at).toISOString()} - fetching a fresh one`,
                        account: kept
                    });
            });

        for (const extension of this.extensions)
            if (extension.atStart)
                void withTimeout(extension.atStart(this.extensionView), AFTER_TURN_TIMEOUT_MS).then(
                    events => {
                        for (const event of events)
                            if (!this.disposed)
                                this.publish(event);
                    },
                    () => undefined);
    }

    private publishError(error: unknown): void {

        this.publish({
            name: "acp.error",
            raw: error,
            kind: "error",
            message: error instanceof Error ? error.message : String(error)
        });
    }
}

/** Whether the agent said `promptCapabilities.image: true` on `initialize` - ACP's promise that it takes an `image` block. */
export function takesImages(agentCapabilities: unknown): boolean {

    return (agentCapabilities as { promptCapabilities?: { image?: unknown } } | undefined)?.promptCapabilities?.image === true;
}

/** The image types sent as the picture itself, by file extension. */
const IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp"
};

/**
 * A message this file sends, in the shape `ActiveSession.prompt` accepts - see `Acp.client`'s own doc.
 *
 * An attached image goes as an `image` block with its bytes when the
 * agent takes images: a link alone gives the agent a file name it
 * never opens, so a pasted screenshot would never reach the model. Every
 * other file, and an image the agent cannot take or that cannot be read,
 * goes as a `resource_link` to the file.
 *
 * Returned straight away, not as a promise, when there is no image to
 * read - so a turn's `session/prompt` goes out in the same step `send`
 * was called in.
 *
 * Exported for tests.
 *
 * @param readFile How a file's bytes are read - a stand-in in tests.
 */
export function sdkMessage(
    message: AgentMessage,
    images: boolean,
    readFile: (file: string) => Promise<Buffer> = fs.readFile
): string | AcpContentBlock[] | Promise<AcpContentBlock[]> {

    const attachments = message.attachments ?? [];

    if (!attachments.length)
        return message.prompt;

    const text: AcpContentBlock = { type: "text", text: message.prompt };

    const link = (attachment: AgentAttachment): AcpContentBlock => ({
        type: "resource_link",
        uri: pathToFileURL(attachment.path).href,
        name: attachment.name ?? attachment.path
    });

    const imageType = (attachment: AgentAttachment) =>
        images ? IMAGE_TYPES[path.extname(attachment.path).toLowerCase()] : undefined;

    if (!attachments.some(imageType))
        return [text, ...attachments.map(link)];

    return Promise.all(attachments.map(async (attachment): Promise<AcpContentBlock> => {

        const mimeType = imageType(attachment);

        if (mimeType)
            try {

                return { type: "image", mimeType, data: (await readFile(attachment.path)).toString("base64") };

            } catch {

                // Not readable - the link still names it.
            }

        return link(attachment);
    })).then(blocks => [text, ...blocks]);
}

/** Backstop against a session that never resolves `prompt()` at all. The task's own `timeout:` is the real policy. */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** The most a finished turn waits for the pump to read its `stop` - see `AcpAgentSession.stopRead`. */
const STOP_READ_WAIT_MS = 5000;

/** The most one extension's after-turn step may hold a turn - the same cap `ClaudeProvider` puts on its context report. */
const AFTER_TURN_TIMEOUT_MS = 3000;

/**
 * How long a permission request waits for its tool call to be read - see
 * `AcpAgentSession.withCallInput`. The update is already on the wire
 * before the request; this only covers the queue not having got to it.
 */
const CALL_INPUT_WAIT_MS = 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(
            () => reject(new Error(`Timeout after ${timeoutMs}ms waiting for the session to settle`)),
            timeoutMs);

        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); });
    });
}

/**
 * ACP's `session/update` in the engine's terms.
 *
 * Buffers `agent_message_chunk` / `agent_thought_chunk` text per turn
 * and flushes each as one `message` / `reasoning` event when the turn
 * stops. That completed event is the only one logged and stored.
 *
 * While the text is arriving it also publishes the buffer so far as an
 * ephemeral `delta`, throttled to {@link DELTA_INTERVAL_MS}, so a
 * surface can paint the answer as it is written. Nothing painted this
 * way is kept: the flush behind it is what a reader gets back.
 *
 * Exported so tests can drive the translation in isolation.
 */
export class AcpEventTranslator {

    private message = "";

    /**
     * What vendor messages charged this turn, and their note - see
     * {@link charge}. Spent and cleared by {@link flush}, not by
     * {@link reset}: a charge that lands after one turn's end goes on
     * the next bill rather than nowhere.
     */
    private charges: Spend[] = [];

    private chargeNote?: string;

    /** How many model calls the vendor messages said this turn made - 0 when none said. */
    private callCount = 0;

    private reasoning = "";

    /** When each channel last published a delta - see {@link DELTA_INTERVAL_MS}. */
    private readonly lastDelta = { message: 0, reasoning: 0 };

    /**
     * @param now Injected so a test can pin the throttle rather than
     *            wait out real milliseconds.
     */
    constructor(private readonly now: () => number = () => Date.now()) { }

    /**
     * The buffer so far as a `delta`, or nothing while the throttle
     * holds. Each carries the whole of the channel's text, so a dropped
     * one costs nothing - the next supersedes it.
     */
    private painting(channel: DeltaChannel, name: string, raw: unknown): AgentEvent | undefined {

        const now = this.now();

        if (now - this.lastDelta[channel] < DELTA_INTERVAL_MS)
            return undefined;

        this.lastDelta[channel] = now;

        return { name, raw, kind: "delta", channel, text: this[channel] };
    }

    /** Tool calls in flight, by ACP's own `toolCallId` - the name a completion update does not always repeat. */
    private readonly calls = new Map<string, { tool: string; started: number }>();

    /**
     * The last cost `usage_update` reported, already formatted.
     *
     * Cumulative for the whole session, which is why it survives
     * {@link reset} - and why it is spent on the turn bill rather than
     * logged on arrival: the update repeats on a timer, and saying the
     * same sentence again with a bigger number is not news.
     */
    private cost = "";

    /**
     * The cumulative amount the last `usage_update` carried, and how
     * much of it earlier turn bills have already reported. The
     * difference is what the turn just finished charged - the figure
     * the bill notice carries, so a surface adding bills up never
     * counts the same dollar twice.
     */
    private costSoFar?: AcpCost;

    private billed = 0;

    /**
     * What the turn charged since the last bill - see {@link costSoFar}.
     * Nothing when the agent has never priced itself.
     */
    private charged(): Spend | undefined {

        const amount = this.costSoFar?.amount;

        if (typeof amount !== "number")
            return undefined;

        const charged = amount >= this.billed ? amount - this.billed : amount;

        this.billed = amount;

        return { amount: charged, unit: this.costSoFar?.currency || "USD" };
    }

    /**
     * The model the session runs on - the one picked for it, or the
     * agent's own choice when none was. Each turn's bill is filed under
     * it, because Kiro says what a turn charged but never which model
     * it was for. `auto` when the agent picks per turn: that is all
     * anybody knows. Kept across {@link reset}; the session updates it
     * when the agent says its model changed.
     */
    model?: string;

    /** A vendor message's charge for the turn in flight - see `AcpExtensionTurn.charge`, which the session routes here. */
    charge(spend: readonly Spend[], note?: string, calls?: number): void {

        this.charges = addSpend(this.charges, spend);

        if (note)
            this.chargeNote = note;

        if (calls && calls > 0)
            this.callCount += calls;
    }

    /** Called before each new `prompt()`, so a turn's buffers start empty. */
    reset(): void {

        this.message = "";
        this.reasoning = "";
    }

    /**
     * The text written so far as finished `reasoning` / `message`
     * events, with both buffers emptied.
     *
     * Called before a tool call is published, not only at the turn's
     * end. Without it the text written after the call would join the text
     * written before it: the live paragraph would keep growing above the tool
     * row, and the whole turn's text would be stored after every tool call.
     */
    settle(): AgentEvent[] {

        const events: AgentEvent[] = [];

        if (this.reasoning)
            events.push({ name: "agent_thought_chunk", raw: undefined, kind: "reasoning", text: this.reasoning });

        if (this.message)
            events.push({ name: "agent_message_chunk", raw: undefined, kind: "message", text: this.message });

        this.reset();

        return events;
    }

    /**
     * The turn's end as events, in the order a reader wants them: what
     * the agent thought, what it said, what the turn cost, and why it
     * stopped when that was not simply "it finished". Without the last
     * two, an ACP turn that hit a token ceiling or was refused would
     * reach the log as an ordinary, silent finish.
     */
    flush(response?: AcpPromptResponse): AgentEvent[] {

        const events = this.settle();

        // What this turn charged: the agent's running total less what
        // earlier bills took. The line says this, not the running total -
        // a turn that cost nothing (a failed `/compact`) would read as the
        // whole session's cost.
        const own = response?.usage || this.cost ? this.charged() : undefined;

        const bill = describeAcpUsage(
            response?.usage,
            own ? describeAcpCost({ amount: own.amount, currency: own.unit }) ?? "" : "");

        // ACP's own figures and whatever a vendor message charged, on
        // one line - an agent may send either, or both.
        const cost = addSpend(own ? [own] : [], this.charges);

        const calls = this.callCount;

        const tokens = acpTokens(response?.usage);

        const text = [
            bill,
            ...this.charges.map(describeCharge),
            this.chargeNote,
            calls ? `(${calls} model ${calls === 1 ? "call" : "calls"})` : ""
        ]
            .filter(Boolean)
            .join(" ");

        this.charges = [];
        this.chargeNote = undefined;
        this.callCount = 0;

        if (text)
            events.push({
                name: PROMPT,
                raw: response,
                kind: "notice",
                text: `Turn finished - ${text}`,
                ...(cost.length ? { cost } : {}),

                // The same charge filed under the session's model, so
                // the usage table has a model to put it under. Never
                // counted twice: the table reads the models when they
                // carry a cost, and the turn's charge only when not.
                // The turn's tokens ride on the same entry, so a surface
                // can show them beside the charge.
                ...((cost.length || tokens) && this.model
                    ? { models: [{ model: this.model, ...(cost.length ? { cost } : {}), ...tokens }] }
                    : {}),
                ...(calls ? { calls } : {})
            });

        const stopped = describeStopReason(response?.stopReason, response);

        if (stopped)
            events.push(stopped);

        this.reset();

        return events;
    }

    translate(update: AcpSessionUpdate): AgentEvent | undefined {

        switch (update.sessionUpdate) {

            case "agent_message_chunk":

                if (update.content?.type !== "text")
                    return undefined;

                this.message += update.content.text;

                return this.painting("message", "agent_message_chunk", update);

            case "agent_thought_chunk":

                if (update.content?.type !== "text")
                    return undefined;

                this.reasoning += update.content.text;

                return this.painting("reasoning", "agent_thought_chunk", update);

            case "tool_call": {

                const toolCallId = asText(update.toolCallId);

                const tool = toolTitle(
                    asText(update.title) || asText(update.kind) || "tool",
                    update.rawInput);

                if (toolCallId)
                    this.calls.set(toolCallId, { tool, started: Date.now() });

                const detail = describeArguments(update.rawInput) || asText(update.title) || undefined;
                const path = toolPath(update);

                return {
                    name: "tool_call",
                    raw: update,
                    kind: "tool.start",
                    tool,
                    ...(toolCallId ? { callId: toolCallId } : {}),
                    ...(detail ? { detail } : {}),
                    ...(path ? { path } : {}),
                    call: JSON.stringify(update)
                };
            }

            case "tool_call_update": {

                const status = asText(update.status);

                // An update that is not a terminal status is a live
                // content/output revision on a call already logged as
                // started - not worth a second log line each time one
                // arrives, the same call `CopilotEventTranslator` makes
                // for `tool.execution_progress`.
                if (status !== "completed" && status !== "failed" && status !== "cancelled")
                    return undefined;

                const toolCallId = asText(update.toolCallId);
                const call = toolCallId ? this.calls.get(toolCallId) : undefined;

                if (toolCallId)
                    this.calls.delete(toolCallId);

                const detail = describeArguments(update.rawOutput);

                return {
                    name: "tool_call_update",
                    raw: update,
                    kind: "tool.end",
                    ...(toolCallId ? { callId: toolCallId } : {}),
                    tool: call?.tool ?? "tool",
                    success: status === "completed",
                    ...(detail ? { detail: clip(detail, LINE_LIMIT) } : {}),
                    ...(call ? { ms: Date.now() - call.started } : {})
                };
            }

            // The whole plan each time - the chat's plan strip shows the newest.
            case "plan": {

                const plan = planFromAcp(update.entries);

                return {
                    name: "plan",
                    raw: update,
                    kind: "notice",
                    text: planText(plan),
                    plan
                };
            }

            case "current_mode_update":

                return {
                    name: "current_mode_update",
                    raw: update,
                    kind: "notice",
                    text: `Mode: ${asText(update.currentModeId)}`
                };

            case "usage_update": {

                // The cost is a figure ACP sends nowhere else, so it is
                // kept and spent on the next `flush`. The window fill
                // goes out now as a heartbeat notice - it replaces the
                // last one, so repeating on a timer stacks nothing up.
                this.cost = describeAcpCost(update.cost) ?? this.cost;

                if (update.cost && typeof update.cost.amount === "number")
                    this.costSoFar = update.cost;

                const context = acpContext(update);

                if (!context)
                    return undefined;

                return {
                    name: "usage_update",
                    raw: update,
                    kind: "notice",
                    progress: true,
                    text: `Context ${Math.round((context.used / context.size) * 100)}% of ${context.size} tokens used`,
                    context
                };
            }

            case "session_info_update": {

                // A title the agent gave the conversation - ACP's own
                // field. Kiro v3 sends the start of the message first,
                // then a short one it writes; one live line, the newest.
                // One made from our own instructions is left out.
                const title = agentTitle(update.title);

                return title
                    ? { name: "session_info_update", raw: update, kind: "notice", progress: true, text: `Title: ${title}`, title }
                    : undefined;
            }

            case "available_commands_update":
            case "user_message_chunk":

                // Runtime bookkeeping, or an echo of what we sent -
                // nothing a person reading the log needs a line for.
                return undefined;

            default:

                return { name: update.sessionUpdate || "unknown", raw: update, kind: "other" };
        }
    }
}

/**
 * The turn's bill as one line, or nothing when the agent counted
 * nothing.
 *
 * Cache reads and writes are folded into "in": the split matters for
 * pricing archaeology, not for the "what did this stage cost me"
 * question the line answers.
 *
 * `usage` is marked unstable in ACP's own schema, so every field is
 * read as optional and an agent that sends none of it costs no line.
 */
export function describeAcpUsage(usage: AcpUsage | undefined, cost = ""): string | undefined {

    const parts: string[] = [];

    if (usage) {

        const read = (usage.inputTokens ?? 0)
            + (usage.cachedReadTokens ?? 0)
            + (usage.cachedWriteTokens ?? 0);

        parts.push(`tokens in=${read} out=${usage.outputTokens ?? 0}`);
    }

    if (cost)
        parts.push(cost);

    return parts.length ? parts.join(" ") : undefined;
}

/**
 * A turn's `usage` as a model's token figures: "in" counts the cache
 * the same way {@link describeAcpUsage} does, and the cached share is
 * the cache reads - ACP's own field, or the ones an extension found
 * already inside `inputTokens`. Nothing when the agent sent no counts.
 *
 * Exported for tests.
 */
export function acpTokens(usage: AcpUsage | undefined): Pick<ModelSpend, "inputTokens" | "outputTokens" | "cachedTokens"> | undefined {

    if (!usage || (typeof usage.inputTokens !== "number" && typeof usage.outputTokens !== "number"))
        return undefined;

    const cached = (usage.cachedReadTokens ?? 0) + (usage.cachedInsideTokens ?? 0);

    return {
        inputTokens: (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
        outputTokens: usage.outputTokens ?? 0,
        ...(cached > 0 ? { cachedTokens: cached } : {})
    };
}

/**
 * The context window from a `usage_update`, or nothing when the agent
 * gave no size to measure against. ACP counts the whole only, so
 * there is no breakdown.
 */
export function acpContext(update: AcpSessionUpdate): ContextUsage | undefined {

    if (typeof update.used !== "number" || typeof update.size !== "number" || update.size <= 0)
        return undefined;

    return { used: update.used, size: update.size };
}

/**
 * The session's cost so far, from a `usage_update`.
 *
 * `$` only for USD: ACP sends an ISO 4217 code beside the amount, and
 * printing another currency with a dollar sign would be a lie the log
 * gives no way to catch.
 */
export function describeAcpCost(cost: AcpCost | undefined): string | undefined {

    if (!cost || typeof cost.amount !== "number")
        return undefined;

    return !cost.currency || cost.currency === "USD"
        ? `cost=$${cost.amount.toFixed(4)}`
        : `cost=${cost.amount.toFixed(4)} ${cost.currency}`;
}

/**
 * A vendor message's charge as text - `0.785 credits`. Up to three
 * decimals, trailing zeros dropped: Kiro bills fractions of a credit.
 *
 * Exported for tests.
 */
export function describeCharge(spend: Spend): string {

    return `${Number(spend.amount.toFixed(3))} ${spend.unit}`;
}

/**
 * Why the turn stopped, when that is worth a line.
 *
 * `end_turn` is the clean finish and says nothing - the `idle` event
 * after it already reports that the turn is over. `cancelled` is this
 * engine's own {@link AcpAgentSession.abort} coming back the way the
 * protocol requires, so it is a notice rather than a failure.
 *
 * Every other reason means the agent stopped before the work was done,
 * so it becomes an `error` event - a run that hit a token ceiling
 * should not read as a run that finished.
 *
 * Exported for tests - the stop reasons come from ACP's own
 * `StopReason`, and an agent sending one this build has not seen still
 * gets a line naming it.
 */
export function describeStopReason(stopReason: string | undefined, raw?: unknown): AgentEvent | undefined {

    switch (stopReason) {

        case undefined:
        case "":
        case "end_turn":

            return undefined;

        case "cancelled":

            return { name: PROMPT, raw, kind: "notice", text: "The turn was cancelled." };

        case "refusal":

            return {
                name: PROMPT,
                raw,
                kind: "error",
                message: "The agent refused to continue, so the turn ended without finishing the work."
            };

        case "max_tokens":

            return {
                name: PROMPT,
                raw,
                kind: "error",
                message: "The turn ended early: the agent reached its maximum number of tokens."
            };

        case "max_turn_requests":

            return {
                name: PROMPT,
                raw,
                kind: "error",
                message: "The turn ended early: the agent reached its maximum number of requests for one turn."
            };

        default:

            return { name: PROMPT, raw, kind: "error", message: `The turn ended: ${stopReason}` };
    }
}

/** The name every turn-end event carries - the ACP method that produced it, spelled once. */
const PROMPT = "session/prompt";

/**
 * `crypto.randomUUID`, via the global Node provides. Not imported from `ClaudeProvider`: reaching into it for one
 * line would tie every ACP session to it for no reason.
 */
function randomUuid(): string {

    return globalThis.crypto.randomUUID();
}

/** The file a tool call is about, from ACP's own `locations` - best effort, same stance as `describe.ts`'s `toolPath`. */
function toolPath(update: AcpToolCallUpdate): string | undefined {

    const path = update.locations?.[0]?.path;

    return typeof path === "string" && path.length ? path : undefined;
}

/**
 * Only the shape this file uses out of `@agentclientprotocol/sdk`. The
 * package's own types are far wider - a generated union of every ACP
 * method - and this stays deliberately narrow so a test can hand in a
 * plain object satisfying these few methods without loading the SDK.
 */
interface AcpSdk {

    PROTOCOL_VERSION: number;

    ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): AcpStream;

    client(options: { name: string }): AcpClientApp;
}

type AcpStream = unknown;

interface AcpClientApp {

    onRequest(method: typeof REQUEST_PERMISSION, handler: (ctx: AcpPermissionRequestContext) => Promise<AcpPermissionResponse>): AcpClientApp;

    onRequest(
        method: typeof ELICITATION_CREATE,
        handler: (ctx: { params: AcpElicitationRequest; signal?: AbortSignal }) => Promise<AcpElicitationResponse>
    ): AcpClientApp;

    /** A notification the protocol does not define - a vendor's own. `parse` hands the raw params through. */
    onNotification(method: string, parse: (raw: unknown) => unknown, handler: (ctx: { params: unknown }) => void): AcpClientApp;

    connect(stream: AcpStream): AcpConnection;
}

interface AcpPermissionRequestContext {

    params: {

        /*
         * `locations` and `rawInput` are the protocol's two ways of
         * naming the files a call touches, and the jail reads both -
         * an agent fills in whichever its own tool schema produced.
         */
        toolCall?: {

            title?: string;

            /** The protocol's own `ToolKind` - `read`, `edit`, `execute` and the rest. */
            kind?: string | null;

            locations?: { path: string }[] | null;

            rawInput?: unknown;
        };

        options: { optionId: string; kind: string; name?: string }[];
    };
}

interface AcpPermissionResponse {

    // `cancelled` is what a refusal falls back to when the agent
    // offered no rejecting option of its own.
    outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

/** Exported for tests - the few methods this file calls on the real `ClientConnection`. */
export interface AcpConnection {

    readonly agent: AcpAgentContext;

    close(error?: unknown): void;
}

/** Exported for tests - the few methods this file calls on the real `ClientContext`. */
export interface AcpAgentContext {

    request(method: typeof INITIALIZE, params: { protocolVersion: number; clientCapabilities: Record<string, unknown> })
        : Promise<{ protocolVersion: number; agentCapabilities?: unknown }>;

    request(method: typeof SET_CONFIG_OPTION, params: { sessionId: string; configId: string; value: string })
        : Promise<{ configOptions: AcpConfigOption[] }>;

    request(method: typeof SET_MODEL, params: { sessionId: string; modelId: string }): Promise<unknown>;

    /** Answers with what `session/new` would have, minus the id - which the caller already has. */
    request(method: typeof SESSION_LOAD, params: { sessionId: string; cwd: string; additionalDirectories?: string[]; mcpServers: AcpMcpServer[]; systemPrompt?: AcpSystemPrompt; _meta?: Record<string, unknown> })
        : Promise<Omit<AcpSessionResponse, "sessionId"> | null | undefined>;

    request(method: string, params?: unknown): Promise<never>;

    notify(method: typeof SESSION_CANCEL, params: { sessionId: string }): Promise<void>;

    buildSession(cwd: string): AcpSessionBuilder;

    /** The whole `session/new` request - for `_meta`, see `AcpExtension.sessionMeta`; for `systemPrompt`, `offersSystemPrompt`. */
    buildSession(request: { cwd: string; mcpServers: AcpMcpServer[]; systemPrompt?: AcpSystemPrompt; _meta?: Record<string, unknown> }): AcpSessionBuilder;

    /**
     * The SDK's own step after `session/new`: routes one session id's
     * updates into a queue and wraps it as an active session. Private in
     * the SDK's types, public in its JavaScript - see {@link loadSession}
     * for why it is used and what happens if it goes away.
     */
    attachSession?(response: AcpSessionResponse): AcpActiveSession;
}

/** What `session/new` and `session/load` answer with, as far as this file reads it. */
export interface AcpSessionResponse {

    sessionId: string;

    configOptions?: AcpConfigOption[] | null;

    models?: AcpModelState | null;
}

/**
 * ACP's `models` list, marked unstable in its schema: what the agent
 * runs, and which it is on. Set with `session/set_model`. Kiro CLI
 * lists its models this way.
 */
export interface AcpModelState {

    currentModelId: string;

    availableModels: { modelId: string; name?: string | null; description?: string | null }[];
}

/**
 * One session configuration option, as `session/new` returns them -
 * the protocol's "session config options". The one this provider
 * reads is the select with `category: "model"`: its choices are the
 * agent's model list, and `session/set_config_option` on its `id`
 * picks one. Every other option is the agent's own business.
 */
export interface AcpConfigOption {

    id: string;

    name: string;

    category?: string | null;

    type: "select" | "boolean";

    currentValue: string | boolean;

    /** Flat, or grouped - either way each choice has a `value` and a `name`. */
    options?: AcpConfigChoice[] | { group: string; name: string; options: AcpConfigChoice[] }[];
}

export interface AcpConfigChoice {

    value: string;

    name: string;

    description?: string | null;
}

interface AcpSessionBuilder {

    withAdditionalDirectories(directories: string[]): AcpSessionBuilder;

    withMcpServer(server: AcpMcpServer): AcpSessionBuilder;

    start(): Promise<AcpActiveSession>;
}

/** Exported for tests - the few methods this file calls on the real `ActiveSession`. */
export interface AcpActiveSession {

    readonly sessionId: string;

    /** The whole `session/new` (or `session/load`) response - read for its model list. */
    readonly newSessionResponse: Partial<AcpSessionResponse>;

    prompt(prompt: string | AcpContentBlock[]): Promise<AcpPromptResponse>;

    nextUpdate(): Promise<AcpSessionMessage>;

    dispose(): void;
}

export type AcpSessionMessage =
    | { kind: "session_update"; update: AcpSessionUpdate }
    | { kind: "stop"; response: AcpPromptResponse };

/** ACP's `PromptResponse` - what `session/prompt` resolves with. `usage` is marked unstable in its own schema. */
export interface AcpPromptResponse {

    stopReason?: string;

    usage?: AcpUsage;
}

/** ACP's `Usage`, every field optional here for the reason {@link describeAcpUsage} states. */
export interface AcpUsage {

    totalTokens?: number;

    inputTokens?: number;

    outputTokens?: number;

    thoughtTokens?: number | null;

    cachedReadTokens?: number | null;

    cachedWriteTokens?: number | null;

    /**
     * Not ACP's own: cache reads an extension found already counted
     * inside `inputTokens` (Copilot CLI's). Shown as the cached share
     * and never added to "in" a second time, unlike `cachedReadTokens`.
     */
    cachedInsideTokens?: number;
}

/** ACP's `Cost`, as a `usage_update` carries it. */
export interface AcpCost {

    amount?: number;

    currency?: string;
}

interface AcpContentBlock {

    type: string;

    text?: string;

    uri?: string;

    name?: string;

    mimeType?: string;

    /** An `image` block's bytes, base64. */
    data?: string;
}

export interface AcpToolCallUpdate {

    toolCallId?: string;

    title?: string;

    kind?: string;

    status?: string;

    rawInput?: unknown;

    rawOutput?: unknown;

    locations?: { path?: string }[];
}

export interface AcpSessionUpdate extends AcpToolCallUpdate {

    sessionUpdate: string;

    content?: { type: string; text?: string };

    entries?: unknown[];

    currentModeId?: string;

    /** `usage_update` only - ACP flattens its `UsageUpdate` into the update itself. */
    cost?: AcpCost;

    /** `usage_update` only: tokens in the window now, and the window's size. */
    used?: number;

    size?: number;

    /** `config_option_update` only: every config option, as they stand now. */
    configOptions?: AcpConfigOption[] | null;

    /** `available_commands_update` only: the agent's slash commands - see `commandListFile.ts`. */
    availableCommands?: unknown[];
}

let sdk: Promise<AcpSdk> | undefined;

function loadSdk(): Promise<AcpSdk> {

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return sdk ??= (import("@agentclientprotocol/sdk") as unknown as Promise<AcpSdk>);
}
