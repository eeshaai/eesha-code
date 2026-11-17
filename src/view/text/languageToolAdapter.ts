import type { GrammarChecker, GrammarSuggestion } from '../ui';

export interface LanguageToolAdapterOptions {
    /** LanguageTool API base URL. Defaults to the public community endpoint. */
    apiUrl?: string;
    /** Language code, or "auto" to let LanguageTool detect it. */
    language?: string;
    /** API key for a LanguageTool Premium account, if you have one. */
    apiKey?: string;
    username?: string;
}

interface LanguageToolMatch {
    message: string;
    offset: number;
    length: number;
    replacements: Array<{ value: string }>;
}

interface LanguageToolResponse {
    matches: LanguageToolMatch[];
}

/**
 * Creates a `checkGrammar` function backed by LanguageTool's REST API.
 *
 * This is opt-in: PromptInput never calls out to any network service unless
 * you explicitly pass a checker (e.g. this one) as its `checkGrammar` prop.
 *
 * By default this targets the free, unauthenticated public endpoint
 * (api.languagetool.org), which is rate-limited (~20 requests/min per IP) and
 * meant for light or prototype usage. For production traffic, self-host
 * LanguageTool (see dev.languagetool.org/http-server) or use a Premium
 * account, and pass `apiUrl` / `apiKey` accordingly.
 */
export function createLanguageToolChecker(
    options: LanguageToolAdapterOptions = {}
): GrammarChecker {
    const {
        apiUrl = 'https://api.languagetool.org/v2/check',
        language = 'auto',
        apiKey,
        username,
    } = options;

    return async (text: string): Promise<GrammarSuggestion[]> => {
        if (!text.trim()) return [];

        const body = new URLSearchParams({ text, language });
        if (apiKey) body.set('apiKey', apiKey);
        if (username) body.set('username', username);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

        if (!response.ok) {
            throw new Error(`LanguageTool request failed: ${response.status}`);
        }

        const data: LanguageToolResponse = await response.json();

        return data.matches.map((m) => ({
            message: m.message,
            offset: m.offset,
            length: m.length,
            replacements: m.replacements.map((r) => r.value),
        }));
    };
}
