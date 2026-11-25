import * as fs from "fs";
import * as path from "path";

/**
 * The built worker bundle the sandbox tests run against.
 *
 * The real artefact, not a stand-in: the whole claim under test is that
 * a forked process with real permission flags cannot reach the disk, and
 * that is only worth asserting about the thing that actually ships.
 */
export const WORKER_PATH = path.resolve("dist/pluginWorker.js");

/** Fails loudly rather than letting a whole suite pass vacuously against a missing bundle. */
export function requireWorkerBundle(): void {

    if (!fs.existsSync(WORKER_PATH))
        throw new Error(
            `${WORKER_PATH} is missing - run \`npm run build\` before the sandbox tests. ` +
            `They are meaningless without the real worker.`);
}
