/**
 * `elicitation/create`, answered by asking a person.
 *
 * It is the only way an ACP agent, or an MCP server behind one, can ask
 * a question (`session/request_permission` returns an option id, not an
 * answer). Copilot relays MCP server elicitations the same way, so both
 * providers use this file.
 *
 * A schema is read for the three shapes the panel draws, the same three
 * the `ask_user` tool takes:
 *
 *   - Pick one: a `string` with `enum` or `oneOf`.
 *   - Pick several: an `array` with `items.enum` or `items.anyOf`.
 *   - Free text: a `string` with neither.
 *
 * Anything else (numbers, booleans, formats, `url` mode) is declined.
 * ACP says a client that does not understand a mode or type MUST NOT
 * render it as a known control.
 *
 * A form is answered field by field, in schema order.
 */

import { AskOption } from "../../models/run";
import { AskHook, AskRequest } from "../AgentSession";

/** ACP's `CreateElicitationRequest`, narrowed to the fields this file reads. */
export interface AcpElicitationRequest {

    /** What the agent needs, in words. Required by the protocol. */
    message?: string;

    /** `form`, `url`, or something this build has never seen. */
    mode?: string;

    /** `mode: "form"` only. */
    requestedSchema?: AcpElicitationSchema;
}

/** ACP's `ElicitationSchema` - a JSON Schema object whose properties are all primitives. */
export interface AcpElicitationSchema {

    title?: string | null;

    description?: string | null;

    properties?: Record<string, AcpPropertySchema>;

    required?: string[] | null;
}

/** ACP's `ElicitationPropertySchema`, flattened to the fields this file reads. */
export interface AcpPropertySchema {

    type?: string;

    title?: string | null;

    description?: string | null;

    /** Single-select, untitled - `StringPropertySchema.enum`. */
    enum?: string[] | null;

    /**
     * Labels for {@link enum}, position by position - Copilot's spelling
     * of what ACP says with `oneOf`. A value with no name shows as itself.
     */
    enumNames?: string[] | null;

    /** Single-select, titled - `StringPropertySchema.oneOf`. */
    oneOf?: AcpEnumOption[] | null;

    /** Multi-select - `MultiSelectPropertySchema.items`, in either spelling. */
    items?: { enum?: string[] | null; anyOf?: AcpEnumOption[] | null };
}

/** ACP's `EnumOption`: the value that goes on the wire, and the words a person reads. */
export interface AcpEnumOption {

    const?: string;

    title?: string;

    description?: string | null;
}

/** One field's answer. Only the two shapes this file can produce. */
export type AcpContentValue = string | string[];

/** ACP's `CreateElicitationResponse`. `accept` is the only action that carries anything. */
export type AcpElicitationResponse =
    | { action: "accept"; content: Record<string, AcpContentValue> }
    | { action: "decline" }
    | { action: "cancel" };

/**
 * What we tell the agent we can do, on `initialize`. `form` only:
 * leaving a capability out tells the agent not to send that mode.
 */
export const ELICITATION_CAPABILITIES = { form: {} };

/**
 * The elicitation, asked and answered.
 *
 * Never throws: every failure comes back as a `decline` or a `cancel`,
 * which the agent must handle. A thrown error would go back over the
 * connection as a JSON-RPC failure.
 *
 * @param ask    How to put one question to the session and wait. Absent
 *               means nobody is watching - see `config.interactive`.
 * @param signal The agent's own signal for this request. It fires when
 *               the agent gives up on the question, so the open box is
 *               closed.
 */
export async function askElicitation(
    request: AcpElicitationRequest,
    ask?: AskHook,
    signal?: AbortSignal
): Promise<AcpElicitationResponse> {

    if (!ask)
        return { action: "decline" };

    const fields = readFields(request);

    if (!fields)
        return { action: "decline" };

    const content: Record<string, AcpContentValue> = {};

    for (const field of fields) {

        let answer: string;

        try {

            // eslint-disable-next-line no-await-in-loop
            answer = await withSignal(ask(field.request).answer, signal);

        } catch {

            // The session ended, the turn was abandoned, or the agent
            // gave up on the question while the box was still open.
            return { action: "cancel" };
        }

        content[field.key] = valueOf(answer, field);
    }

    return { action: "accept", content };
}

