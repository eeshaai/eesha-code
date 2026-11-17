declare global {
    interface Window {
        serverApi(): {
            postMessage(message: unknown): void;

            /** The page's own scratch state. */
            getState(): unknown;

            setState(state: unknown): void;
        };
    }
}

/** The page's line to the server - set up by src/web/bridge.ts. */
export const host = window.serverApi();