import * as os from "os";
import * as path from "path";

import { beforeAll, beforeEach } from "vitest";

/*
 * Stops an Eesha Code test file before its first test when the home folder
 * is the real one.
 *
 * The tests write chats, folder lists and scratch folders under
 * ~/.eesha, and the server's clean-up deletes chats it thinks are
 * empty. Run against the real profile, that would delete real chats'
 * folder lists.
 *
 * The repo-wide setup (src/__tests__/setup.ts) moves the home folder to a
 * new folder inside the OS temp folder before the tests run. Run from the
 * repo root, it is moved. Run any other way - from another folder, or with
 * another config - every test in the file fails here, before one of them
 * can write anything.
 *
 * Every Eesha Code test file imports this first; a test in parts.test.ts
 * checks that.
 */

/** Whether `home` is a folder inside `temp` - the throwaway home the setup makes. */
export function homeIsThrowaway(home: string, temp: string): boolean {

    const relative = path.relative(path.resolve(temp), path.resolve(home));

    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function refuseRealHome(): void {

    if (!homeIsThrowaway(os.homedir(), os.tmpdir()))
        throw new Error(
            `Refusing to run: the home folder is ${os.homedir()}, so this test would use the real ~/.eesha. ` +
            "Run the Eesha Code tests with `npx vitest run` from the repo root.");
}

beforeAll(refuseRealHome);

// Before every test too, and before the file's own beforeEach (hooks run
// in the order they were added, and this file is imported first): a test
// that puts the environment back can point the home folder at the real
// one between tests. A once-per-file check would miss that.
beforeEach(refuseRealHome);
