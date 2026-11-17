import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lastAccount, rememberAccount } from "../accountCache";
import type { AccountUsage } from "../../models/run";

/* The last account usage each runtime reported, kept in one file. */

let dir: string;
let file: string;

beforeEach(async () => {

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "account-cache-"));
    file = path.join(dir, "nested", "usage.json");
});

afterEach(async () => {

    await fs.rm(dir, { recursive: true, force: true });
});

function account(at: number, value: string): AccountUsage {

    return { at, rows: [{ key: "Credits used", value }] };
}

describe("the account cache", () => {

    it("has nothing before anything is kept, and never throws on a missing file", async () => {

        expect(await lastAccount("kiro-cli-v3", file)).toBeUndefined();
    });

    it("keeps each runtime's own, stamped with the runtime", async () => {

        await rememberAccount("kiro-cli-v3", account(10, "5"), file);
        await rememberAccount("kiro-cli", account(20, "7"), file);

        expect(await lastAccount("kiro-cli-v3", file)).toEqual({ ...account(10, "5"), runtime: "kiro-cli-v3" });
        expect(await lastAccount("kiro-cli", file)).toEqual({ ...account(20, "7"), runtime: "kiro-cli" });
    });

    it("replaces with a newer answer, and never puts an older one back", async () => {

        await rememberAccount("kiro-cli-v3", account(20, "new"), file);
        await rememberAccount("kiro-cli-v3", account(10, "old"), file);

        expect((await lastAccount("kiro-cli-v3", file))?.rows[0].value).toBe("new");

        await rememberAccount("kiro-cli-v3", account(30, "newer"), file);

        expect((await lastAccount("kiro-cli-v3", file))?.rows[0].value).toBe("newer");
    });

    it("reads a broken file as empty, and writes over it", async () => {

        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "{ not json", "utf8");

        expect(await lastAccount("kiro-cli-v3", file)).toBeUndefined();

        await rememberAccount("kiro-cli-v3", account(1, "5"), file);

        expect((await lastAccount("kiro-cli-v3", file))?.rows[0].value).toBe("5");
    });
});
