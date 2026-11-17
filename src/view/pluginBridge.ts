import { PluginReplyMessage, PluginRequestMessage } from "../shared/runMessages";

/**
 * The page's side of a plugin app's requests: hands each one to the
 * host with an id, and settles the matching promise when the reply
 * comes back. One per panel; every app's iframe shares it.
 */
export class PluginBridge {

    private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

    private seq = 0;

    constructor(private readonly post: (request: PluginRequestMessage) => void) {}

    public request(request: Omit<PluginRequestMessage, "id">): Promise<unknown> {

        return new Promise((resolve, reject) => {

            const id = ++this.seq;

            this.pending.set(id, { resolve, reject });

            this.post({ ...request, id } as PluginRequestMessage);
        });
    }

    /** The host answered. An id nobody is waiting on is ignored. */
    public onReply(reply: PluginReplyMessage): void {

        const waiting = this.pending.get(reply.id);

        if (!waiting)
            return;

        this.pending.delete(reply.id);

        if (reply.ok)
            waiting.resolve(reply.value);
        else
            waiting.reject(new Error(reply.error ?? "The request failed."));
    }
}
