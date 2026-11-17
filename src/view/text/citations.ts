export interface TextSegment {
    kind: 'text';
    value: string;
}

export interface CitationSegment {
    kind: 'citation';
    path: string;
    line: number;
}

export interface LinkSegment {
    kind: 'link';
    url: string;
}

export interface FileRefSegment {
    kind: 'fileRef';
    path: string;
}

export type CitationOrLinkSegment = TextSegment | CitationSegment | LinkSegment | FileRefSegment;

/** Matches a `path:line` inline-code citation (e.g. `` `main.ts:42` ``) - the
 * format an LLM can be instructed to use when it references a file location it
 * read via a tool, so the UI can turn it into a clickable file-viewer link. */
const CITATION_PATTERN = /`([\w.\-/\\]+\.\w+):(\d+)`/g;

/** Matches bare http(s) URLs. Trailing sentence punctuation is stripped off
 * after the match (below) rather than excluded from the character class, so
 * "(see https://example.com)" doesn't need special-casing for the `)`. */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/** Matches a `file://relative/path` reference - inserted by the composer when
 * a user points at a whole file (the "/" mention, drag-drop or add-button
 * from the file tree, or a re-picked recent file) rather than uploading its
 * bytes. Whole-file, so no line number - see CITATION_PATTERN for that case. */
const FILE_REF_PATTERN = /file:\/\/[^\s<>"')\]]+/g;

interface RawMatch {
    index: number;
    length: number;
    segment: CitationSegment | LinkSegment | FileRefSegment;
}

/** Splits text into plain-text, citation, and link segments, in order, so a
 * renderer can turn citations/links into clickable elements while leaving
 * everything else untouched. */
export function splitCitations(text: string): CitationOrLinkSegment[] {
    const raw: RawMatch[] = [];

    for (const match of text.matchAll(CITATION_PATTERN)) {
        raw.push({
            index: match.index ?? 0,
            length: match[0].length,
            segment: { kind: 'citation', path: match[1], line: Number(match[2]) },
        });
    }

    for (const match of text.matchAll(URL_PATTERN)) {
        let length = match[0].length;
        while (length > 0 && /[.,!?;:]/.test(match[0][length - 1])) length--;
        if (length === 0) continue;
        raw.push({ index: match.index ?? 0, length, segment: { kind: 'link', url: match[0].slice(0, length) } });
    }

    for (const match of text.matchAll(FILE_REF_PATTERN)) {
        let length = match[0].length;
        while (length > 0 && /[.,!?;:]/.test(match[0][length - 1])) length--;
        const path = match[0].slice('file://'.length, length);
        if (!path) continue;
        raw.push({ index: match.index ?? 0, length, segment: { kind: 'fileRef', path } });
    }

    raw.sort((a, b) => a.index - b.index);

    const segments: CitationOrLinkSegment[] = [];
    let lastIndex = 0;
    for (const { index, length, segment } of raw) {
        if (index < lastIndex) continue; // overlapping match - first one found wins
        if (index > lastIndex) segments.push({ kind: 'text', value: text.slice(lastIndex, index) });
        segments.push(segment);
        lastIndex = index + length;
    }
    if (lastIndex < text.length) segments.push({ kind: 'text', value: text.slice(lastIndex) });
    return segments;
}

/** Escapes the handful of ASCII punctuation marks CommonMark gives special meaning to,
 * so a path/URL dropped into Markdown link *text* (not the destination - that's always
 * percent-encoded by the caller) can't accidentally open code spans, emphasis, or nested
 * links of its own. */
const escapeMarkdown = (s: string) => s.replace(/[\\`*_[\]]/g, '\\$&');

/** Rewrites raw text into real Markdown source: citation and file-ref spans become
 * ordinary Markdown links pointing at synthetic `cite:`/`fileref:` destinations -
 * CitationText's own `a` renderer turns those back into the same clickable buttons
 * {@link splitCitations} finds, but through a real Markdown pipeline (so
 * everything else - bold, lists, code blocks - renders properly instead of showing
 * literal `**`/`` ` `` marks). Bare URLs are deliberately left untouched: remark-gfm's
 * own autolink-literal extension already turns them into real links, including the same
 * trailing-sentence-punctuation stripping {@link splitCitations} did by hand for
 * `LinkSegment` - duplicating that here would just double-process the same text. */
export function toMarkdownSource(text: string): string {
    const raw: { index: number; length: number; replacement: string }[] = [];

    for (const match of text.matchAll(CITATION_PATTERN)) {
        const [full, path, line] = match;
        raw.push({
            index: match.index ?? 0,
            length: full.length,
            replacement: `[${escapeMarkdown(path)}:${line}](cite:${encodeURIComponent(path)}:${line})`,
        });
    }

    for (const match of text.matchAll(FILE_REF_PATTERN)) {
        let length = match[0].length;
        while (length > 0 && /[.,!?;:]/.test(match[0][length - 1])) length--;
        const path = match[0].slice('file://'.length, length);
        if (!path) continue;
        raw.push({
            index: match.index ?? 0,
            length,
            replacement: `[${escapeMarkdown(path)}](fileref:${encodeURIComponent(path)})`,
        });
    }

    raw.sort((a, b) => a.index - b.index);

    let result = '';
    let lastIndex = 0;
    for (const { index, length, replacement } of raw) {
        if (index < lastIndex) continue; // overlapping match - first one found wins
        result += text.slice(lastIndex, index) + replacement;
        lastIndex = index + length;
    }
    result += text.slice(lastIndex);
    return result;
}
