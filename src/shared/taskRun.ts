/**
 * What a `- Run:` line under a task says. One keyword, three shapes:
 *
 *   `- Run: by hand`                       a person does it; the box is the only control
 *   `- Run: `git switch -c feature/4711``  a command, run in a terminal
 *   `- Run: story-start story=4711`       a workflow by name, with params on the line
 *
 * A task with any of these is not handed to an agent. Shared because
 * the view reads it off the plan and the host runs it when Next walks
 * the plan.
 */
export type TaskRun =
    | { kind: "manual" }
    | { kind: "command"; command: string }
    | { kind: "workflow"; name: string; args: Record<string, string> };
