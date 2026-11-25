// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as path from "path";

import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

/*
 * The SDD editor: the spec panel takes its line to the server from
 * whoever draws it (src/sdd/view/host.ts), and the editor passes the
 * server's (src/web/sddLine.ts).
 */

const root = path.resolve(__dirname, "..", "..", "..");

/** The files `entry` imports by a relative path, without their extensions. Nothing else is read, so this stays fast. */
async function importsOf(entry: string): Promise<string[]> {

    const found: string[] = [];

    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        logLevel: "silent",
        plugins: [
            {
                name: "only-the-entry",
                setup(build) {
                    build.onResolve({ filter: /.*/ }, args => {

                        if (args.kind === "entry-point")
                            return undefined;

                        if (args.path.startsWith("."))
                            found.push(path.resolve(args.resolveDir, args.path));

                        return { path: args.path, external: true };
                    });
                }
            }
        ]
    });

    return found;
}

const pageLine = path.join(root, "src", "view", "hostApi");

const serverLine = path.join(root, "src", "web", "sddLine");

describe("the SDD editor's line to the server", () => {

    it("is not picked by the spec panel itself", async () => {

        const read = await importsOf(path.join(root, "src", "sdd", "view", "SddSpecView.tsx"));

        expect(read).toContain(path.join(root, "src", "sdd", "view", "host"));
        expect(read).not.toContain(pageLine);
        expect(read).not.toContain(serverLine);
    });

    it("is the server's in the editor", async () => {

        const read = await importsOf(path.join(root, "src", "web", "SddEditor.tsx"));

        expect(read).toContain(serverLine);
        expect(read).not.toContain(pageLine);
    });
});
