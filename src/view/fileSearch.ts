import type { FileMatch, PathMatch } from "../shared/composeFiles";

/**
 * The compose box's "@" file search, over the host: each search is posted
 * with a number, and the host's answer under the same number settles it.
 * An answer that never comes settles as no matches after a few seconds, so
 * the box is never left waiting.
 *
 * @param post Sends one search to the host.
 */
export function fileSearch(post: (requestId: number, query: string) => void): {
    search(query: string): Promise<FileMatch[]>;
    receive(requestId: number, files: FileMatch[]): void;
} {

    const pending = new Map<number, (files: FileMatch[]) => void>();

    let next = 0;

    return {

        search(query) {

            const requestId = ++next;

            return new Promise(resolve => {

                pending.set(requestId, resolve);

                setTimeout(() => {

                    if (pending.delete(requestId))
                        resolve([]);

                }, 5000);

                post(requestId, query);
            });
        },

        receive(requestId, files) {

            const settle = pending.get(requestId);

            pending.delete(requestId);
            settle?.(files);
        }
    };
}

/**
 * The compose box's ">" list, over the host - the same way as
 * {@link fileSearch}: each search is posted with a number and settled by
 * the host's answer under it, or as no rows after a few seconds.
 *
 * @param post Sends one search to the host.
 */
export function pathSearch(post: (requestId: number, path: string[], query: string, refresh?: boolean) => void): {
    search(path: string[], query: string, options?: { refresh?: boolean }): Promise<PathMatch[]>;
    receive(requestId: number, items: PathMatch[]): void;
} {

    const pending = new Map<number, (items: PathMatch[]) => void>();

    let next = 0;

    return {

        search(path, query, options) {

            const requestId = ++next;

            return new Promise(resolve => {

                pending.set(requestId, resolve);

                // Longer than the file search: a connector asks a web service.
                setTimeout(() => {

                    if (pending.delete(requestId))
                        resolve([{ name: "-", detail: "No answer from the server in time.", disabled: true }]);

                }, 20_000);

                post(requestId, path, query, options?.refresh);
            });
        },

        receive(requestId, items) {

            const settle = pending.get(requestId);

            pending.delete(requestId);
            settle?.(items);
        }
    };
}
