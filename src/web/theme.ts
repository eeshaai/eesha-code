import type { ThemeChoice } from "../server/protocol";

/*
 * The page's colours. The choice is the server's (eesha.theme in
 * settings.json): dark, light, or the system's. "system" follows the
 * computer's setting, and changes with it while the page is open.
 */

const darkQuery = (): MediaQueryList | undefined =>
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;

/** Dark or light, for a choice. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "dark" | "light" {

    return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

let current: ThemeChoice = "dark";
let listening = false;

function paint(): void {

    const theme = resolveTheme(current, darkQuery()?.matches ?? true);

    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle("eesha-dark", theme === "dark");
    document.body.classList.toggle("eesha-light", theme === "light");
}

/**
 * The page's text size, in px - from the server's hello, or a change on
 * the settings page. Every size on the page is worked out from this one.
 */
export function applyFontSize(size: number): void {

    document.documentElement.style.setProperty("--app-font-size-base", `${size}px`);
}

/**
 * The server writes the text size into the page's <html> in place of
 * `__FONT_SIZE__`. If it does not, the word stays there. That value is
 * not a size, and every size worked out from it breaks: the list's
 * indent becomes 0. Taken away, the page uses its own 16px until the
 * server says otherwise.
 */
export function dropUnfilledFontSize(): void {

    const style = document.documentElement.style;

    if (style.getPropertyValue("--app-font-size-base").includes("__FONT_SIZE__"))
        style.removeProperty("--app-font-size-base");
}

/** Shows the page in this choice now - from the server's hello, or a change on the settings page. */
export function applyTheme(choice: ThemeChoice): void {

    current = choice;

    // The system's setting can change while the page is open.
    if (!listening) {

        listening = true;
        darkQuery()?.addEventListener?.("change", () => { if (current === "system") paint(); });
    }

    paint();
}
