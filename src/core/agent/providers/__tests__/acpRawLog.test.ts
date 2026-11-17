import { PassThrough } from "stream";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../../../logging/logger";
import { SecretMasker } from "../../../runner/SecretMasker";
import { logRawAcp, mcpSecretValues, registerRawSecret } from "../AcpProvider";

/** Feeds `chunks` through `logRawAcp` and returns what reached the log file. */
async function logged(chunks: string[], masker = new SecretMasker()): Promise<string[]> {

    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const stdout = new PassThrough();

    logRawAcp({ stdout } as unknown as ChildProcessWithoutNullStreams, "kiro-cli", masker);

    for (const chunk of chunks.slice(0, -1))
        stdout.write(chunk);

    stdout.end(chunks[chunks.length - 1]);

    await new Promise(resolve => stdout.once("end", resolve));

    return info.mock.calls.map(call => call[0]);
}

/* What the agent writes on stdout, copied to the log file line by line with the [ACP_RAW] prefix. */
describe("logRawAcp", () => {

    afterEach(() => vi.restoreAllMocks());

    it("logs each line once, whole, even when it arrives split across chunks", async () => {

        expect(await logged([
            '{"jsonrpc":"2.0","id":1,"res',
            'ult":{}}\n\n{"method":"_kiro/mcp/governance_disabled"}\n{"tail":',
            "true}"
        ])).toEqual([
            '[ACP_RAW] kiro-cli: {"jsonrpc":"2.0","id":1,"result":{}}',
            '[ACP_RAW] kiro-cli: {"method":"_kiro/mcp/governance_disabled"}',
            '[ACP_RAW] kiro-cli: {"tail":true}'
        ]);
    });

    it("masks a registered value, even one cut in half by a chunk boundary", async () => {

        const masker = new SecretMasker();

        registerRawSecret(masker, "pat-12345");

        expect(await logged(['{"text":"token pat-12', '345 here"}\n'], masker))
            .toEqual(['[ACP_RAW] kiro-cli: {"text":"token *** here"}']);
    });

    it("masks a value as it appears escaped inside JSON", async () => {

        const masker = new SecretMasker();

        registerRawSecret(masker, 'a"b\\c-secret');

        expect(await logged([`{"text":${JSON.stringify('a"b\\c-secret')}}\n`], masker))
            .toEqual(['[ACP_RAW] kiro-cli: {"text":"***"}']);
    });
});

describe("mcpSecretValues", () => {

    it("reads env and header values in both shapes, and ignores everything else", () => {

        expect(mcpSecretValues({
            servers: {
                ado: { command: "npx", args: ["not-a-secret"], env: { ADO_PAT: "pat-1" } },
                api: { url: "https://x.test", headers: [{ name: "Authorization", value: "Bearer tok" }] },
                odd: "nope"
            }
        })).toEqual(["pat-1", "Bearer tok"]);

        expect(mcpSecretValues(undefined)).toEqual([]);
    });
});
