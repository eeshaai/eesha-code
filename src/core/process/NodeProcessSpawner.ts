import { spawn } from "child_process";
import { ProcessSpawner, SpawnedProcess, SpawnOptions } from "./processSpawner";

/** The real thing: Node's `child_process.spawn`, behind the port. */
export class NodeProcessSpawner implements ProcessSpawner {

    spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess {

        const child = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: options.env,
            ...(options.cwd ? { cwd: options.cwd } : {})
        });

        return {

            writeStdin(data) {

                child.stdin?.write(data);
            },

            onStdout(listener) {

                child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString()));
            },

            onStderr(listener) {

                child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString()));
            },

            onExit(listener) {

                child.on("exit", listener);
            },

            onError(listener) {

                child.on("error", listener);
            },

            kill() {

                child.kill();
            }
        };
    }
}
