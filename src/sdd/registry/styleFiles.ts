/**
 * The file access style resolution needs, and nothing else.
 *
 * A port rather than direct `fs` calls, because the scope rules are the
 * part with logic in it - which scope holds a style, what a clash
 * means, what a folder holding only prompts means - and that deserves
 * tests that read as tables rather than as temp directories. {@link NodeStyleFiles} is the real one.
 */

/**
 * Where a style folder can be found.
 *
 * A style id lives in one of these and no more - an id in two is an
 * error (see `StyleRegistry`). The order still matters for the one file
 * outside any style, the shared `grammar.md`, where it is lowest
 * precedence first.
 */
export const Scopes = ["builtin", "profile", "workspace"] as const;

export type Scope = typeof Scopes[number];

export interface StyleFiles {

    /**
     * The style ids present in a scope - every directory under it,
     * whether or not it holds a `style.yml`. A folder with nothing but
     * `instructions/tasks.md` is still listed, so that a clash with a
     * style of the same id in another scope is found and reported.
     */
    styles(scope: Scope): Promise<string[]>;

    /** A file's text, or `undefined` when that scope does not have it. Path is style-folder-relative. */
    read(scope: Scope, styleId: string, relative: string): Promise<string | undefined>;

    /**
     * Where a file sits on disk, for a caller that has to hand the path
     * to something else rather than read it.
     *
     * Optional because an in-memory implementation has no paths to
     * give, and most callers want the text. A registry offers a path
     * only when its file access can.
     */
    pathOf?(scope: Scope, styleId: string, relative: string): string | undefined;

    /**
     * A file in the repository, for a stage whose `instructions:` names one.
     *
     * Outside the scope model on purpose. The three scopes say where a
     * style lives; a stage's own instructions file is not
     * the style's file at all - it belongs to the repository, is
     * maintained by whoever maintains it there, and has no copy in any
     * other scope to lose to. Same port because it is the same kind of
     * thing to a caller (text, and a path to attach), not because it
     * resolves the same way.
     *
     * Optional for the same reason `pathOf` is: an in-memory
     * implementation in a test has no repository.
     */
    readWorkspace?(relative: string): Promise<string | undefined>;

    /** Where that file sits on disk, for attaching rather than reading. */
    pathOfWorkspace?(relative: string): string | undefined;

    /**
     * A file directly in a scope's styles folder, beside the style
     * folders rather than inside one - the grammar every style shares.
     * Undefined when that scope does not have it.
     *
     * Optional for the same reason `pathOf` is.
     */
    sharedPath?(scope: Scope, name: string): string | undefined;
}

