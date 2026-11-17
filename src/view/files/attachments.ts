/** Encodes a File's bytes as base64 - e.g. for a JSON attachment payload. Chunked
 * to avoid a stack overflow from spreading a large Uint8Array into
 * String.fromCharCode at once. */
export async function fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}
