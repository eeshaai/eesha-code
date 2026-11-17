import React, { useEffect, useState } from "react";

import { ACP_LEVEL_NOTE, ACP_LEVELS, LEVEL_NAMES, levelHint, type PermissionLevel, SDK_LEVELS } from "../core/models/permissionCard";
import { runtimeLabel } from "../view/ChatView";
import { type ProviderPart, StartPage as LibraryStartPage } from "../view/ui";
import { type AiOptions, API, type Workspace } from "../server/protocol";
import { bridge } from "./bridge";

/*
 * The runtime, model and Permissions pickers of a start box - the start
 * page's and a workspace page's. Each shows the default (the workspace's
 * saved runtime and model, else the server's runtime) until picked by
 * hand. Asks the server once for the runtimes and models.
 */

/**
 * What the start box's pickers send with a new session - see
 * `API.newSession`. `runtime` and `model` only when picked by hand;
 * `level` only when it differs from the runtime's level now.
 */
export interface StartPickBody {

    runtime?: string;

    model?: string;

    level?: { runtime: string; level: string };
}

/** The Permissions picker's props, as the library's start box takes them. */
export type StartPermission = React.ComponentProps<typeof LibraryStartPage>["permission"];

/** The pickers, and what they send. */
export interface StartPicks {

    /** The runtime and model pickers. Empty until the server said what it offers. */
    parts: ProviderPart[];

    /** The Permissions picker. None until known. */
    permission: StartPermission;

    /** What a new session is sent: nothing when the pickers still show the defaults. */
    pickBody(): StartPickBody | undefined;

    /** The server said what it offers. */
    ready: boolean;
}

/** The model a runtime picks for itself. */
const AUTO_MODEL = "auto";

/**
 * The pickers of a start box. `saved`: the workspace a new session goes
 * in, for its saved runtime and model.
 */
export function useStartPicks(saved: Pick<Workspace, "runtime" | "model"> | undefined): StartPicks {

    const [options, setOptions] = useState<AiOptions | undefined>();
    const [runtimePick, setRuntimePick] = useState<string | undefined>();
    const [modelPick, setModelPick] = useState<string | undefined>();
    const [levelPicks, setLevelPicks] = useState<Record<string, string>>({});

    useEffect(() => {

        let live = true;

        void bridge.request<AiOptions>(API.aiOptions, {}).then(answer => {

            if (live && Array.isArray(answer.runtimes))
                setOptions(answer);

        }).catch(() => undefined);

        return () => { live = false; };
    }, []);

    const runtime = runtimePick ?? saved?.runtime ?? options?.defaultRuntime ?? options?.runtimes[0];

    // The workspace's saved model goes with its saved runtime only.
    const savedModel = !runtimePick && saved?.runtime === runtime ? saved?.model : undefined;
    const model = modelPick ?? savedModel ?? AUTO_MODEL;

    const levelNow = runtime ? options?.levels?.[runtime] : undefined;
    const level = runtime ? levelPicks[runtime] ?? levelNow?.level : undefined;

    const parts: ProviderPart[] = [];

    if (options && runtime) {

        const runtimes = options.runtimes.includes(runtime) ? options.runtimes : [runtime, ...options.runtimes];
        const listed = options.models[runtime] ?? [];

        parts.push({
            id: "runtime",
            title: "Runtime",
            options: runtimes.map(id => ({ id, name: runtimeLabel(id) })),
            value: runtime,
            onChange: id => { if (id !== runtime) { setRuntimePick(id); setModelPick(undefined); } },
            picked: runtimePick !== undefined
        }, {
            id: "model",
            title: "Model",
            narrow: "cut",
            options: [{ id: AUTO_MODEL, name: AUTO_MODEL }, ...(model !== AUTO_MODEL && !listed.some(one => one.id === model) ? [{ id: model }] : []), ...listed]
                .filter((one, index, all) => all.findIndex(other => other.id === one.id) === index)
                .map(one => ({
                    id: one.id,
                    name: ("name" in one && one.name) || one.id,
                    ...("disabled" in one && one.disabled && one.id !== model ? { disabled: true, description: "Not enabled for your account" } : {})
                })),
            value: model,
            onChange: id => { if (id !== model) setModelPick(id); },
            allowCustom: true,
            picked: modelPick !== undefined
        });
    }

    const pickBody = (): StartPickBody | undefined => {

        if (!runtime)
            return undefined;

        const body: StartPickBody = {};

        if (runtimePick !== undefined || modelPick !== undefined) {

            body.runtime = runtime;

            if (model !== AUTO_MODEL)
                body.model = model;
        }

        if (level && levelNow && level !== levelNow.level)
            body.level = { runtime, level };

        return Object.keys(body).length ? body : undefined;
    };

    const permission: StartPermission = runtime && level && levelNow
        ? {
            levels: (levelNow.acp ? ACP_LEVELS : SDK_LEVELS).map(one => ({
                id: one,
                name: LEVEL_NAMES[one],
                hint: levelHint(one, levelNow.acp),
                note: levelNow.acp && (one === "agent" || one === "semi") ? ACP_LEVEL_NOTE : undefined
            })),
            value: level,
            title: `Permissions for ${runtimeLabel(runtime)}`,
            onChange: id => setLevelPicks(now => ({ ...now, [runtime]: id as PermissionLevel })),
            placement: "bottom",
            capitalizeNames: true,
            plain: true
        }
        : undefined;

    return { parts, permission, pickBody, ready: options !== undefined };
}
