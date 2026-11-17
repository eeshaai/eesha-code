import { describe, expect, it } from "vitest";
import { secretNamesOf } from "../secretNames";

// A plugin whose credential sits under a name the workflow chooses
// would otherwise have to read `process.env` behind the declaration's
// back, so `secrets` would list one thing while the plugin read
// another.
describe("secretNamesOf", () => {

    it("is just the declared list when nothing names another", () => {

        expect(secretNamesOf({ secrets: ["A", "B"] }, {})).toEqual(["A", "B"]);
    });

    it("is empty for a plugin that declares nothing", () => {

        expect(secretNamesOf({}, {})).toEqual([]);
    });

    it("adds the variable an input names", () => {

        expect(secretNamesOf({ secretsFrom: "patEnv" }, { patEnv: "ADO_PAT" }))
            .toEqual(["ADO_PAT"]);
    });

    // The host applies the schema's default before a plugin ever runs, so
    // by the time this is asked the default *is* the value.
    it("keeps a declared name alongside a chosen one", () => {

        expect(secretNamesOf({ secrets: ["OTHER"], secretsFrom: "patEnv" }, { patEnv: "ADO_PAT" }))
            .toEqual(["OTHER", "ADO_PAT"]);
    });

    it("does not list the same variable twice", () => {

        expect(secretNamesOf({ secrets: ["ADO_PAT"], secretsFrom: "patEnv" }, { patEnv: "ADO_PAT" }))
            .toEqual(["ADO_PAT"]);
    });

    // Silence rather than a guess: the plugin's own "that variable is not
    // set" is the better error, and it names the variable.
    it("says nothing extra when the input is missing, empty, or not a string", () => {

        expect(secretNamesOf({ secretsFrom: "patEnv" }, {})).toEqual([]);
        expect(secretNamesOf({ secretsFrom: "patEnv" }, { patEnv: "" })).toEqual([]);
        expect(secretNamesOf({ secretsFrom: "patEnv" }, { patEnv: 42 })).toEqual([]);
    });
});
