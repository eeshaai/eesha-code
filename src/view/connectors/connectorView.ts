/*
 * What the Connectors page shows: the access of each source grouped by
 * level, the choices a source offers, and the Connect window's boxes
 * with their counts. No React here, so it is tested on its own.
 */

export type Access = "off" | "read" | "write";

/** Most access first. */
const LEVELS: readonly Access[] = ["write", "read", "off"];

/** The sources grouped by what the agent may do with them, most first. Levels with no source are left out. A source with no access counts as off. */
export function accessGroups(sources: readonly { label: string; access: Access | undefined }[]): { access: Access; labels: string[] }[] {

    return LEVELS
        .map(level => ({ access: level, labels: sources.filter(one => (one.access ?? "off") === level).map(one => one.label) }))
        .filter(group => group.labels.length > 0);
}

/** The choices a source offers: a read-only source has no "write". */
export function accessOptions(readOnly: boolean | undefined): Access[] {

    return readOnly ? ["off", "read"] : ["off", "read", "write"];
}

/** A group of the Connect window, as the server offers it. */
export interface OfferedGroupLike {

    name: string;

    items: readonly string[];
}

/** Lines in no group, with their boxes. */
export function looseLines(loose: readonly string[], ticked: ReadonlySet<string>): { name: string; checked: boolean }[] {

    return loose.map(name => ({ name, checked: ticked.has(name) }));
}

/**
 * The groups with their boxes and counts. With `ownerCoversAll` (a GitHub
 * owner) a group's own box is a line of its own that covers all its items,
 * also ones made later. Otherwise it ticks all its items, or none (an ADO
 * organization).
 */
export function connectorGroups(groups: readonly OfferedGroupLike[], ticked: ReadonlySet<string>, ownerCoversAll: boolean, kind: string) {

    return groups.map(group => {

        const owner = ownerCoversAll && ticked.has(group.name);
        const count = group.items.filter(item => ticked.has(item)).length;
        const all = group.items.length > 0 && count === group.items.length;

        return {
            name: group.name,
            checked: ownerCoversAll ? owner : all,
            partly: !owner && !all && count > 0,
            note: owner ? `all ${kind}, also new ones` : `${count} of ${group.items.length} ${kind}`,
            items: group.items.map(item => ({ name: item, checked: owner || ticked.has(item), disabled: owner }))
        };
    });
}
