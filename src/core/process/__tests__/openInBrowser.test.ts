import { describe, expect, it } from "vitest";

import { isWebAddress, openInBrowser } from "../openInBrowser";

/* Only web pages are opened in the browser: anything else could start a program on this machine. */
describe("openInBrowser", () => {

    it("takes http and https addresses only", () => {

        expect(isWebAddress("https://login.test/authorize?client_id=c&state=s")).toBe(true);
        expect(isWebAddress("http://127.0.0.1:4100/?key=k")).toBe(true);

        expect(isWebAddress("file:///C:/Windows/notepad.exe")).toBe(false);
        expect(isWebAddress("ms-settings:privacy")).toBe(false);
        expect(isWebAddress("javascript:alert(1)")).toBe(false);
        expect(isWebAddress("not a link")).toBe(false);
        expect(isWebAddress(undefined)).toBe(false);
    });

    it("refuses anything else without starting a program", () => {

        expect(openInBrowser("file:///C:/Windows/notepad.exe")).toBe(false);
    });
});