/** The answer, or a rejection the moment the agent's own signal fires. */
function withSignal(answer: Promise<string>, signal?: AbortSignal): Promise<string> {

    if (!signal)
        return answer;

    if (signal.aborted)
        return Promise.reject(new Error("The elicitation was cancelled."));

    return new Promise<string>((resolve, reject) => {

        const onAbort = () => reject(new Error("The elicitation was cancelled."));

        signal.addEventListener("abort", onAbort, { once: true });

        answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

/** One form field, ready to ask about. */
interface Field {

    key: string;

    /** True for an `array` field - the answer goes back as a list. */
    multi: boolean;

    /** The choices offered, by the label a person picks - empty for a free-text field. */
    values: Map<string, string>;

    request: AskRequest;
}

/** The request as a list of questions, or nothing when it is a shape this file does not render. */
function readFields(request: AcpElicitationRequest): Field[] | undefined {

    if (request.mode !== "form")
        return undefined;

    const properties = request.requestedSchema?.properties;

    if (!properties || !Object.keys(properties).length)
        return undefined;

    const message = (request.message ?? "").trim();

    const fields: Field[] = [];

    for (const [key, property] of Object.entries(properties)) {

        const type = property.type ?? "";

        // Any other type is a control the panel does not draw, and ACP
        // forbids guessing.
        if (type !== "string" && type !== "array")
            return undefined;

        const multi = type === "array";

        const values = choicesOf(property, multi);

        // An array with no choices would be a free-text box whose answer
        // must come back as a list. Decline rather than invent a
        // separator.
        if (multi && !values.size)
            return undefined;

        const label = (property.title ?? "").trim()
            || (property.description ?? "").trim()
            || key;

        // The agent's own sentence, once, above the first field.
        const prompt = fields.length === 0 && message ? `${message}\n${label}` : label;

        fields.push({
            key,
            multi,
            values,
            request: {
                prompt,
                ...(values.size ? { options: optionsOf(property, multi, values) } : {}),
                ...(multi ? { multi: true } : {}),
                raw: request
            }
        });
    }

    return fields;
}

/**
 * A field's choices as label to wire value.
 *
 * `enum` is a bare list of values; `oneOf` (`items.anyOf` for a
 * multi-select) pairs each value with a label. The panel shows a label
 * and hands back a label (see `resolveAnswer` in the chat view), and
 * the wire wants the value behind it.
 */
function choicesOf(property: AcpPropertySchema, multi: boolean): Map<string, string> {

    const values = new Map<string, string>();

    const titled = multi ? property.items?.anyOf : property.oneOf;

    for (const option of titled ?? [])
        if (typeof option.const === "string")
            values.set((option.title ?? "").trim() || option.const, option.const);

    if (values.size)
        return values;

    const bare = multi ? property.items?.enum : property.enum;

    // `enumNames` is Copilot's parallel-array spelling of a label. A
    // missing, blank or non-string name leaves the value as its own
    // label.
    const names = multi ? undefined : property.enumNames;

    (bare ?? []).forEach((value, index) => {

        if (typeof value !== "string")
            return;

        const name = names?.[index];

        values.set(typeof name === "string" && name.trim() ? name.trim() : value, value);
    });

    return values;
}

/** The same choices as the event carries them - the label, and the agent's own words under it. */
function optionsOf(property: AcpPropertySchema, multi: boolean, values: Map<string, string>): AskOption[] {

    const titled = multi ? property.items?.anyOf : property.oneOf;

    const described = new Map<string, string>();

    for (const option of titled ?? [])
        if (typeof option.const === "string" && (option.description ?? "").trim())
            described.set(option.const, option.description!.trim());

    return [...values].map(([label, value]) => ({
        label,
        ...(described.has(value) ? { description: described.get(value)! } : {})
    }));
}

/**
 * One answer in the shape its field asked for. A picked choice comes
 * back as its label, so the label is looked up first; raw text is the
 * fallback for a person who typed their own answer.
 */
function valueOf(answer: string, field: Field): AcpContentValue {

    const text = answer.trim();

    if (!field.multi)
        return field.values.get(text) ?? text;

    // Multiple picks arrive as labels joined with ", " - see
    // `resolveAnswer`. Anything that is not a known label is sent as
    // typed.
    return text
        .split(",")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => field.values.get(part) ?? part);
}
