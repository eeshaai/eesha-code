import * as crypto from "crypto";
import * as fs from "fs";
import type { IncomingMessage } from "http";

import { eeshaPath, writeAtomic } from "./paths";

/*
 * Who may talk to the server.
 *
 * The server only listens on 127.0.0.1, so nothing on another machine
 * reaches it. What is left to stop is a web page in the same browser
 * (any site the person visits can send requests to 127.0.0.1) and a
 * site that points its own name at 127.0.0.1 to read the answers.
 *
 *   1. A secret key, made once and kept in ~/.eesha/key. The link
 *      `eesha start` prints carries it; the server swaps it for a
 *      cookie the browser sends back by itself. The command sends it in
 *      a header.
 *   2. The cookie is SameSite=Strict, so a request another site starts
 *      never carries it, and HttpOnly, so no script reads it.
 *   3. The Host header must be 127.0.0.1 or localhost on our port, so a
 *      site that renamed itself to 127.0.0.1 is refused.
 *   4. A request that changes something must come from our own page:
 *      its Origin header must be our own address.
 *
 * Known gap: a browser sends a cookie for 127.0.0.1 to every port on
 * 127.0.0.1, so another local server the person opens in the same
 * browser receives the key. A program on this machine could read
 * ~/.eesha/key anyway; this is no wider than that.
 */

export const COOKIE = "eesha_key";

export const KEY_HEADER = "x-eesha-key";

/** The key, made the first time. The same key across restarts, so a bookmarked page keeps working. */
export function ensureKey(file: string = eeshaPath("key")): string {

    try {

        const saved = fs.readFileSync(file, "utf8").trim();

        if (/^[0-9a-f]{48}$/.test(saved))
            return saved;

    } catch {

        // Not made yet.
    }

    const key = crypto.randomBytes(24).toString("hex");

    writeAtomic(file, key + "\n");

    return key;
}

/** Whether `given` is the key, compared in constant time. */
export function isKey(given: string | undefined, key: string): boolean {

    if (typeof given !== "string" || given.length !== key.length)
        return false;

    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

/** The key cookie's value, if the request carries one. */
export function cookieKey(request: IncomingMessage): string | undefined {

    const header = request.headers.cookie;

    if (!header)
        return undefined;

    for (const part of header.split(";")) {

        const [name, ...rest] = part.trim().split("=");

        if (name === COOKIE)
            return rest.join("=");
    }

    return undefined;
}

/** The Set-Cookie header that hands the key to the page. A year, so a bookmark keeps working. */
export function keyCookie(key: string): string {

    return `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

/** The two names our own address goes by. */
function ownHosts(port: number): string[] {

    return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Whether the Host header is our own address - see 3 above. */
export function hostAllowed(request: IncomingMessage, port: number): boolean {

    const host = request.headers.host?.toLowerCase();

    return host !== undefined && ownHosts(port).includes(host);
}

/** Whether the Origin header is our own page - see 4 above. A request with no Origin is refused. */
export function originAllowed(request: IncomingMessage, port: number): boolean {

    const origin = request.headers.origin?.toLowerCase();

    return origin !== undefined && ownHosts(port).some(host => origin === `http://${host}`);
}

/**
 * Whether a page load or event stream comes from our own page or from
 * the address bar, not from another site. Browsers that do not send
 * Sec-Fetch-Site are let through; the cookie still has to be there.
 */
export function sameSite(request: IncomingMessage): boolean {

    const site = request.headers["sec-fetch-site"];

    return site === undefined || site === "same-origin" || site === "none";
}
