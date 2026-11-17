import * as fs from "fs";
import * as path from "path";
import { hasContent } from "../../core/loader/hasContent";
import { SpecFiles } from "./specFiles";

/**
 * Spec folders on disk, under the configured spec root.
 *
 * A missing root is normal rather than an error: a repository that has
 * never made a spec has no folder, and the answer to "what specs are
 * there" is none.
 */
export class NodeSpecFiles implements SpecFiles {

    /** @param root The spec root, absolute. */
    constructor(private readonly root: string) { }

    async specs(): Promise<string[]> {

        const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);

        return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    }

    /**
     * One level deep, directories included - a style may declare a
     * directory as an artifact, and artifacts are named in the spec
     * folder.
     *
     * An empty file is not listed. A zero-byte `requirements.md` (a
     * phase that died mid-write) would otherwise tick its stage and
     * hand the next phase a blank. See {@link hasContent}.
     */
    async contents(spec: string): Promise<string[]> {

        const folder = path.join(this.root, spec);

        const entries = await fs.promises
            .readdir(folder, { withFileTypes: true })
            .catch(() => []);

        return entries
            .filter(entry => entry.isDirectory() || hasContent(path.join(folder, entry.name)))
            .map(entry => entry.name);
    }

    /**
     * The newest of the folder itself and everything directly in it.
     * The folder's own timestamp only moves when a document is added or
     * removed, not when one is rewritten.
     */
    async modified(spec: string): Promise<number> {

        const folder = path.join(this.root, spec);

        const entries = await fs.promises.readdir(folder).catch(() => []);

        const times = await Promise.all([folder, ...entries.map(name => path.join(folder, name))]
            .map(target => fs.promises.stat(target).then(stat => stat.mtimeMs, () => 0)));

        return Math.max(0, ...times);
    }

    async read(spec: string, artifact: string): Promise<string | undefined> {

        const file = path.join(this.root, spec, ...artifact.split("/"));

        if (!within(path.join(this.root, spec), file))
            return undefined;

        return fs.promises.readFile(file, "utf8").catch(() => undefined);
    }
}

function within(folder: string, file: string): boolean {

    const relative = path.relative(folder, file);

    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
