import React, { useEffect, useRef } from "react";
import { PluginAppMessage } from "../../shared/runMessages";
import { PluginBridge } from "../pluginBridge";
import { PhaseTab } from "../PhasePanel";

/**
 * The tabs plugins bring: one per plugin that ships an app, each an
 * iframe holding that plugin's page. Shared by the run panel and the
 * spec panel, which differ only in the state they hand the page.
 */

/**
 * What a page is told about the panel around it. Loose on purpose: the
 * two panels know different things, and the page reads what it wants.
 * `surface` says which panel it is in.
 */
export interface PluginAppState {

    surface: "run" | "spec";

    running: boolean;

    [key: string]: unknown;
}

export interface PluginAppTabsInput {

    apps: PluginAppMessage[];

    /** Which panel is asking. An app declared for the other surface alone is left out. */
    on: "run" | "spec";

    /** False under the profile's `debug: true` - the iframe then runs with no `sandbox` attribute. */
    sandboxed: boolean;

    /** What the pages are told - one state for all, or one per app when a page should see only its own plugin's lines. */
    state: PluginAppState | ((app: PluginAppMessage) => PluginAppState);

    bridge: PluginBridge;
}

/** The id a plugin's tab gets - the ref, prefixed, so it can never collide with a panel's own tab. */
export function pluginTabId(ref: string): string {

    return `plugin:${ref}`;
}

export function pluginAppTabs({ apps, on, sandboxed, state, bridge }: PluginAppTabsInput): PhaseTab[] {

    return apps.filter(app => app.surface === "both" || app.surface === on).map(app => ({
        id: pluginTabId(app.ref),
        label: app.label,
        title: `${app.ref}'s own page`,

        // The page keeps running while another tab is open. An app
        // that lost everything on each tab switch would not be an app.
        keepAlive: true,

        render: () => (
            <PluginAppFrame
                key={app.ref}
                app={app}
                sandboxed={sandboxed}
                state={typeof state === "function" ? state(app) : state}
                bridge={bridge} />
        )
    }));
}

/**
 * One plugin's page in an iframe, and the wire between them.
 *
 * The page gets the page theme once it says it is ready, the state
 * then and on every change, and an answer to every request. Only
 * messages from this iframe's own window are read.
 */
function PluginAppFrame({ app, sandboxed, state, bridge }: {
    app: PluginAppMessage;
    sandboxed: boolean;
    state: PluginAppState;
    bridge: PluginBridge;
}) {

    const frame = useRef<HTMLIFrameElement>(null);

    /** Whether the page has said ready - state sent before that is lost. */
    const ready = useRef(false);

    /** The latest state, for the ready handler, which is bound once. */
    const latest = useRef(state);

    latest.current = state;

    const tell = (message: Record<string, unknown>) =>
        frame.current?.contentWindow?.postMessage(message, "*");

    useEffect(() => {

        const onMessage = (event: MessageEvent) => {

            if (!frame.current || event.source !== frame.current.contentWindow)
                return;

            const message = event.data;

            if (!message || typeof message !== "object" || !message.eesha)
                return;

            if (message.eesha === "ready") {

                ready.current = true;

                tell(theme());
                tell({ eesha: "state", state: latest.current });

                return;
            }

            if (message.eesha === "request") {

                const { eesha, id, ...request } = message;

                void eesha;

                bridge.request({ ...request, ref: app.ref })
                    .then(value => tell({ eesha: "reply", id, ok: true, value }))
                    .catch(error => tell({ eesha: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) }));
            }
        };

        window.addEventListener("message", onMessage);

        return () => window.removeEventListener("message", onMessage);

    }, [app.ref, bridge]);

    // Every change, once the page can hear it.
    useEffect(() => {

        if (ready.current)
            tell({ eesha: "state", state });

    }, [state]);

    // A theme change re-stamps the root element's inline variables; the
    // page is told when that happens.
    useEffect(() => {

        const observer = new MutationObserver(() => {

            if (ready.current)
                tell(theme());
        });

        // `data-theme` is how Eesha Code switches dark and light.
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

        return () => observer.disconnect();

    }, []);

    return (
        <iframe
            ref={frame}
            className="plugin-app"
            title={app.label}
            srcDoc={app.html}

            // No `allow-same-origin`: the page gets an origin of its own,
            // so it cannot reach this document, its message channel or
            // Eesha Code's own page. `debug: true` takes the attribute off entirely.
            sandbox={sandboxed ? "allow-scripts allow-forms allow-modals" : undefined} />
    );
}

/**
 * Eesha Code's theme as the page has it, and the light/dark class on
 * the body. Copied, since an iframe of another origin inherits neither.
 *
 * The `--eesha-*` variables come from the page's stylesheet, and some may
 * sit inline on the root element. Both are read, each at its current value.
 */
function theme(): Record<string, unknown> {

    const inline = document.documentElement.getAttribute("style") ?? "";

    const computed = getComputedStyle(document.documentElement);

    // The page's dark or light mode too. When it differs from the frame's
    // own, the browser paints the frame's see-through background white.
    const scheme = computed.getPropertyValue("color-scheme").trim();

    const fromSheets = [
        ...stylesheetVariables()
            .filter(name => !document.documentElement.style.getPropertyValue(name))
            .map(name => `${name}: ${computed.getPropertyValue(name).trim()};`),
        ...(scheme && scheme !== "normal" && !document.documentElement.style.getPropertyValue("color-scheme")
            ? [`color-scheme: ${scheme};`]
            : [])
    ].join(" ");

    return {
        eesha: "theme",
        style: fromSheets ? `${inline}${inline && !inline.trim().endsWith(";") ? ";" : ""} ${fromSheets}`.trim() : inline,
        className: document.body.className
    };
}

/** The names of the `--eesha-*` variables the page's own stylesheets set. */
function stylesheetVariables(): string[] {

    const names = new Set<string>();

    const visit = (rules: CSSRuleList) => {

        for (const rule of Array.from(rules)) {

            if (rule instanceof CSSStyleRule) {

                for (let index = 0; index < rule.style.length; index++) {

                    const name = rule.style.item(index);

                    if (name.startsWith("--eesha-"))
                        names.add(name);
                }

            } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules)
                visit((rule as CSSGroupingRule).cssRules);
        }
    };

    for (const sheet of Array.from(document.styleSheets)) {

        try {

            visit(sheet.cssRules);

        } catch {

            // A stylesheet from another origin cannot be read; it sets none of ours.
        }
    }

    return [...names];
}
