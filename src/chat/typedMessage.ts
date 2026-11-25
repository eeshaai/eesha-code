import { AgentAttachment, AgentMessage } from "../core/agent";
import { mentionedSteering, unknownMentions } from "../core/agent/steering/steering";
import { loadEngineSettings } from "../core/settings/engineSettings";

/**
 * A message a person typed into a compose box, ready for
 * `session.send`: the text as typed, plus the `manual` steering files it
 * names as `@name`, for this message only.
 *
 * For the compose boxes that send straight into a running session.
 * The ones that go through `ai@1` get the same from the plugin.
 *
 * Only the text while the `steering` feature flag is off.
 *
 * @param folders Every folder to look for steering files in.
 * @param settingsFolder Where settings.json is read beside the
 *                       profile's - nothing for the profile's only.
 * @returns `note`, when a `@name` matched no file, for the log.
 */
export async function typedMessageIn(text: string, folders: readonly string[], settingsFolder: string | undefined): Promise<{
    message: AgentMessage;

    /** The steering files attached, for the log line. Empty for none. */
    attachments: AgentAttachment[];

    note?: string;
}> {

    if (!await steeringOn(settingsFolder))
        return { message: { prompt: text }, attachments: [] };

    const { attachments, unknown } = await mentionedSteering(text, [...folders]);

    return {
        message: { prompt: text, ...(attachments.length ? { attachments } : {}) },
        attachments,
        note: unknownMentions(unknown)
    };
}

/** The `steering` flag, off when the settings cannot be read. */
async function steeringOn(settingsFolder: string | undefined): Promise<boolean> {

    try {

        return (await loadEngineSettings(settingsFolder)).features.steering;

    } catch {

        return false;
    }
}

/**
 * A typed message with the files attached in the compose box added to
 * its attachments - after the `@name` steering files, and each file once.
 * The log line shows them all.
 */
export function withSentFiles<T extends { message: AgentMessage; attachments: AgentAttachment[] }>(
    typed: T,
    files: readonly AgentAttachment[]
): T {

    if (!files.length)
        return typed;

    const seen = new Set(typed.attachments.map(one => one.path.toLowerCase()));
    const attachments = [...typed.attachments, ...files.filter(one => !seen.has(one.path.toLowerCase()))];

    return { ...typed, message: { ...typed.message, attachments }, attachments };
}
