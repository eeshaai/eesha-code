import * as path from "path";

import { readJson } from "./paths";

/**
 * This package's package.json: one folder above dist/ when built, two
 * folders above src/server/ in the tests.
 */
function packageJson(): { version?: unknown; name?: unknown } | undefined {

    return (readJson(path.join(__dirname, "..", "package.json")) ?? readJson(path.join(__dirname, "..", "..", "package.json"))) as { version?: unknown; name?: unknown } | undefined;
}

/** This package's version. `eesha --version` prints it and the settings page shows it. */
export function packageVersion(): string {

    const json = packageJson();

    return typeof json?.version === "string" ? json.version : "unknown";
}

/** This package's npm name, from the same package.json - what an upgrade installs. */
export function packageName(): string {

    const json = packageJson();

    return typeof json?.name === "string" && /^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(json.name) ? json.name : "@eeshaai/code";
}
