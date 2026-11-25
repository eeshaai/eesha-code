// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import type { ChatStore } from "../../chat/chatStore";
import { folderKey, mainFolderOf, newestAt, placeKey, type Workspace, workspaceKey } from "../protocol";
import { archiveWorkspace, newWorkspaceId, readWorkspaces, removeWorkspace, saveWorkspace, sessionFolders, sessionWorkspace, workspaceAt, workspaceByKey, WORKSPACES_KEY } from "../workspaces";
import { pickedWorkspace, sddPlace } from "../../web/workspacePick";

/*
 * Workspaces: how they are found and kept, and the SDD folder is the
 * main folder. Also which workspace the SDD panel shows.
 */

/** A store in memory, as the server's FileStore acts. */
function memoryStore(start: Record<string, unknown> = {}): ChatStore & { values: Record<string, unknown> } {

    const values: Record<string, unknown> = { ...start };

    return {
        values,
        get: <T>(key: string) => values[key] as T | undefined,
        update: (key: string, value: unknown) => {

            if (value === undefined)
                delete values[key];
            else
                values[key] = value;

            return Promise.resolve();
        }
    };
}

const API = "C:\\work\\api";
const SHARED = "C:\\work\\shared";
const WEB = "C:\\work\\web";

describe("finding a workspace by its main folder", () => {

    it("finds it by any spelling of the folder, and gives a session its folders", async () => {

        const store = memoryStore();

        await saveWorkspace(store, { name: "Backend", folders: [API, SHARED], runtime: "claude", model: "opus" });

        expect(workspaceAt(store, "c:/work/API/")?.folders[0]).toBe(API);
        expect(workspaceKey(workspaceAt(store, API)!)).toBe(folderKey(API));
        expect(sessionFolders(API, workspaceAt(store, API))).toEqual([API, SHARED]);
    });

    it("keeps the list in the store, empty, when the last one is removed", async () => {

        const store = memoryStore();

        await saveWorkspace(store, { name: "api", folders: [API] });
        await removeWorkspace(store, folderKey(API));

        expect(store.values[WORKSPACES_KEY]).toEqual({});
        expect(readWorkspaces(store)).toEqual([]);
    });
});

describe("the SDD folder", () => {

    it("is always the main folder", () => {

        expect(mainFolderOf({ folders: [API, SHARED] })).toBe(API);
    });

    it("is the main folder in the SDD panel's place", () => {

        const store = memoryStore({ [WORKSPACES_KEY]: { [folderKey(API)]: { name: "api", folders: [API] } } });

        expect(sddPlace(workspaceAt(store, API)!)).toEqual({ key: folderKey(API), name: "api", mainFolder: API });
    });
});

describe("a workspace's effort, temp folder and linked work item", () => {

    it("are read back as saved", async () => {

        const store = memoryStore();
        const saved: Workspace = {
            name: "12345 Login fails", folders: [API], runtime: "claude", model: "opus", effort: "high", tempFolder: true,
            link: { connector: "ado", kind: "workitem", id: "12345", title: "Login fails", path: ["ado", "workitems", "12345"], url: "https://dev.azure.com/x" }
        };

        await saveWorkspace(store, saved);

        expect(workspaceAt(store, API)).toEqual(saved);
    });

    it("are dropped when of the wrong shape, and the workspace stays", () => {

        const store = memoryStore({
            [WORKSPACES_KEY]: {
                [folderKey(API)]: { name: "api", folders: [API], effort: "high", tempFolder: "yes", link: { connector: "jira", name: "x" } }
            }
        });

        // The effort goes too: it came without a model.
        expect(workspaceAt(store, API)).toEqual({ name: "api", folders: [API] });
    });
});

describe("the workspace the SDD panel shows", () => {

    const api: Workspace = { name: "api", folders: [API] };
    const web: Workspace = { name: "Web", folders: [WEB] };

    it("is the one picked, else the session's own, else the first A to Z", () => {

        expect(pickedWorkspace([web, api], folderKey(WEB), API)).toBe(web);
        expect(pickedWorkspace([web, api], undefined, "c:/work/web")).toBe(web);
        expect(pickedWorkspace([web, api], undefined, "D:\\Elsewhere")).toBe(api);
        expect(pickedWorkspace([web, api], "gone", undefined)).toBe(api);
        expect(pickedWorkspace([], undefined, API)).toBeUndefined();
    });
});

describe("more than one workspace on a folder - one per work item", () => {

    const first: Workspace = { name: "12 Login page", folders: [API], created: 1 };
    const second: Workspace = { id: `${folderKey(API)}::b`, name: "13 Logout", folders: [API], created: 2 };

    it("gives the first workspace on a folder the folder's own key, and the next one a key of its own", async () => {

        const store = memoryStore();

        expect(newWorkspaceId(store, API, 1)).toBeUndefined();

        await saveWorkspace(store, first);

        const id = newWorkspaceId(store, API, 36);

        expect(id).toBe(`${folderKey(API)}::10`);

        await saveWorkspace(store, { ...second, id: id! });

        // Same time again: still a key of its own.
        expect(newWorkspaceId(store, API, 36)).toBe(`${folderKey(API)}::10-1`);
        expect(readWorkspaces(store).map(workspaceKey).sort()).toEqual([folderKey(API), id].sort());
    });

    it("starts a session from the folder in its newest workspace that is not archived", async () => {

        const store = memoryStore();

        await saveWorkspace(store, first);
        await saveWorkspace(store, second);

        expect(workspaceAt(store, API)?.name).toBe("13 Logout");

        await archiveWorkspace(store, workspaceKey(second), true);

        expect(workspaceAt(store, API)?.name).toBe("12 Login page");
        expect(newestAt([], API)).toBeUndefined();
    });

    it("keeps a session in the workspace it started in, and one with no workspace in the folder's newest", async () => {

        const store = memoryStore();

        await saveWorkspace(store, first);
        await saveWorkspace(store, second);

        expect(sessionWorkspace(store, folderKey(API), API)?.name).toBe("12 Login page");
        expect(sessionWorkspace(store, undefined, API)?.name).toBe("13 Logout");

        // Its workspace was removed: the folder's newest.
        await removeWorkspace(store, folderKey(API));

        expect(sessionWorkspace(store, folderKey(API), API)?.name).toBe("13 Logout");
    });

    it("archives and brings back a workspace by its key, and says when there is none", async () => {

        const store = memoryStore();

        await saveWorkspace(store, second);

        expect(await archiveWorkspace(store, workspaceKey(second), true)).toBe(true);
        expect(workspaceByKey(store, workspaceKey(second))?.archived).toBe(true);

        expect(await archiveWorkspace(store, workspaceKey(second), false)).toBe(true);
        expect(workspaceByKey(store, workspaceKey(second))?.archived).toBeUndefined();

        expect(await archiveWorkspace(store, "d:\\nowhere", true)).toBe(false);
    });

    it("lists a session under the workspace it started in, else under No workspace - whatever its folders", () => {

        expect(placeKey({ workspace: workspaceKey(second) })).toBe(workspaceKey(second));
        expect(placeKey({})).toBe("");
    });

    it("shows in SDD the session's own workspace, and never an archived one", () => {

        const list = [first, second];

        expect(pickedWorkspace(list, undefined, API, folderKey(API))?.name).toBe("12 Login page");
        expect(pickedWorkspace(list, undefined, API)?.name).toBe("13 Logout");
        expect(pickedWorkspace([first, { ...second, archived: true }], workspaceKey(second), API)?.name).toBe("12 Login page");
    });
});
