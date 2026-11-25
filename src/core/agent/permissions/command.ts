import type { RememberChoice } from "../../models/permissionCard";

/*
 * Shell commands as our permission check reads them: cleaned, split into
 * the commands they chain, and turned into the wildcard choices a card
 * offers. Pure - no file system, no process.
 */

/** A command as the check sees it. */
export interface CleanedCommand {

    /** The whole command, cleaned - what the card shows. */
    text: string;

    /** The commands it chains, each cleaned. One part: not chained. */
    parts: string[];

    /**
     * Why a yes to it can only be given once, when it can: quoting this
     * check cannot follow, a wrapper inside a wrapper, or a command that
     * runs text as code.
     */
    onceOnly?: string;
}

/** `Invoke-Expression`, `iex` and `eval` run text as a command: never remembered. */
const RUNS_TEXT = /(^|[\s;|&(){}])(invoke-expression|iex|eval)(?=$|[\s;|&(){}'"])/i;

/**
 * A command cleaned for showing and matching:
 * trimmed, a trailing `;` and a leading `& ` or `. ` dropped, one shell
 * wrapper (`cmd /c`, `powershell -Command`, `pwsh -c`, `bash -c`,
 * `sh -c`) unwrapped, and split where it chains commands.
 *
 * Env settings in front are kept, and a program's full path is never
 * shortened.
 */
export function cleanCommand(raw: string): CleanedCommand {

    let text = raw.trim();
    let onceOnly: string | undefined;

    if (/^\.\s+/.test(text))
        text = text.replace(/^\.\s+/, "");

    const unwrapped = unwrap(text);

    if (unwrapped) {

        if ("problem" in unwrapped)
            onceOnly = unwrapped.problem;
        else {

            text = unwrapped.inner;

            if (unwrap(text))
                onceOnly = "it runs a shell inside a shell";
        }
    }

    const split = splitChain(text);

    if (split.problem)
        onceOnly ??= split.problem;

    if (RUNS_TEXT.test(text))
        onceOnly = "it runs text as a command";

    const pieces = split.pieces
        .map(piece => ({ ...piece, text: dropCallOperator(piece.text) }))
        .filter(piece => piece.text.length > 0);

    return {
        text: pieces.map((piece, index) => piece.text + (index < pieces.length - 1 ? joinWith(piece.separator) : "")).join(""),
        parts: pieces.map(piece => piece.text),
        ...(onceOnly ? { onceOnly } : {})
    };
}

/** How a part is joined to the next when the cleaned command is written out. */
function joinWith(separator: string): string {

    if (separator === ";")
        return "; ";

    if (separator === "\n")
        return "\n";

    return ` ${separator} `;
}

/** PowerShell's call operator in front of a command: `& npm test`. */
function dropCallOperator(part: string): string {

    let text = part.trim();

    while (/^&(?=[\s"'])/.test(text))
        text = text.slice(1).trim();

    return text;
}

/** Flags `powershell` / `pwsh` may carry before `-Command`, and whether each takes a value. */
const POWERSHELL_FLAGS: Readonly<Record<string, boolean>> = {
    "-noprofile": false,
    "-nop": false,
    "-nologo": false,
    "-noninteractive": false,
    "-noni": false,
    "-executionpolicy": true,
    "-ep": true,
    "-inputformat": true,
    "-outputformat": true
};

/**
 * The command inside one shell wrapper, or why it cannot be read, or
 * nothing when the command is not wrapped.
 */
function unwrap(text: string): { inner: string } | { problem: string } | undefined {

    const words = leadingWords(text, 8);

    if (!words.length)
        return undefined;

    const program = programName(words[0].text);

    if (program === "cmd") {

        const flag = words[1];

        if (!flag || !/^\/[ck]$/i.test(flag.text))
            return undefined;

        return innerOf(text.slice(flag.end));
    }

    if (program === "powershell" || program === "pwsh") {

        for (let index = 1; index < words.length; index++) {

            const word = words[index].text.toLowerCase();

            if (word === "-command" || word === "-c")
                return innerOf(text.slice(words[index].end));

            if (word === "-encodedcommand" || word === "-enc" || word === "-e" || word === "-ec")
                return { problem: "the command is encoded" };

            if (word === "-file" || word === "-f" || !word.startsWith("-"))
                return undefined;

            const takesValue = POWERSHELL_FLAGS[word];

            if (takesValue === undefined)
                return { problem: `it starts ${program} with a switch this check does not know (${words[index].text})` };

            if (takesValue)
                index++;
        }

        return undefined;
    }

    if (program === "bash" || program === "sh") {

        const flag = words[1];

        if (!flag || !/^-[a-z]*c[a-z]*$/i.test(flag.text))
            return undefined;

        return innerOf(text.slice(flag.end));
    }

    return undefined;
}

/** What follows a wrapper's switch: one quoted string has its quotes taken off. */
function innerOf(rest: string): { inner: string } | { problem: string } {

    const inner = rest.trim();

    if (!inner)
        return { problem: "the shell is given nothing to run" };

    const quote = inner[0];

    if (quote !== "\"" && quote !== "'")
        return { inner };

    const close = closingQuote(inner, 0);

    if (close === -1)
        return { problem: "its quotes are not closed" };

    // `"npm test" --flag`: the quoted text is only the first word.
    if (close !== inner.length - 1)
        return { inner };

    return { inner: inner.slice(1, -1).trim() };
}

/** The index of the quote that closes the one at `open`, or -1. */
function closingQuote(text: string, open: number): number {

    const quote = text[open];

    for (let index = open + 1; index < text.length; index++) {

        const char = text[index];

        // An escaped quote inside double quotes: `\"` (bash, cmd) or `` `" `` (PowerShell).
        if (quote === "\"" && (char === "\\" || char === "`") && text[index + 1] === "\"") {

            index++;

            continue;
        }

        if (char === quote) {

            // PowerShell doubles a quote to write one: 'it''s'.
            if (text[index + 1] === quote) {

                index++;

                continue;
            }

            return index;
        }
    }

    return -1;
}

/** The program's own name, without a folder or `.exe`, lower case. */
function programName(word: string): string {

    const base = word.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";

    return base.toLowerCase().replace(/\.exe$/, "");
}

/** One word at the start of a command and where it ends. */
interface Word {

    text: string;

    end: number;
}

/** Up to `limit` words at the start, split on spaces outside quotes. */
function leadingWords(text: string, limit: number): Word[] {

    const words: Word[] = [];

    let index = 0;

    while (index < text.length && words.length < limit) {

        while (index < text.length && /\s/.test(text[index]))
            index++;

        if (index >= text.length)
            break;

        const start = index;

        while (index < text.length && !/\s/.test(text[index])) {

            if (text[index] === "\"" || text[index] === "'") {

                const close = closingQuote(text, index);

                if (close === -1)
                    return words;

                index = close + 1;

                continue;
            }

            index++;
        }

        words.push({ text: text.slice(start, index), end: index });
    }

    return words;
}

/** One command in a chain and what joins it to the next. */
interface Piece {

    text: string;

    /** `&&`, `||`, `;`, `|`, `&` or a newline. Empty on the last. */
    separator: string;
}

/**
 * The commands a line chains, split where `&&`, `||`, `;`, `|`, a
 * newline, or one `&` between two commands joins them - outside quotes,
 * brackets and braces only. A redirection (`2>&1`, `&>`) is not a join.
 * A leading `&` is PowerShell's call operator, not a join.
 */
export function splitChain(text: string): { pieces: Piece[]; problem?: string } {

    const pieces: Piece[] = [];

    let depth = 0;
    let start = 0;
    let problem: string | undefined;

    const cut = (end: number, separator: string, next: number): void => {

        pieces.push({ text: text.slice(start, end), separator });

        start = next;
    };

    for (let index = 0; index < text.length; index++) {

        const char = text[index];

        if (char === "\"" || char === "'") {

            const close = closingQuote(text, index);

            if (close === -1) {

                problem = "its quotes are not closed";

                break;
            }

            index = close;

            continue;
        }

        if (char === "(" || char === "{") {

            depth++;

            continue;
        }

        if (char === ")" || char === "}") {

            depth--;

            if (depth < 0) {

                problem = "its brackets do not match";

                break;
            }

            continue;
        }

        if (depth > 0)
            continue;

        const two = text.slice(index, index + 2);

        if (two === "&&" || two === "||") {

            cut(index, two, index + 2);

            index++;

            continue;
        }

        if (char === ";" || char === "|") {

            cut(index, char, index + 1);

            continue;
        }

        if (char === "\n" || char === "\r") {

            const next = char === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;

            cut(index, "\n", next);

            index = next - 1;

            continue;
        }

        if (char === "&") {

            const before = text[index - 1];
            const after = text[index + 1];

            // `2>&1`, `>&2`, `&>file`, `<&3`: a redirection.
            if (before === ">" || before === "<" || after === ">")
                continue;

            // Nothing in this command yet: the call operator.
            if (!text.slice(start, index).trim())
                continue;

            cut(index, "&", index + 1);
        }
    }

    if (!problem && depth !== 0)
        problem = "its brackets do not match";

    pieces.push({ text: text.slice(start), separator: "" });

    const trimmed = pieces
        .map(piece => ({ text: piece.text.trim(), separator: piece.separator }))
        .filter(piece => piece.text.length > 0);

    return problem ? { pieces: trimmed, problem } : { pieces: trimmed };
}

/**
 * Text inside one command that runs another before it does: `$(...)`,
 * backticks, `<(...)`. A wildcard over such a command would cover what
 * it runs inside, so it can only be remembered exactly.
 */
export function runsInside(part: string): boolean {

    return /\$\(|`|<\(|>\(/.test(part);
}

/** An env setting in front of a command: `CI=true`. */
const ENV_SETTING = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word that names a sub-command - not a flag, path, quoted text or number. */
const PLAIN_WORD = /^[A-Za-z][A-Za-z0-9._:+@-]*$/;

/** How many words past the program a wildcard choice may name. */
const MAX_WORDS = 4;

/**
 * The card's "Remember as" choices for one command:
 * the exact command, then shorter and shorter starts with `*` after
 * them, down to the program alone. The pick is the program plus up to
 * two more words; never the bare program, which falls back to the exact
 * command.
 */
export function commandChoices(part: string): { choices: RememberChoice[]; pick: number } {

    const exact: RememberChoice = { pattern: part, hint: "only this exact command" };

    if (runsInside(part))
        return { choices: [exact], pick: 0 };

    const words = leadingWords(part, 32).map(word => word.text);

    let at = 0;

    while (at < words.length && ENV_SETTING.test(words[at]))
        at++;

    const program = words[at];

    if (!program)
        return { choices: [exact], pick: 0 };

    const sub: string[] = [];

    for (let index = at + 1; index < words.length && sub.length < MAX_WORDS; index++) {

        if (!PLAIN_WORD.test(words[index]))
            break;

        sub.push(words[index]);
    }

    const front = [...words.slice(0, at), program];

    const starts: RememberChoice[] = [];

    for (let count = sub.length; count >= 0; count--)
        starts.push({ pattern: `${[...front, ...sub.slice(0, count)].join(" ")} *` });

    // The shortest, the program alone, says what it covers.
    starts[starts.length - 1].hint = `any ${programName(program)} command`;

    const choices = [exact, ...starts.filter(choice => choice.pattern !== exact.pattern)];

    // The program plus up to two words; the bare program is never the pick.
    const wanted = Math.min(sub.length, 2);

    if (wanted === 0)
        return { choices, pick: 0 };

    const pattern = `${[...front, ...sub.slice(0, wanted)].join(" ")} *`;

    const pick = choices.findIndex(choice => choice.pattern === pattern);

    if (pick > 0 && !choices[pick].hint)
        choices[pick] = { ...choices[pick], hint: "suggested" };

    return { choices, pick: Math.max(pick, 0) };
}

/**
 * Whether a saved command pattern covers one command: the same text, or
 * a pattern ending ` *` whose start the command has, followed by nothing
 * or a space. A command that runs another inside it only matches its
 * exact text. A bare `*` never matches.
 */
export function commandMatches(pattern: string, part: string): boolean {

    const saved = pattern.trim();

    if (!saved || saved === "*")
        return false;

    if (saved === part)
        return true;

    if (!saved.endsWith(" *") || runsInside(part))
        return false;

    const start = saved.slice(0, -2);

    return part === start || part.startsWith(`${start} `);
}

/**
 * The folder a `cd` part moves to, or nothing when the part is not a
 * plain `cd <folder>`. `Set-Location`, `sl`, `chdir` and `pushd` too.
 * Relative to `from`.
 */
export function cdTarget(part: string, from: string, resolve: (from: string, to: string) => string): string | undefined {

    const words = leadingWords(part, 4).map(word => word.text);

    if (!words.length || !/^(cd|chdir|set-location|sl|pushd)$/i.test(words[0]))
        return undefined;

    let rest = words.slice(1);

    if (rest[0] && /^-(path|literalpath)$/i.test(rest[0]))
        rest = rest.slice(1);

    // `cd /d C:\x` (cmd).
    if (rest[0] && /^\/d$/i.test(rest[0]))
        rest = rest.slice(1);

    if (rest.length !== 1)
        return undefined;

    const folder = rest[0].replace(/^(["'])(.*)\1$/, "$2");

    if (!folder || folder === "-" || folder.startsWith("~") || folder.includes("$") || folder.includes("%"))
        return undefined;

    return resolve(from, folder);
}
