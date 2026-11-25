/**
 * The process-spawning access a stdio-speaking caller needs. An
 * interface so the wire protocol can be tested without a real child
 * process.
 */
export interface SpawnOptions {

    /** The child's environment. Never partial - a caller that wants inheritance says so explicitly. */
    env: Record<string, string>;

    cwd?: string;
}

export interface SpawnedProcess {

    writeStdin(data: string): void;

    onStdout(listener: (chunk: string) => void): void;

    onStderr(listener: (chunk: string) => void): void;

    /** Fires once, whether the process exited on its own or was killed. */
    onExit(listener: (code: number | null) => void): void;

    /** The process could not be started at all - a missing command, no permissions. */
    onError(listener: (error: Error) => void): void;

    kill(): void;
}

export interface ProcessSpawner {

    spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess;
}
