/**
 * The file access spec discovery needs. An interface so the placement
 * rules can be tested from tables rather than temp directories.
 */
export interface SpecFiles {

    /** Folder names directly under the spec root. */
    specs(): Promise<string[]>;

    /**
     * What is in a spec folder: file and directory names, one level
     * deep, spec-relative. Directories included, because a style may
     * declare one as an artifact.
     */
    contents(spec: string): Promise<string[]>;

    /** A document's text, or `undefined` when it is not there. */
    read(spec: string, artifact: string): Promise<string | undefined>;

    /**
     * When the spec was last worked on, epoch milliseconds - `0` when
     * nothing about it can be read. The whole folder, not one document.
     */
    modified(spec: string): Promise<number>;
}
