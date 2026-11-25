import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginDatabase } from "../PluginDatabase";

let dir: string;
let database: PluginDatabase;

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-plugin-db-"));
    database = new PluginDatabase(path.join(dir, "plugins"));
});

afterEach(() => {

    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("PluginDatabase", () => {

    it("gives a plugin tables that persist, in a file named after it", async () => {

        const db = database.for("greet");

        await db.run("CREATE TABLE greetings (id INTEGER PRIMARY KEY, name TEXT)");

        const inserted = await db.run("INSERT INTO greetings (name) VALUES (?)", ["World"]);

        expect(inserted.changes).toBe(1);
        expect(await db.get("SELECT name FROM greetings WHERE id = ?", [inserted.lastInsertRowid])).toEqual({ name: "World" });
        expect(await db.all("SELECT name FROM greetings")).toEqual([{ name: "World" }]);
        expect(fs.existsSync(path.join(dir, "plugins", "greet.db"))).toBe(true);
    });

    it("binds named params from an object", async () => {

        const db = database.for("greet");

        await db.run("CREATE TABLE t (a TEXT, b INTEGER)");
        await db.run("INSERT INTO t (a, b) VALUES ($a, $b)", { $a: "x", $b: 2 });

        expect(await db.get("SELECT a, b FROM t")).toEqual({ a: "x", b: 2 });
    });

    it("keeps two plugins apart - one cannot see the other's tables", async () => {

        await database.for("one").run("CREATE TABLE secrets (v TEXT)");

        await expect(database.for("two").all("SELECT * FROM secrets")).rejects.toThrow(/no such table/);
    });

    it("refuses a name that is not a plugin id, so a path cannot be smuggled in", () => {

        expect(() => database.pathFor("../run")).toThrow(/not a plugin id/);
    });

    it("surfaces a bad statement as a rejection, not a crash", async () => {

        await expect(database.for("greet").run("NOT SQL")).rejects.toThrow();
    });
});
