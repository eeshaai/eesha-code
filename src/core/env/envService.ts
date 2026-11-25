/**
 * The env gate, as a service: one object that answers "what may be
 * read" and "read this one name" under the same rules everywhere.
 *
 * Three grants, one veto:
 *
 *   - `allowed`: `env.allowed` in settings.json.
 *   - `taskEnv`: the task's own exported env (declared `env:` plus
 *     `.env` values). Its value wins over the machine's.
 *   - `allowedEnv`: the task's `allowedEnv:` arg.
 *   - `denied`: `env.denied` in settings.json. Always wins, over every
 *     grant.
 *
 * This is the security boundary: a consumer holding an `EnvService`
 * instead of `process.env` can only see what something granted.
 */

/** Where names and grants come from. Same shape the MCP gate reads. */
export interface EnvAccess {

    /**
     * Where an allowed name's value comes from when the task doesn't
     * carry it. Omitted, the machine's own environment stands - the
     * constructor's `process.env` read is the one sanctioned read in
     * the codebase. Tests pass their own.
     */
    env?: Record<string, string | undefined>;

    allowed: readonly string[];

    denied: readonly string[];

    taskEnv?: Readonly<Record<string, string>>;

    allowedEnv?: readonly string[];
}

export class EnvService {

    private readonly env: Record<string, string | undefined>;

    /** `env.denied`, uppercased once - every denial check reads this, and only this. */
    private readonly deniedUpper: Set<string>;

    constructor(private readonly access: EnvAccess) {

        this.env = access.env ?? process.env;
        this.deniedUpper = new Set(access.denied.map(name => name.toUpperCase()));
    }

    /**
     * Whether `env.denied` vetoes this name. Case-insensitive, so a
     * name spelled differently than the settings entry cannot dodge the
     * veto. The only place that reads `env.denied`.
     */
    private isDenied(name: string): boolean {

        return this.deniedUpper.has(name.toUpperCase());
    }

    /**
     * The machine environment as a plain map, undefined values dropped.
     * Full inheritance, no veto, no allowlist.
     *
     * Where the person's own script runs - the shell
     * runner, `${{ env.X }}`, the SDD panels. Agent sessions do not use
     * this: they build an instance and use `spawnEnv`, an allowlist.
     */
    public static machine(): Record<string, string> {

        const env: Record<string, string> = {};

        for (const [name, value] of Object.entries(process.env))
            if (value !== undefined)
                env[name] = value;

        return env;
    }

    /**
     * The environment an agent child process gets - the Claude and
     * Copilot CLIs, and probed MCP servers. An allowlist:
     *
     *   - {@link SPAWN_BASELINE}: the process plumbing no child can run
     *     without. Matched case-insensitively, because Windows spells
     *     these `Path` and `ComSpec`.
     *   - the granted names (`env.allowed`, the task's `allowedEnv:`),
     *     exact-case, same as every other read of a grant.
     *   - the task's own `env:` values, layered last so they win.
     *
     * Everything else stays behind unless something a reviewer sees
     * grants it. An agent step that needs `JAVA_HOME` fails, naming the
     * variable, until a settings line or the workflow's `env:` says so.
     *
     * `env.denied` vetoes everything above, baseline and task included,
     * case-insensitively.
     */
    public spawnEnv(): Record<string, string> {

        const { allowed, allowedEnv, taskEnv } = this.access;

        const env: Record<string, string> = {};

        for (const [name, value] of Object.entries(this.env)) {

            if (value === undefined || this.isDenied(name))
                continue;

            if (SPAWN_BASELINE.has(name.toUpperCase())
                || allowed.includes(name)
                || allowedEnv?.includes(name))
                env[name] = value;
        }

        for (const [name, value] of Object.entries(taskEnv ?? {}))
            if (!this.isDenied(name))
                env[name] = value;

        return env;
    }

    /**
     * The env a spawned agent child gets, with every value it grants
     * registered as a secret first. Combined into one call so nothing
     * can reach a provider's child process without also reaching the
     * masker.
     */
    public spawnEnvMasked(registerSecret?: (value: string) => void): Record<string, string> {

        const env = this.spawnEnv();

        for (const value of this.grantValues())
            registerSecret?.(value);

        return env;
    }

