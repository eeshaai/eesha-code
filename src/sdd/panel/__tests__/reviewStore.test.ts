import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewNote } from "../../../view/templates/reviewNotes";
import { baseline, clearHistory, notesPath, readNotes, snapshot, writeNotes } from "../reviewStore";

let root: string;
let folder: string;
let home: string;

/** The document a note is about, as the panel hands it over: absolute. */
function document(): string {

    return path.join(folder, "requirements.md");
}

function note(over: Partial<ReviewNote> = {}): ReviewNote {

    return {
        id: "n1",
        artifact: document(),
        line: 9,
        anchorText: "a line",
        body: "Too vague.",
        createdAt: "2026-09-02T00:00:00.000Z",
        ...over
    };
}

/**
 * The home directory is moved by environment variable rather than by
 * mocking `os`: `homedir()` is documented to read `USERPROFILE` on
 * Windows and `HOME` on POSIX, and an ESM module namespace cannot be
 * spied on anyway. Both are set so the test reads the same on either.
 */
const HOME_VARIABLES = ["HOME", "USERPROFILE"] as const;

let restoreHome: (() => void)[] = [];

beforeEach(() => {

    root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
    folder = path.join(root, ".eesha", "specs", "greeting");

    fs.mkdirSync(folder, { recursive: true });

    home = fs.mkdtempSync(path.join(os.tmpdir(), "review-home-"));

    restoreHome = HOME_VARIABLES.map(name => {

        const previous = process.env[name];

        process.env[name] = home;

        return () => {

            if (previous === undefined)
                delete process.env[name];
            else
                process.env[name] = previous;
        };
    });
});

afterEach(() => {

    restoreHome.forEach(restore => restore());
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
});

describe("notes", () => {

    it("reads nothing from a spec nobody has commented on", () => {

        expect(readNotes(folder, root)).toEqual([]);
    });

    it("round-trips what was written", () => {

        writeNotes(folder, root, [note(), note({ id: "n2", body: "And this." })]);

        expect(readNotes(folder, root).map(one => one.id)).toEqual(["n1", "n2"]);
    });

    it("writes the file where the spec folder can commit it", () => {

        writeNotes(folder, root, [note()]);

        expect(fs.existsSync(path.join(folder, "review.json"))).toBe(true);
        expect(notesPath(folder)).toBe(path.join(folder, "review.json"));
    });

    /**
     * The file is committed and read on other machines. An absolute path
     * in it names a document that exists on exactly one laptop.
     */
    it("stores the document relative to the workspace root, with forward slashes", () => {

        writeNotes(folder, root, [note()]);

        const written = JSON.parse(fs.readFileSync(path.join(folder, "review.json"), "utf8"));

        expect(written.notes[0].artifact)
            .toBe(".eesha/specs/greeting/requirements.md");
    });

    /** The panel opens files. It gets back the path it gave. */
    it("reads the document back as a path this machine can open", () => {

        writeNotes(folder, root, [note()]);

        expect(readNotes(folder, root)[0].artifact).toBe(document());
    });

    /**
     * A spec kept outside the workspace has no relative form worth
     * writing - `../../..` is no more portable than the absolute path.
     */
    it("leaves a document the workspace does not contain absolute", () => {

        const outside = path.join(os.tmpdir(), "elsewhere", "requirements.md");

        writeNotes(folder, root, [note({ artifact: outside })]);

        const written = JSON.parse(fs.readFileSync(path.join(folder, "review.json"), "utf8"));

        expect(written.notes[0].artifact).toBe(outside);
        expect(readNotes(folder, root)[0].artifact).toBe(outside);
    });

    /**
     * The panel opens, the document is there, and every note on it is
     * silently gone - the failure this exists to prevent. It happens to
     * whoever reads the file under a different root than it was written
     * under, and the spec folder is the anchor that travelled with the
     * notes.
     */
    it("finds a document beside the spec when the stored root does not lead to it", () => {

        fs.writeFileSync(document(), "a draft", "utf8");

        writeNotes(folder, root, [note()]);

        // The same file, read by someone whose root sits a level up.
        expect(readNotes(folder, path.dirname(root))[0].artifact).toBe(document());
    });

    /**
     * A comment file is hand-editable and lives somewhere a merge can
     * leave conflict markers in it. Refusing to open the spec over that
     * would turn a note into a blocker.
     */
    it("treats an unreadable file as no notes rather than failing", () => {

        fs.writeFileSync(path.join(folder, "review.json"), "<<<<<<< HEAD\nnot json", "utf8");

        expect(readNotes(folder, root)).toEqual([]);
    });

    it("removes the file when the last note goes, rather than leaving an empty one", () => {

        writeNotes(folder, root, [note()]);
        writeNotes(folder, root, []);

        expect(fs.existsSync(path.join(folder, "review.json"))).toBe(false);
    });
});

