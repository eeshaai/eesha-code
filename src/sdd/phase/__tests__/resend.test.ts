import { beforeEach, describe, expect, it } from "vitest";
import { attachmentsToSend, forgetAll, recordSent } from "../resend";

/*
 * A revise carries on the phase's conversation. Sending every file again
 * stacked another copy of each into the context on every pass - only the
 * ones that changed since the conversation last saw them go again.
 */

const grammar = { name: "grammar", path: "/style/grammar.md" };
const how = { name: "how", path: "/style/how.md" };
const current = { name: "current", path: "/spec/design.md" };

/** A fingerprint that is just the content the test says a file has. */
function disk(files: Record<string, string | undefined>) {

    return (path: string) => files[path];
}

describe("which files a continued conversation is sent", () => {

    beforeEach(() => forgetAll());

    it("sends everything on a new conversation", () => {

        expect(attachmentsToSend(undefined, [grammar, how, current], disk({}))).toEqual([grammar, how, current]);
    });

    it("sends everything when this window never saw the conversation", () => {

        expect(attachmentsToSend("s1", [grammar, how], disk({}))).toEqual([grammar, how]);
    });

    it("sends only the files that changed since the last turn", () => {

        const before = disk({ [grammar.path]: "g", [how.path]: "h", [current.path]: "draft 1" });

        recordSent("s1", [grammar, how, current], before);

        const after = disk({ [grammar.path]: "g", [how.path]: "h", [current.path]: "draft 2" });

        expect(attachmentsToSend("s1", [grammar, how, current], after)).toEqual([current]);
    });

    it("sends a file it cannot read, and one it has never sent", () => {

        recordSent("s1", [grammar], disk({ [grammar.path]: "g" }));

        expect(attachmentsToSend("s1", [grammar, how], disk({ [how.path]: "h" }))).toEqual([grammar, how]);
    });

    it("keeps each conversation's record apart", () => {

        const same = disk({ [grammar.path]: "g" });

        recordSent("s1", [grammar], same);

        expect(attachmentsToSend("s2", [grammar], same)).toEqual([grammar]);
        expect(attachmentsToSend("s1", [grammar], same)).toEqual([]);
    });
});
