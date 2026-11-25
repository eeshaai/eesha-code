import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const coreRoot = path.resolve(__dirname, "..");

/** The bundled plugin library - `src/plugins/pwshV1`, `src/plugins/ghcpV1`. */
const bundledTasks = path.resolve(coreRoot, "..", "plugins");

function isTest(file: string): boolean {

    return /\.test\.tsx?$/.test(file) || file.split(path.sep).includes("__tests__");
}

/** The one escape allowed, and only from a test - see the second boundary test below. */
function allowedEscape(file: string, resolved: string): boolean {

    return isTest(file) && resolved.startsWith(bundledTasks);
}

function sourceFiles(directory: string): string[] {

    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {

        const full = path.join(directory, entry.name);

        if (entry.isDirectory())
            return sourceFiles(full);

        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    });
}

function importedModules(contents: string): string[] {

    const patterns = [
        /\bimport\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
        /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
        /\bimport\s+["']([^"']+)["']/g
    ];

    return patterns.flatMap(pattern => [...contents.matchAll(pattern)].map(match => match[1]));
}

/**
 * The engine must not depend on the server or the page code - that is
 * what lets the command line and the server both use it as it is.
 *
 * This is a rule that is easy to break by reflex (autocomplete
 * happily offers an import from anywhere in the repo) and expensive to unpick
 * later, so it is enforced mechanically rather than trusted to review.
 */
describe("core boundary", () => {

    const files = sourceFiles(coreRoot);

    it("finds source files to check, so a bad path can't make this pass vacuously", () => {

        expect(files.length).toBeGreaterThan(10);
    });

    it("no file under src/core reaches up out of src/core by relative path", () => {

        const offenders = files.filter(file =>
            importedModules(fs.readFileSync(file, "utf8"))
                .filter(module => module.startsWith("."))
                .some(module => {

                    const resolved = path.resolve(path.dirname(file), module);

                    return !resolved.startsWith(coreRoot) && !allowedEscape(file, resolved);
                }));

        expect(offenders.map(file => path.relative(coreRoot, file))).toEqual([]);
    });

    // A test may reach the bundled plugin set; shipped engine code may not.
    //
    // `src/plugins` depends on `src/core`, never the other way round -
    // that direction is what keeps the engine free of its own plugin
    // library. An end-to-end test legitimately wants the real `pwsh@1`,
    // and a test is not shipped, so it is allowed across. Production code
    // under src/core is not, or the dependency would point both ways and
    // stop meaning anything.
    //
    // `core/agent` is the deliberate exception to the *spirit* of that
    // rule rather than a hole in it: `ai@1` lives in the engine because
    // its conversations outlive the tasks that start them, which no
    // plugin can own. It is engine code that happens to be reachable
    // as a task - so it lives under `src/core` and obeys every rule here,
    // including this one. What it does bring in is a vendor SDK, which
    // the test below states outright rather than leaving to be noticed.
    it("and shipped engine code cannot reach the bundled plugins either - only tests may", () => {

        const production = files.filter(file => !isTest(file));

        const offenders = production.filter(file =>
            importedModules(fs.readFileSync(file, "utf8"))
                .filter(module => module.startsWith("."))
                .some(module => !path.resolve(path.dirname(file), module).startsWith(coreRoot)));

        expect(offenders.map(file => path.relative(coreRoot, file))).toEqual([]);
    });

    /*
     * The SDK is part of the engine, and this is the line that keeps that
     * from meaning "the engine needs a CLI to be tested".
     *
     * One directory imports the vendor package: the providers. Everything
     * above them - the session model, the registry, the `ai@1` task
     * itself - is written against `AgentProvider`, so a test registers a
     * fake and the real module is never reached, let alone its native
     * dependency. The moment a second file imports it, that stops being
     * true silently, which is exactly the kind of drift worth a test.
     */
    it("only the agent providers import a vendor SDK", () => {

        const vendorPackages = ["@github/copilot-sdk", "@github/copilot"];

        const allowed = path.join(coreRoot, "agent", "providers");

        const offenders = files
            .filter(file => !isTest(file) && !file.startsWith(allowed))
            .filter(file => importedModules(fs.readFileSync(file, "utf8"))
                .some(module => vendorPackages.some(vendor => module === vendor || module.startsWith(`${vendor}/`))));

        expect(offenders.map(file => path.relative(coreRoot, file))).toEqual([]);
    });
});
