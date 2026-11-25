/**
 * An arg value that reaches the plugin exactly as given, with no
 * `${{ }}` in it resolved.
 *
 * Every arg a plugin receives is template-resolved first, which is
 * right for `args:` written in tasks.yml. It is wrong for text that was
 * never authored as a template: a prompt the person typed into a chat,
 * or a conversation replayed to another runtime. That text is about
 * workflows, so it says `${{ params.repo }}` as plain words, and
 * resolving it fails on a name no scope has.
 *
 * Built in code, not written in YAML - the same value shape as a file
 * arg (see fileArg.ts), so `PluginHost` can tell it apart from a plain
 * map at any depth.
 */
export interface LiteralArg {

    /** The text, passed through untouched. */
    literal: string;
}

/** Wraps text so the host passes it through as it is. */
export function literal(text: string): LiteralArg {

    return { literal: text };
}

/** Whether a value is a literal-shaped input: a plain object whose only key is `literal`, holding a string. */
export function isLiteralArg(value: unknown): value is LiteralArg {

    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && typeof (value as Record<string, unknown>).literal === "string";
}
