/** Triggers a browser download of `content` as a local file - no server round trip. */
export function downloadTextFile(filename: string, content: string, mimeType = 'text/markdown'): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** Downloads a chat answer as a markdown file named `response-<time>.md`. */
export function downloadResponse(text: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadTextFile(`response-${stamp}.md`, text);
}