describe("history", () => {

    it("has no baseline before anything was put aside", () => {

        expect(baseline(folder, root, path.join(folder, "requirements.md"))).toBeUndefined();
    });

    it("keeps the document as it stood", () => {

        const file = path.join(folder, "requirements.md");

        fs.writeFileSync(file, "first draft", "utf8");
        snapshot(folder, root, file);
        fs.writeFileSync(file, "second draft", "utf8");

        expect(baseline(folder, root, file)).toBe("first draft");
    });

    it("returns the newest of several", () => {

        const file = path.join(folder, "requirements.md");

        fs.writeFileSync(file, "one", "utf8");
        snapshot(folder, root, file, Date.parse("2026-09-01T10:00:00Z"));

        fs.writeFileSync(file, "two", "utf8");
        snapshot(folder, root, file, Date.parse("2026-09-02T10:00:00Z"));

        expect(baseline(folder, root, file)).toBe("two");
    });

    /** A first pass has no "before", and an empty one would mark every line of the first draft as new. */
    it("writes nothing for a document that does not exist yet", () => {

        snapshot(folder, root, path.join(folder, "design.md"));

        expect(baseline(folder, root, path.join(folder, "design.md"))).toBeUndefined();
    });

    it("keeps each document's history apart", () => {

        const requirements = path.join(folder, "requirements.md");
        const design = path.join(folder, "design.md");

        fs.writeFileSync(requirements, "R", "utf8");
        fs.writeFileSync(design, "D", "utf8");

        snapshot(folder, root, requirements);
        snapshot(folder, root, design);

        expect(baseline(folder, root, requirements)).toBe("R");
        expect(baseline(folder, root, design)).toBe("D");
    });

    it("keeps itself out of the repository, in the user's profile instead of the spec folder", () => {

        const file = path.join(folder, "requirements.md");

        fs.writeFileSync(file, "draft", "utf8");
        snapshot(folder, root, file);

        expect(fs.existsSync(path.join(folder, ".history"))).toBe(false);
        expect(fs.readdirSync(path.join(home, ".eesha", "history")).length).toBeGreaterThan(0);
    });

    it("uses a file name Windows accepts", () => {

        const file = path.join(folder, "requirements.md");

        fs.writeFileSync(file, "draft", "utf8");
        snapshot(folder, root, file);

        const [workspaceBucket] = fs.readdirSync(path.join(home, ".eesha", "history"));
        const [specBucket] = fs.readdirSync(path.join(home, ".eesha", "history", workspaceBucket));
        const written = fs.readdirSync(path.join(home, ".eesha", "history", workspaceBucket, specBucket));

        expect(written).toHaveLength(1);
        expect(written[0]).not.toContain(":");
        expect(written[0]).toMatch(/^requirements\..+\.md$/);
    });

    it("keeps two spec folders under the same workspace apart", () => {

        const other = path.join(root, ".eesha", "specs", "farewell");

        fs.mkdirSync(other, { recursive: true });

        const requirements = path.join(folder, "requirements.md");
        const otherRequirements = path.join(other, "requirements.md");

        fs.writeFileSync(requirements, "greeting draft", "utf8");
        fs.writeFileSync(otherRequirements, "farewell draft", "utf8");

        snapshot(folder, root, requirements);
        snapshot(other, root, otherRequirements);

        expect(baseline(folder, root, requirements)).toBe("greeting draft");
        expect(baseline(other, root, otherRequirements)).toBe("farewell draft");
    });
});

describe("pruning", () => {

    /** Every stored copy of one document, whatever its stamp. */
    function stored(name = "requirements"): string[] {

        const directory = path.join(home, ".eesha", "history");

        const walk = (at: string): string[] => fs.readdirSync(at, { withFileTypes: true })
            .flatMap(entry => entry.isDirectory()
                ? walk(path.join(at, entry.name))
                : [entry.name]);

        return fs.existsSync(directory)
            ? walk(directory).filter(entry => entry.startsWith(`${name}.`))
            : [];
    }

    it("keeps only the copy it just took", () => {

        const file = path.join(folder, "requirements.md");

        fs.writeFileSync(file, "one", "utf8");
        snapshot(folder, root, file, Date.parse("2026-09-01T10:00:00Z"));

        fs.writeFileSync(file, "two", "utf8");
        snapshot(folder, root, file, Date.parse("2026-09-02T10:00:00Z"));

        fs.writeFileSync(file, "three", "utf8");
        snapshot(folder, root, file, Date.parse("2026-09-03T10:00:00Z"));

        expect(stored()).toHaveLength(1);
        expect(baseline(folder, root, file)).toBe("three");
    });

    it("leaves another document's copy alone", () => {

        const requirements = path.join(folder, "requirements.md");
        const design = path.join(folder, "design.md");

        fs.writeFileSync(requirements, "R", "utf8");
        fs.writeFileSync(design, "D", "utf8");

        snapshot(folder, root, requirements);
        snapshot(folder, root, design);
        snapshot(folder, root, requirements, Date.parse("2026-09-09T10:00:00Z"));

        expect(baseline(folder, root, design)).toBe("D");
        expect(stored("design")).toHaveLength(1);
    });

    it("clears every copy this workspace put aside", () => {

        const requirements = path.join(folder, "requirements.md");
        const design = path.join(folder, "design.md");

        fs.writeFileSync(requirements, "R", "utf8");
        fs.writeFileSync(design, "D", "utf8");

        snapshot(folder, root, requirements);
        snapshot(folder, root, design);

        expect(clearHistory(root)).toBe(2);
        expect(baseline(folder, root, requirements)).toBeUndefined();
        expect(baseline(folder, root, design)).toBeUndefined();
    });

    it("clears nothing, and says so, when there is no history", () => {

        expect(clearHistory(root)).toBe(0);
    });
});
