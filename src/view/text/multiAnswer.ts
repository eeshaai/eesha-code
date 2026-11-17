/**
 * A pick-several answer as one line of text: the ticked options in the
 * order the question lists them, then the typed text (kept as typed, so a
 * space between words survives the keystroke), joined with ", ".
 */
export function joinMultiAnswer(options: readonly string[], picked: readonly string[], other: string): string {
    return [...options.filter((option) => picked.includes(option)), ...(other.trim() ? [other] : [])].join(', ');
}
