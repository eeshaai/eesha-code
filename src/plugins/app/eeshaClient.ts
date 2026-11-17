/**
 * The script every plugin app gets, put in front of its own page. It
 * defines `window.eesha` - the only way the page reaches anything outside
 * its iframe.
 *
 * Plain JavaScript in a string, because it is inlined into a page the
 * host assembles at runtime (see `PluginAppHost`), not bundled. Kept
 * small on purpose: once a plugin uses a call here, that call is a
 * promise the engine has to keep.
 *
 * Protocol with the parent (the panel's page), all via postMessage:
 *
 *   page -> parent  { eesha: "ready" }
 *   page -> parent  { eesha: "request", id, kind, ...body }
 *   parent -> page  { eesha: "theme", style, className }
 *   parent -> page  { eesha: "state", state }
 *   parent -> page  { eesha: "reply", id, ok, value, error }
 */
export const EESHA_CLIENT = /* js */ `
(() => {
    const pending = new Map();
    const listeners = new Set();
    let seq = 0;
    let state = null;

    window.addEventListener("message", event => {

        const m = event.data;

        if (!m || typeof m !== "object" || !m.eesha)
            return;

        if (m.eesha === "theme") {

            // The app's colours and fonts, as the panel has them.
            document.documentElement.style.cssText = m.style || "";
            document.documentElement.className = m.className || "";
            document.body && (document.body.className = m.className || "");

        } else if (m.eesha === "state") {

            state = m.state;

            for (const cb of listeners)
                try { cb(state); } catch (e) { console.error(e); }

        } else if (m.eesha === "reply") {

            const p = pending.get(m.id);

            if (!p)
                return;

            pending.delete(m.id);

            m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || "The request failed."));
        }
    });

    const request = (kind, body) => new Promise((resolve, reject) => {

        const id = ++seq;

        pending.set(id, { resolve, reject });
        parent.postMessage(Object.assign({ eesha: "request", id, kind }, body), "*");
    });

    window.eesha = Object.freeze({

        /** What the panel knows right now - the run's status, its steps, its artifacts. Null until the first state arrives. */
        get state() { return state; },

        /** Called with the state now (if there is one) and again on every change. Returns a function that stops the calls. */
        onState(cb) {

            listeners.add(cb);

            if (state)
                cb(state);

            return () => listeners.delete(cb);
        },

        /** Runs the plugin's own handle(request, ctx) and resolves with what it returned. */
        call: (name, payload) => request("call", { name, payload }),

        /** The plugin's own SQLite tables - see PluginDb. */
        db: Object.freeze({
            run: (sql, params) => request("db", { op: "run", sql, params }),
            get: (sql, params) => request("db", { op: "get", sql, params }),
            all: (sql, params) => request("db", { op: "all", sql, params })
        }),

        /** Starts a task (run panel) or a phase (spec panel) by id, or the whole definition with no argument. A second argument answers the workflow's params first: eesha.run(undefined, { env: "uat" }). */
        run: (target, params) => request("run", { target, params })
    });

    parent.postMessage({ eesha: "ready" }, "*");
})();
`;

/**
 * Put before the plugin's own styles, so its page starts out looking
 * like the panel around it and a plugin that sets nothing still reads.
 * Every value is one of the app's own theme variables, which the theme
 * message copies in.
 */
export const EESHA_BASE_STYLE = /* css */ `
html, body { margin: 0; padding: 0; background: transparent; }
body {
    color: var(--eesha-text);
    font-family: var(--eesha-font-family);
    font-size: var(--eesha-font-size);
    padding: 8px 12px;
    box-sizing: border-box;
}
a { color: var(--eesha-link); }
button {
    color: var(--eesha-button-text);
    background: var(--eesha-button-bg);
    border: 1px solid var(--eesha-button-border, transparent);
    border-radius: 2px;
    padding: 4px 12px;
    cursor: pointer;
    font: inherit;
}
button:hover { background: var(--eesha-button-bg-hover); }
input, select, textarea {
    color: var(--eesha-input-text);
    background: var(--eesha-input-bg);
    border: 1px solid var(--eesha-input-border, transparent);
    padding: 3px 6px;
    font: inherit;
}
table { border-collapse: collapse; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--eesha-widget-border, rgba(128,128,128,.3)); }
code, pre { font-family: var(--eesha-mono-font-family); font-size: var(--eesha-mono-font-size); }
`;
