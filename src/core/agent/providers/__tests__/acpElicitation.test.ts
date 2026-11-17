import { describe, expect, it } from "vitest";

import { AcpElicitationRequest, askElicitation } from "../acpElicitation";
import { AskHook, AskRequest } from "../../AgentSession";

/**
 * A scripted answerer. Answers go out in order, one per question, and
 * every question asked is recorded so tests can check its shape.
 */
function scripted(answers: string[]): { hook: AskHook; asked: AskRequest[] } {

    const asked: AskRequest[] = [];

    let next = 0;

    return {
        asked,
        hook: request => {

            asked.push(request);

            const answer = answers[next++];

            return {
                askId: `ask-${next}`,
                answer: answer === undefined
                    ? Promise.reject(new Error("nobody answered"))
                    : Promise.resolve(answer)
            };
        }
    };
}

function form(properties: Record<string, unknown>, message = "Which database?"): AcpElicitationRequest {

    return { message, mode: "form", requestedSchema: { properties } } as AcpElicitationRequest;
}

describe("askElicitation", () => {

    it("declines when nobody is watching, without asking anything", async () => {

        expect(await askElicitation(form({ db: { type: "string" } }))).toEqual({ action: "decline" });
    });

    it("asks one question per field, in the order the schema declared them", async () => {

        const { hook, asked } = scripted(["postgres", "5432"]);

        const answered = await askElicitation(
            form({ db: { type: "string", title: "Database" }, port: { type: "string", title: "Port" } }),
            hook);

        expect(asked.map(request => request.prompt)).toEqual(["Which database?\nDatabase", "Port"]);
        expect(answered).toEqual({ action: "accept", content: { db: "postgres", port: "5432" } });
    });

    it("falls back to the description, then the key, for a field with no title", async () => {

        const { hook, asked } = scripted(["a", "b"]);

        await askElicitation(
            form({ one: { type: "string", description: "The first one" }, two: { type: "string" } }, ""),
            hook);

        expect(asked.map(request => request.prompt)).toEqual(["The first one", "two"]);
    });

    it("offers a titled enum as choices, keeping the wire value behind the label", async () => {

        const { hook, asked } = scripted(["Postgres"]);

        const answered = await askElicitation(
            form({
                db: {
                    type: "string",
                    title: "Database",
                    oneOf: [
                        { const: "pg", title: "Postgres", description: "The elephant one" },
                        { const: "sqlite", title: "SQLite" }
                    ]
                }
            }),
            hook);

        expect(asked[0].options).toEqual([
            { label: "Postgres", description: "The elephant one" },
            { label: "SQLite" }
        ]);

        // The label is what the surface sends back; `pg` is what the
        // agent asked for.
        expect(answered).toEqual({ action: "accept", content: { db: "pg" } });
    });

    it("offers an untitled enum as its own values", async () => {

        const { hook, asked } = scripted(["sqlite"]);

        const answered = await askElicitation(
            form({ db: { type: "string", enum: ["pg", "sqlite"] } }),
            hook);

        expect(asked[0].options).toEqual([{ label: "pg" }, { label: "sqlite" }]);
        expect(answered).toEqual({ action: "accept", content: { db: "sqlite" } });
    });

    it("marks a multi-select as multi and splits the labels the surface joined", async () => {

        const { hook, asked } = scripted(["Postgres, SQLite"]);

        const answered = await askElicitation(
            form({
                dbs: {
                    type: "array",
                    items: { anyOf: [{ const: "pg", title: "Postgres" }, { const: "sqlite", title: "SQLite" }] }
                }
            }),
            hook);

        expect(asked[0].multi).toBe(true);
        expect(answered).toEqual({ action: "accept", content: { dbs: ["pg", "sqlite"] } });
    });

    it("keeps a multi-select answer that was typed rather than picked", async () => {

        const answered = await askElicitation(
            form({ tags: { type: "array", items: { enum: ["a", "b"] } } }),
            scripted(["a, something else"]).hook);

        expect(answered).toEqual({ action: "accept", content: { tags: ["a", "something else"] } });
    });

    it("declines a form with a field it cannot draw, before asking anything", async () => {

        const { hook, asked } = scripted(["never asked", "never asked"]);

        // A number field cannot be asked as text without breaking the
        // schema the agent wrote, so the whole form is declined and the
        // person is never shown half of it.
        const answered = await askElicitation(
            form({ port: { type: "number" }, host: { type: "string" } }),
            hook);

        expect(answered).toEqual({ action: "decline" });
        expect(asked).toEqual([]);
    });

    it("cancels when the session ends with a question still open", async () => {

        expect(await askElicitation(form({ db: { type: "string" } }), scripted([]).hook))
            .toEqual({ action: "cancel" });
    });

    it("cancels when the agent gives up on the question before it was answered", async () => {

        const controller = new AbortController();

        // Never answered, so only the signal can settle this.
        const hook = () => ({ askId: "ask-1", answer: new Promise<string>(() => undefined) });

        const answered = askElicitation(form({ db: { type: "string" } }), hook, controller.signal);

        controller.abort();

        await expect(answered).resolves.toEqual({ action: "cancel" });
    });

    it("cancels immediately when the agent had already given up", async () => {

        expect(await askElicitation(
            form({ db: { type: "string" } }),
            scripted(["postgres"]).hook,
            AbortSignal.abort()))
            .toEqual({ action: "cancel" });
    });

    /*
     * ACP says a client that does not understand a mode or a property
     * type MUST NOT render it as a known control. Declining obeys that.
     */
    it("declines a mode this build must not render", async () => {

        const { hook, asked } = scripted(["anything"]);

        expect(await askElicitation({ message: "Sign in", mode: "url" }, hook)).toEqual({ action: "decline" });
        expect(await askElicitation({ message: "?", mode: "_custom" }, hook)).toEqual({ action: "decline" });
        expect(asked).toEqual([]);
    });

    it("declines a whole form when any field has a type it does not know", async () => {

        const { hook, asked } = scripted(["fine"]);

        const answered = await askElicitation(
            form({ ok: { type: "string" }, odd: { type: "_widget" } }),
            hook);

        expect(answered).toEqual({ action: "decline" });

        // Rejected before any field was asked.
        expect(asked).toEqual([]);
    });

    it("declines a form with no fields in it", async () => {

        expect(await askElicitation(form({}), scripted([]).hook)).toEqual({ action: "decline" });
        expect(await askElicitation({ message: "?", mode: "form" }, scripted([]).hook)).toEqual({ action: "decline" });
    });
});
