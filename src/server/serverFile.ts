import * as fs from "fs";

import { eeshaPath, readJson, writeAtomic } from "./paths";

/*
 * ~/.eesha/server.json: which process is the running server and on
 * which port. Written once it listens, removed when it stops. The
 * command reads it to find the server; a file left behind by a crash is
 * found out by the server not answering.
 */

export interface ServerFile {

    pid: number;

    port: number;

    startedAt: number;
}

export function serverFilePath(): string {

    return eeshaPath("server.json");
}

export function readServerFile(): ServerFile | undefined {

    const saved = readJson(serverFilePath()) as Partial<ServerFile> | undefined;

    return saved && typeof saved.pid === "number" && typeof saved.port === "number"
        ? { pid: saved.pid, port: saved.port, startedAt: typeof saved.startedAt === "number" ? saved.startedAt : 0 }
        : undefined;
}

export function writeServerFile(file: ServerFile): void {

    writeAtomic(serverFilePath(), JSON.stringify(file, undefined, 2) + "\n");
}

/** Removes the file - only when it is this process's, or `pid` is left out. */
export function removeServerFile(pid?: number): void {

    const saved = readServerFile();

    if (pid === undefined || saved?.pid === pid)
        fs.rmSync(serverFilePath(), { force: true });
}
