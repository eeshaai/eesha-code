import { eeshaPath, readJson } from "../paths";
import type { ConnectorAccess, MemoryChoices } from "../protocol";
import { editSettingsJson } from "../settingsPage";

/*
 * What the person chose for memory, kept in ~/.eesha/settings.json:
 *
 *   "eesha": { "memory": { "access": "write", "askOnSave": false, "claudeMemoryOff": true } }
 *
 * With no entry, memory is on with read and write, the AI's saves do not
 * ask, and Claude's own memory has not been turned off yet.
 */

const ACCESS: readonly ConnectorAccess[] = ["off", "read", "write"];

export const DEFAULT_MEMORY: MemoryChoices = { access: "write", askOnSave: false, claudeMemoryOff: false };

/** The `eesha.memory` block of a settings file's JSON. A value of the wrong shape takes its default. */
export function memoryFrom(json: unknown): MemoryChoices {

    const block = json && typeof json === "object" ? (json as Record<string, unknown>).eesha : undefined;
    const own = block && typeof block === "object" ? (block as Record<string, unknown>).memory : undefined;

    if (!own || typeof own !== "object" || Array.isArray(own))
        return { ...DEFAULT_MEMORY };

    const { access, askOnSave, claudeMemoryOff } = own as Record<string, unknown>;

    return {
        access: ACCESS.includes(access as ConnectorAccess) ? access as ConnectorAccess : DEFAULT_MEMORY.access,
        askOnSave: typeof askOnSave === "boolean" ? askOnSave : DEFAULT_MEMORY.askOnSave,
        claudeMemoryOff: typeof claudeMemoryOff === "boolean" ? claudeMemoryOff : DEFAULT_MEMORY.claudeMemoryOff
    };
}

/** The choices in ~/.eesha/settings.json now. */
export function readMemoryChoices(file: string = eeshaPath("settings.json")): MemoryChoices {

    return memoryFrom(readJson(file));
}

/** Checks a change the page sent: only the three known values, each of its own kind. */
export function checkMemoryChange(value: unknown): { change: Partial<MemoryChoices> } | { problem: string } {

    if (!value || typeof value !== "object" || Array.isArray(value))
        return { problem: "Send the memory choices to change." };

    const { access, askOnSave, claudeMemoryOff } = value as Record<string, unknown>;
    const change: Partial<MemoryChoices> = {};

    if (access !== undefined) {

        if (!ACCESS.includes(access as ConnectorAccess))
            return { problem: "Memory access must be off, read or write." };

        change.access = access as ConnectorAccess;
    }

    if (askOnSave !== undefined) {

        if (typeof askOnSave !== "boolean")
            return { problem: "Send the ask-before-saving choice as true or false." };

        change.askOnSave = askOnSave;
    }

    if (claudeMemoryOff !== undefined) {

        if (typeof claudeMemoryOff !== "boolean")
            return { problem: "Send the Claude memory choice as true or false." };

        change.claudeMemoryOff = claudeMemoryOff;
    }

    return { change };
}

/** Writes a change into `eesha.memory`, keeping what it does not name. */
export function saveMemoryChoices(change: Partial<MemoryChoices>): Promise<{ problem: string } | { ok: true }> {

    return editSettingsJson(json => {

        const eesha = json.eesha && typeof json.eesha === "object" && !Array.isArray(json.eesha)
            ? { ...json.eesha as Record<string, unknown> }
            : {};

        eesha.memory = { ...memoryFrom(json), ...change };
        json.eesha = eesha;

        return undefined;
    });
}
