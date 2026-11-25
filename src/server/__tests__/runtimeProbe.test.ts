// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { probeAcp } from "../runtimeProbe";

/*
 * The check Add a runtime makes: start the program, send ACP's
 * `initialize`, wait for the answer. The programs here are node itself,
 * running a few lines given with -e.
 */

const node = process.execPath;

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** A node program that answers the first line it reads with `reply`. */
const answering = (reply: string) => ["-e", `
    process.stdin.once("data", () => {
        console.log("starting up");
        console.log(${JSON.stringify(reply)});
    });
    setInterval(() => {}, 1000);
`];

describe("probeAcp", () => {

    it("passes a program that answers initialize as an ACP agent, and gives its name", async () => {

        const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "test-agent" } } });

        expect(await probeAcp(node, answering(reply), env)).toEqual({ ok: true, name: "test-agent" });
    });

    it("fails a program that answers with an error", async () => {

        const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });

        expect(await probeAcp(node, answering(reply), env)).toEqual({ problem: expect.stringContaining("Method not found") });
    });

    it("fails a program that stops before it answers, with what it said", async () => {

        const result = await probeAcp(node, ["-e", "console.error('unknown option --acp'); process.exit(2)"], env);

        expect(result).toEqual({ problem: expect.stringMatching(/exit code 2.*unknown option --acp/s) });
    });

    it("fails a program that never answers, after the time given", async () => {

        const result = await probeAcp(node, ["-e", "setInterval(() => {}, 1000)"], env, 1500);

        expect(result).toEqual({ problem: expect.stringContaining("did not answer") });
    });
});