    /**
     * Every granted name with a value, and nothing else. Denied names
     * are absent no matter what granted them. Unset names are absent
     * too. Set-but-empty stays: empty is a value someone chose.
     */
    public allowedValues(): Record<string, string> {

        const values: Record<string, string> = {};

        for (const name of this.grantedNames()) {

            const value = this.valueOf(name);

            if (value !== undefined)
                values[name] = value;
        }

        return values;
    }

    /**
     * The values a masker should treat as secret: every name the two
     * grant lists (`env.allowed`, the task's `allowedEnv:`) expose,
     * resolved, denied names excluded.
     *
     * The task's own `env:` block is left out on purpose: it carries
     * configuration like `NODE_ENV`, and masking `production` out of
     * every log line would garble the log to protect a value the
     * workflow file itself spells out.
     */
    public grantValues(): string[] {

        const names = new Set(
            [...this.access.allowed, ...this.access.allowedEnv ?? []]
                .filter(name => !this.isDenied(name)));

        return [...names]
            .map(name => this.valueOf(name))
            .filter((value): value is string => value !== undefined);
    }

    /**
     * One name's value, or a thrown explanation. Three mistakes, three
     * messages: a denied name says so, an ungranted one says how to
     * grant it, a granted-but-unset one says "set it". Callers that can
     * live without the value should use `allowedValues()` instead.
     */
    public resolve(name: string): string {

        if (this.isDenied(name))
            throw new Error(
                `'${name}' is denied by 'env.denied' in settings.json.`);

        if (!this.granted(name))
            throw new Error(
                `Nothing allows '${name}' to be read. Add it to 'env.allowed' in ` +
                `settings.json, declare it in the workflow's 'env:' block, or list it ` +
                `in the task's allowedEnv arg.`);

        const value = this.valueOf(name);

        if (value === undefined)
            throw new Error(
                `'${name}' is allowed, but the environment variable '${name}' is not set.`);

        return value;
    }

    /** Whether anything grants the name. Denial is the caller's check - deny wins over grants. */
    public granted(name: string): boolean {

        return this.fromTask(name)
            || this.access.allowed.includes(name)
            || this.access.allowedEnv?.includes(name)
            || false;
    }

    /** Every granted, non-denied name - the keys `allowedValues` may show. */
    private grantedNames(): Set<string> {

        const { allowed, taskEnv, allowedEnv } = this.access;

        const names = new Set<string>([
            ...Object.keys(taskEnv ?? {}),
            ...allowed,
            ...allowedEnv ?? []
        ]);

        for (const name of names)
            if (this.isDenied(name))
                names.delete(name);

        return names;
    }

    /** The task's value when it carries one, the machine's otherwise. */
    private valueOf(name: string): string | undefined {

        if (this.fromTask(name))
            return this.access.taskEnv![name];

        // Own-property here too: a plain-object env would otherwise
        // answer for `toString` and friends off the prototype.
        return Object.prototype.hasOwnProperty.call(this.env, name)
            ? this.env[name]
            : undefined;
    }

    /** Own-property check, so a task env never answers for `toString` and friends. */
    private fromTask(name: string): boolean {

        return !!this.access.taskEnv
            && Object.prototype.hasOwnProperty.call(this.access.taskEnv, name);
    }
}

/**
 * What every agent child inherits without being granted it - process
 * plumbing, not data. Uppercase; {@link EnvService.spawnEnv} matches
 * case-insensitively.
 *
 *   - PATH/PATHEXT: finding and spawning anything at all.
 *   - SYSTEMROOT/WINDIR/COMSPEC/SYSTEMDRIVE: Windows builds of Node
 *     and every shell misbehave without them.
 *   - TEMP/TMP/TMPDIR: `os.tmpdir()` on both platforms.
 *   - APPDATA/LOCALAPPDATA/HOME/USERPROFILE/HOMEDRIVE/HOMEPATH:
 *     where `claude` and `copilot` keep their sign-in state.
 *   - USERNAME/LANG/LC_ALL/SHELL: identity and locale plumbing.
 *   - COPILOT_CLI_PATH/CLAUDE_CLI_PATH: this engine's own settings for
 *     naming each CLI binary - configuration, not a credential.
 *
 * Deliberately absent: ANTHROPIC_API_KEY and every other credential,
 * and proxy vars like HTTP_PROXY. Grant them in `env.allowed`, where a
 * reviewer sees it. Adding a name here hands it to every agent child on
 * every machine.
 */
const SPAWN_BASELINE = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "LANG",
    "LC_ALL",
    "SHELL",
    "COPILOT_CLI_PATH",
    "CLAUDE_CLI_PATH"
]);
