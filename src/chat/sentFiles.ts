import * as fs from "fs/promises";
import * as path from "path";

import { AgentAttachment } from "../core/agent";
import { MAX_UPLOAD_BYTES, SentFile } from "../shared/composeFiles";

/*
 * The files a compose box sends with a message, made ready for the agent.
 *
 * The agent takes files by path only. A file picked with "/" already has
 * one. An uploaded file does not - the browser only has its bytes - so it
 * is saved under the folder the panel works in first
 * (`.eesha/attachments/`). Inside the workspace on purpose: the
 * agent can open it again with its own tools, and the permission check never
 * refuses it for being outside the allowed folders. The folder carries
 * its own `.gitignore`, so nothing saved there is ever committed.
 */

/**
 * The attachments for what a box sent, and a note for the log about any
 * file that could not be attached. A file that fails is left out; the
 * message still goes.
 *
 * @param root The folder "@" searched - a picked path is relative to it.
 * @param uploads Where an uploaded file is saved. Default:
 *                `<root>/.eesha/attachments`.
 * @param takeFolders A picked folder is kept, in `folders`, by its full
 *                path - the chat sends it as a line under the message,
 *                since an agent takes only files as attachments. Off: a
 *                folder is left out as "not a file".
 */
export async function resolveSentFiles(
    files: readonly SentFile[] | undefined,
    root: string,
    uploads: string = path.join(root, ".eesha", "attachments"),
    takeFolders = false
): Promise<{ attachments: AgentAttachment[]; folders: string[]; note?: string }> {

    const attachments: AgentAttachment[] = [];
    const folders: string[] = [];
    const problems: string[] = [];

    for (const file of files ?? []) {

        try {

            if (file.kind === "path") {

                const absolute = path.resolve(root, file.path);
                const stat = await fs.stat(absolute);

                if (takeFolders && stat.isDirectory()) {

                    if (!folders.includes(absolute))
                        folders.push(absolute);

                    continue;
                }

                if (!stat.isFile())
                    throw new Error("not a file");

                attachments.push({ path: absolute, name: file.name ?? path.basename(absolute) });

            } else {

                const bytes = Buffer.from(file.contentBase64, "base64");

                if (bytes.length > MAX_UPLOAD_BYTES)
                    throw new Error(`larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);

                attachments.push({ path: await saveUpload(uploads, file.name, bytes), name: file.name });
            }

        } catch (error) {

            problems.push(`${file.kind === "path" ? file.path : file.name} (${(error as Error).message})`);
        }
    }

    return {
        attachments,
        folders,
        ...(problems.length ? { note: `Not attached: ${problems.join(", ")}.` } : {})
    };
}

/**
 * Saves an uploaded file under `folder`, in a folder of its own per
 * upload so two files with one name never collide.
 */
async function saveUpload(folder: string, name: string, bytes: Buffer): Promise<string> {

    await fs.mkdir(folder, { recursive: true });

    // Written once, when the folder is first made: everything here is a
    // copy of something a person dropped in a chat, never source.
    const ignore = path.join(folder, ".gitignore");

    await fs.writeFile(ignore, "*\n", { flag: "wx" }).catch(() => undefined);

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const own = path.join(folder, `${stamp}-${Math.random().toString(36).slice(2, 6)}`);

    await fs.mkdir(own, { recursive: true });

    // Only the file name, whatever the browser sent - never a path.
    const safe = path.basename(name).replace(/[<>:"|?*\u0000-\u001f]/g, "_") || "file";
    const target = path.join(own, safe);

    await fs.writeFile(target, bytes);

    return target;
}
