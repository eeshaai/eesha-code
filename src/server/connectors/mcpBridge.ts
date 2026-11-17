import * as http from "http";
import * as readline from "readline";

import { ensureKey, KEY_HEADER } from "../security";
import { readServerFile } from "../serverFile";
import { packageVersion } from "../version";

/*
 * `eesha mcp --chat <id>`: the connectors' MCP server as a runtime
 * starts it - over stdin and stdout, one JSON message a line.
 *
 * It knows nothing itself. The tool list and every call go to the
 * running Eesha Code server, with the key and the session's id, so the
 * server alone decides what is allowed and asks the person in that
 * session's tab before a write.
 */

export const CONNECTORS_SERVER_NAME = "eesha-connectors";

/** A tool call may wait for the person to answer the write question. */
const CALL_MS = 30 * 60_000;

const LIST_MS = 30_000;

interface Message {

    jsonrpc?: string;

    id?: number | string | null;

    method?: string;

    params?: Record<string, unknown>;
}

function post(route: string, body: unknown, timeout: number): Promise<unknown> {

    const server = readServerFile();

    if (!server)
        return Promise.reject(new Error("The Eesha Code server is not running. Start it with `eesha start`."));

    const data = Buffer.from(JSON.stringify(body), "utf8");

    return new Promise((resolve, reject) => {

        const request = http.request({
            host: "127.0.0.1",
            port: server.port,
            method: "POST",
            path: route,
            headers: { [KEY_HEADER]: ensureKey(), "Content-Type": "application/json", "Content-Length": data.length },
            timeout
        }, response => {

            const parts: Buffer[] = [];

            response.on("data", (part: Buffer) => parts.push(part));
            response.on("end", () => {

                let answer: unknown;

                try {

                    answer = JSON.parse(Buffer.concat(parts).toString("utf8"));

                } catch {

                    return reject(new Error("The Eesha Code server's answer was not JSON."));
                }

                if (response.statusCode !== 200)
                    return reject(new Error((answer as { problem?: string }).problem ?? `The Eesha Code server answered ${response.statusCode}.`));

                resolve(answer);
            });
        });

        request.on("timeout", () => request.destroy(new Error("The Eesha Code server did not answer in time.")));
        request.on("error", reject);
        request.end(data);
    });
}

/** Runs until stdin closes. */
export function runMcpBridge(chatId: string): Promise<number> {

    const write = (message: unknown): void => {

        process.stdout.write(JSON.stringify(message) + "\n");
    };

    const answer = (id: Message["id"], result: unknown) => write({ jsonrpc: "2.0", id, result });

    const fail = (id: Message["id"], code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

    const handle = async (message: Message): Promise<void> => {

        const { id, method, params } = message;
        const isRequest = id !== undefined && id !== null;

        switch (method) {

            case "initialize":
                return answer(id, {
                    protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: CONNECTORS_SERVER_NAME, version: packageVersion() }
                });

            case "ping":
                return answer(id, {});

            case "tools/list":
                try {

                    const listed = await post("/control/connectors/tools", { chat: chatId }, LIST_MS) as { tools: unknown[] };

                    return answer(id, { tools: listed.tools });

                } catch (error) {

                    return fail(id, -32603, (error as Error).message);
                }

            case "tools/call":
                try {

                    const result = await post("/control/connectors/call", {
                        chat: chatId,
                        name: params?.name,
                        arguments: params?.arguments ?? {}
                    }, CALL_MS) as { text: string; isError?: boolean };

                    return answer(id, { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });

                } catch (error) {

                    return answer(id, { content: [{ type: "text", text: (error as Error).message }], isError: true });
                }

            default:
                // A notification (no id) needs no answer.
                if (isRequest)
                    fail(id, -32601, `${method} is not something this server does.`);
        }
    };

    return new Promise(resolve => {

        const lines = readline.createInterface({ input: process.stdin });

        lines.on("line", line => {

            if (!line.trim())
                return;

            let message: Message;

            try {

                message = JSON.parse(line) as Message;

            } catch {

                return fail(null, -32700, "Not JSON.");
            }

            void handle(message);
        });

        lines.on("close", () => resolve(0));
    });
}
