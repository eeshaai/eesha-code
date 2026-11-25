import * as path from "path";
import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../ProcessRunner";

/**
 * The exit-code contract, over real processes.
 *
 * A child that died by signal reaches Node as `code: null`, and
 * mapping that to 0 would paint a killed process green. Success must
 * be exactly "the process itself said 0".
 */
describe("ProcessRunner", () => {

    it("reports a failing command's own exit code", async () => {

        const running = new ProcessRunner().start("exit 3", process.cwd(), () => undefined);

        expect(await running.exitCode).toBe(3);
    });

    it("reports success as 0", async () => {

        const running = new ProcessRunner().start("exit 0", process.cwd(), () => undefined);

        expect(await running.exitCode).toBe(0);
    });

    it("never reports a killed process as success", async () => {

        // Something that would outlive the test by far unless killed.
        const command = process.platform === "win32"
            ? "ping -n 30 127.0.0.1 > NUL"
            : "sleep 30";

        const running = new ProcessRunner().start(command, process.cwd(), () => undefined);

        // A beat for the child to actually exist before it is shot.
        setTimeout(() => running.kill(), 300);

        expect(await running.exitCode).not.toBe(0);
    }, 20_000);

    // Node hands a missing cwd back as `spawn <exe> ENOENT` - the same
    // error text as a missing shell, which points the reader at the
    // wrong thing entirely. The guard has to name the directory.
    it("names the directory when the cwd does not exist", () => {

        const missing = path.join(process.cwd(), "no-such-directory");

        expect(() => new ProcessRunner().start("exit 0", missing, () => undefined))
            .toThrow(`Working directory does not exist: ${missing}`);
    });

    it("names the directory when the cwd is a file", () => {

        const file = path.join(process.cwd(), "package.json");

        expect(() => new ProcessRunner().start("exit 0", file, () => undefined))
            .toThrow(`Working directory is not a directory: ${file}`);
    });
});
