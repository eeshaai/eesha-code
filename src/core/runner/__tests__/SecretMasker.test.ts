import { describe, expect, it } from "vitest";
import { SecretMasker } from "../SecretMasker";

describe("SecretMasker", () => {

    it("masks a secret contained in a single chunk", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.push("token=hunter2! ok\n")).toEqual(["token=*** ok"]);
    });

    it("masks a secret split across two push calls - neither chunk matches on its own", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.push("token=hun")).toEqual([]);

        expect(masker.push("ter2! ok\n")).toEqual(["token=*** ok"]);
    });

    it("masks a secret split across three push calls", () => {

        const masker = new SecretMasker();

        masker.register("supersecretvalue");

        masker.push("a=super");
        masker.push("secret");

        expect(masker.push("value\n")).toEqual(["a=***"]);
    });

    it("masks on the correct line when a secret spans a newline boundary", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        const lines = masker.push("first line\ntoken=hunter2!\nthird line\n");

        expect(lines).toEqual(["first line", "token=***", "third line"]);
    });

    it("does not mask across a newline - a value broken by a line break is not the secret", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.push("hunt\ner2!\n")).toEqual(["hunt", "er2!"]);
    });

    it("masks every occurrence of a secret in one line", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.push("hunter2! and hunter2! again\n")).toEqual(["*** and *** again"]);
    });

    it("masks multiple registered secrets appearing in one line", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");
        masker.register("swordfish");

        expect(masker.push("a=hunter2! b=swordfish\n")).toEqual(["a=*** b=***"]);
    });

    it("masks the longer secret whole when one secret contains another", () => {

        const masker = new SecretMasker();

        masker.register("abcd");
        masker.register("abcdefgh");

        expect(masker.push("x=abcdefgh\n")).toEqual(["x=***"]);
    });

    it("ignores a value shorter than the minimum length, so ordinary output is not redacted", () => {

        const masker = new SecretMasker();

        masker.register("ab");

        expect(masker.push("ab cd ab\n")).toEqual(["ab cd ab"]);
    });

    it("treats register(undefined) as a no-op", () => {

        const masker = new SecretMasker();

        masker.register(undefined);

        expect(masker.push("anything at all\n")).toEqual(["anything at all"]);
    });

    it("treats register of an empty string as a no-op", () => {

        const masker = new SecretMasker();

        masker.register("");

        expect(masker.push("anything at all\n")).toEqual(["anything at all"]);
    });

    it("emits a trailing line that never got a newline, on flush", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.push("token=hunter2!")).toEqual([]);

        expect(masker.flush()).toEqual(["token=***"]);
    });

    it("emits nothing on flush when the buffer is empty", () => {

        const masker = new SecretMasker();

        masker.push("done\n");

        expect(masker.flush()).toEqual([]);
    });

    it("clears the buffer after a flush, so a second flush repeats nothing", () => {

        const masker = new SecretMasker();

        masker.push("partial");

        expect(masker.flush()).toEqual(["partial"]);
        expect(masker.flush()).toEqual([]);
    });

    it("matches regex-special characters literally rather than as a pattern", () => {

        const masker = new SecretMasker();

        masker.register("a+b*c");

        expect(masker.push("value=a+b*c\n")).toEqual(["value=***"]);
    });

    it("does not treat a dot in a secret as a wildcard", () => {

        const masker = new SecretMasker();

        masker.register("x.y.z");

        expect(masker.push("first=xayaz second=x.y.z\n")).toEqual(["first=xayaz second=***"]);
    });

    it("masks a complete unit passed to mask(), e.g. an error message rather than a stream chunk", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.mask("Request failed for token hunter2!")).toBe("Request failed for token ***");
    });

    it("leaves text untouched when nothing is registered", () => {

        const masker = new SecretMasker();

        expect(masker.mask("nothing to hide")).toBe("nothing to hide");
    });

    it("registering the same value twice does not double-mask it", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");
        masker.register("hunter2!");

        expect(masker.push("t=hunter2!\n")).toEqual(["t=***"]);
    });

    it("strips a trailing carriage return's secret too, since Windows output arrives CRLF", () => {

        const masker = new SecretMasker();

        masker.register("hunter2!");

        expect(masker.push("token=hunter2!\r\n")).toEqual(["token=***\r"]);
    });

    describe("per-stream buffering", () => {

        it("never completes a half-written stdout line with the next stderr chunk", () => {

            const masker = new SecretMasker();

            expect(masker.push("out-partial", "stdout")).toEqual([]);

            // Without separate buffers this would emit "out-partialerr" as stderr.
            expect(masker.push("err\n", "stderr")).toEqual(["err"]);

            expect(masker.flush("stdout")).toEqual(["out-partial"]);
        });

        it("masks a secret split across two chunks of the same stream while another stream interleaves", () => {

            const masker = new SecretMasker();

            masker.register("hunter2!");

            expect(masker.push("token=hun", "stdout")).toEqual([]);
            expect(masker.push("warning\n", "stderr")).toEqual(["warning"]);
            expect(masker.push("ter2!\n", "stdout")).toEqual(["token=***"]);
        });

        it("flushes each stream independently", () => {

            const masker = new SecretMasker();

            masker.push("a", "stdout");
            masker.push("b", "stderr");

            expect(masker.flush("stdout")).toEqual(["a"]);
            expect(masker.flush("stdout")).toEqual([]);
            expect(masker.flush("stderr")).toEqual(["b"]);
        });
    });
});
