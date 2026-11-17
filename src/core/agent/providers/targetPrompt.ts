/**
 * What a session with a target is told, on top of its own system prompt.
 *
 * `ai@1` also puts this in the user's own prompt (see `withTarget`), so
 * a provider with no system-prompt channel still gets it. This is the
 * same instruction said again, on the channel that survives a long
 * session: a phase that goes on to read many files still carries a
 * standing rule after every one of those turns, where a paragraph from
 * the opening message does not.
 */
export function targetSystemPrompt(target: string, cwd: string): string {

    return `Write the finished document to \`${target}\`, relative to the working directory ` +
        `this session was started in (\`${cwd}\`) - not to wherever a shell happens to be. ` +
        "Create the file if it does not exist; overwrite it if it does. This holds for the whole " +
        "session, not only the first turn.";
}
