/**
 * Replaces registered secret values with `***` in log output.
 *
 * Buffers by line before matching, because process stdout arrives in
 * arbitrary chunks: a secret can straddle a chunk boundary, so neither
 * chunk matches on its own and the value leaks in two halves.
 *
 * Every log line passes through here. Nothing else writes a secret to
 * the store, a snapshot, an output map, or a run variable.
 */
export class SecretMasker {

    private static readonly Replacement = "***";

    /** Values shorter than this are ignored - masking "a" or "12" would redact ordinary output. */
    private static readonly MinimumLength = 4;

    private readonly secrets: string[] = [];

    /**
     * The partial line after the last newline, held per stream. One
     * shared buffer would let a half stdout line be completed by the next
     * stderr chunk and tagged with the wrong stream.
     */
    private readonly buffers = new Map<string, string>();

    public register(value: string | undefined): void {

        if (!value || value.length < SecretMasker.MinimumLength)
            return;

        if (this.secrets.includes(value))
            return;

        // Longest first, so a secret that contains another is masked
        // whole rather than leaving its unmatched remainder in the clear.
        this.secrets.push(value);
        this.secrets.sort((a, b) => b.length - a.length);
    }

    /**
     * Feeds a raw chunk in; returns zero or more complete, masked lines.
     *
     * `stream` selects which buffer the chunk continues. Callers that
     * only ever carry one stream can leave it at the default.
     */
    public push(chunk: string, stream = ""): string[] {

        const parts = ((this.buffers.get(stream) ?? "") + chunk).split("\n");

        // The last part has no newline after it yet - it may be the front
        // half of a secret whose tail is in the next chunk.
        this.buffers.set(stream, parts.pop() ?? "");

        return parts.map(line => this.mask(line));
    }

    /** Returns any buffered partial line for a stream, masked. Call at task end. */
    public flush(stream = ""): string[] {

        const remaining = this.buffers.get(stream);

        if (!remaining)
            return [];

        this.buffers.set(stream, "");

        return [this.mask(remaining)];
    }

    /** Masks a string that is already a complete unit - an error message, not a stream chunk. */
    public mask(text: string): string {

        let masked = text;

        for (const secret of this.secrets)
            masked = masked.split(secret).join(SecretMasker.Replacement);

        return masked;
    }

}
