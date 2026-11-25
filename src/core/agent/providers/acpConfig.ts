import { EnvService } from "../../env/envService";
import { BUILT_IN_ACP_AGENTS, SourcedAcpAgent } from "../../settings/engineSettings";
import {
    BARE_ENV_EXPRESSION, ENV_EXPRESSION, envNamesIn
} from "../../templating/configScope";

/** One `ai.acpAgents` entry, turned into a child process's argv and environment. */
export interface AcpAgentConfig {

    command: string;

    args: string[];

    /** `${{ env.NAME }}` already expanded under the gate - see {@link resolveAcpAgent}. */
    env: Record<string, string>;

    /** The vendor extensions this agent runs with, by id - see `acpExtensions.ts`. */
    extensions: string[];
}

/**
 * Validates and resolves one declared agent, env-expanding under the
 * gate as `resolveMcpServers` does for `ai.mcpServers`: the values are
 * handed to a third-party process, which is what the gate is for.
 *
 * A malformed declaration throws, naming its file - the same contract
 * as every other settings.json shape.
 */
export function resolveAcpAgent(id: string, declared: SourcedAcpAgent, envs: EnvService): AcpAgentConfig {

    const { agent, source } = declared;

    if (!agent || typeof agent !== "object" || Array.isArray(agent))
        throw new Error(`'${source}': ai.acpAgents.${id} must be an object with a 'command'.`);

    const entry = agent as Record<string, unknown>;

    const command = entry.command;

    if (typeof command !== "string" || !command)
        throw new Error(`'${source}': ai.acpAgents.${id}.command must be a non-empty string.`);

    const args = entry.args ?? [];

    if (!Array.isArray(args) || args.some(one => typeof one !== "string"))
        throw new Error(`'${source}': ai.acpAgents.${id}.args must be a list of strings.`);

    const env = entry.env ?? {};

    if (!env || typeof env !== "object" || Array.isArray(env))
        throw new Error(`'${source}': ai.acpAgents.${id}.env must be an object of string values.`);

    // Left out, a built-in id keeps its built-in extensions: someone who
    // points `kiro-cli` at another binary still wants Kiro's meter. An
    // empty list is how to switch them off.
    const extensions = entry.extensions ?? BUILT_IN_ACP_AGENTS[id]?.extensions ?? [];

    if (!Array.isArray(extensions) || extensions.some(one => typeof one !== "string"))
        throw new Error(`'${source}': ai.acpAgents.${id}.extensions must be a list of strings.`);

    return {
        command,
        args: [...(args as string[])],
        env: expandEnv(env as Record<string, unknown>, `ai.acpAgents.${id}.env`, source, envs),
        extensions: [...(extensions as string[])]
    };
}

/** `${{ env.NAME }}` in every value, resolved under the gate - see `mcpConfig.ts`'s `expandEnv` for the same rule. */
function expandEnv(
    env: Record<string, unknown>,
    what: string,
    source: string,
    envs: EnvService
): Record<string, string> {

    const resolved: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {

        if (typeof value !== "string")
            throw new Error(`'${source}': ${what}.${key} must be a string.`);

        // Only a granted name: another tool's `${workspaceFolder}` has
        // to pass through. See `mcpConfig`'s `refuseBare`.
        for (const [, name] of value.matchAll(new RegExp(BARE_ENV_EXPRESSION)))
            if (envs.granted(name))
                throw new Error(
                    `${source}: ${what}.${key} uses '\${${name}}', which reads nothing - it is passed `
                    + `through as literal text. Write it as '\${{ env.${name} }}' - the only form `
                    + `this file reads.`);

        resolved[key] = value.replace(new RegExp(ENV_EXPRESSION), (_, name: string) => {

            try {

                return envs.resolve(name);

            } catch (error) {

                throw new Error(
                    `${source} uses \${{ env.${name} }} in ${what}.${key}: `
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    return resolved;
}

/**
 * The runtime name an ACP agent asks `ProviderDeps.sessionEnv` with. An
 * agent that runs Claude (it has the `claude-cli` extension) asks as
 * `claude-cli` whatever its own id is, so Claude is treated the same
 * under any id.
 */
export function sessionEnvRuntime(id: string, extensions: readonly string[]): string {

    return extensions.includes("claude-cli") ? "claude-cli" : id;
}

/** The env var names one declaration reads, without resolving any of them - for the page's own confirmation prompt. */
export function referencedAcpAgentEnv(declared: SourcedAcpAgent): string[] {

    const agent = declared.agent;

    if (!agent || typeof agent !== "object" || Array.isArray(agent))
        return [];

    return [...envNamesIn((agent as Record<string, unknown>).env)];
}
