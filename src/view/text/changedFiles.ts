/** A file's name: its path after the last slash. `src/a/b.ts` is `b.ts`. */
export function fileName(path: string): string {
    return path.split('/').pop() ?? path;
}

/** A file's folder: its path before the last slash. `src/a/b.ts` is `src/a`. */
export function fileDir(path: string): string {
    return path.split('/').slice(0, -1).join('/');
}

/** The last part of a path that uses either kind of slash. `C:\code\a.ts` is `a.ts`. */
export function pathLabel(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

/** A repository's folder name - `C:/code/api` is `api`. */
export function repoFolderName(root: string): string {
    return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;
}

/** A changed file with the name and folder the list draws. */
export function withNames<F extends { path: string }>(file: F): F & { name: string; dir: string } {
    return { ...file, name: fileName(file.path), dir: fileDir(file.path) };
}

/** The first line of the message that started a turn, or "No message" when it is empty. */
export function turnTitle(message: string): string {
    return message.split('\n')[0] || 'No message';
}

/** The most of a message the hover text shows. */
const HOVER_LIMIT = 500;

/** The hover text over a turn's heading: the start of the whole message. */
export function turnHover(message: string): string {
    return message.slice(0, HOVER_LIMIT);
}
