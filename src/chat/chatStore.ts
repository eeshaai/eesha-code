/**
 * Small saved values a chat keeps: its runtime pick, its tools pick, the
 * names given by hand, the permission levels.
 *
 * Two calls: read and write. The values are written to files under
 * `~/.eesha/`.
 */
export interface ChatStore {

    get<T>(key: string): T | undefined;

    /** `undefined` removes the value. */
    update(key: string, value: unknown): PromiseLike<void>;
}
