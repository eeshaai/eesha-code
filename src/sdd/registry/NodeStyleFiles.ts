import * as fs from "fs";
import * as path from "path";
import { Scope, StyleFiles } from "./styleFiles";

/**
 * Style folders on disk.
 *
 * ```
 * builtin    <resources>/styles/
 * profile    ~/.eesha/styles/
 * workspace  <repo>/.eesha/styles/
 * ```
 *
 * SDD core owns this resolution, and a style is not a workflow
 * template. A workspace style folder sits beside `specs/` rather than
 * inside it - a style folder under the specs root would have to be
 * skipped by every scan that looks for specs, and would show in the
 * spec list as a spec that is not one.
 *
 * A scope with no styles directory is normal, not an error: most repos
 * never have one, and most people never have a profile-level style.
 */
export const STYLES_DIR = "styles";

export class NodeStyleFiles implements StyleFiles {

    /**
     * @param roots The `styles` directory of each scope. Omit a scope to disable it.
     * @param workspace The repository, for a stage's `instructions:`. Omit to refuse them.
     */
    constructor(
        private readonly roots: Partial<Record<Scope, string>>,
        private readonly workspace?: string
    ) { }

    async styles(scope: Scope): Promise<string[]> {

        const root = this.roots[scope];

        if (!root)
            return [];

        const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);

        return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    }

    pathOf(scope: Scope, styleId: string, relative: string): string | undefined {

        const root = this.roots[scope];

        if (!root)
            return undefined;

        const file = path.join(root, styleId, ...relative.split("/"));

        return within(path.join(root, styleId), file) ? file : undefined;
    }

    async read(scope: Scope, styleId: string, relative: string): Promise<string | undefined> {

        const root = this.roots[scope];

        if (!root)
            return undefined;

        const file = path.join(root, styleId, ...relative.split("/"));

        // A path escaping the style folder is refused at parse time, so
        // this is the second lock rather than the first - but a
        // resolver that reads whatever it is handed is worth not
        // writing at all.
        if (!within(path.join(root, styleId), file))
            return undefined;

        return fs.promises.readFile(file, "utf8").catch(() => undefined);
    }

    sharedPath(scope: Scope, name: string): string | undefined {

        const root = this.roots[scope];

        if (!root)
            return undefined;

        const file = path.join(root, name);

        return fs.existsSync(file) && fs.statSync(file).isFile() ? file : undefined;
    }

    pathOfWorkspace(relative: string): string | undefined {

        if (!this.workspace)
            return undefined;

        const file = path.join(this.workspace, ...relative.split("/"));

        return within(this.workspace, file) ? file : undefined;
    }

    async readWorkspace(relative: string): Promise<string | undefined> {

        const file = this.pathOfWorkspace(relative);

        // Refused at parse time as well. The second lock is here
        // because a resolver that reads whatever it is handed is worth
        // not writing, and this one is handed a path from a file the
        // app did not write.
        return file ? fs.promises.readFile(file, "utf8").catch(() => undefined) : undefined;
    }
}

function within(folder: string, file: string): boolean {

    const relative = path.relative(folder, file);

    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

