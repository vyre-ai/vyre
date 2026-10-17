// @ts-check
// join: redeeming a ticket at the relay and pairing with it. The app's `wink.pair.server` and the box call finishJoin with the seed the server's install line made.

import { pairTicket } from "./client.js";

/**
 * Redeem a server's ticket: pair with it, polling while it is not at the relay yet.
 * `once`: the ticket came from a QR the showing device printed, so it is already at the relay. If the relay says it is gone, someone else used it or it ran out, and there
 * is nothing to wait for: answer `gone` at once (a typed code's ticket only appears after the ack, so that path keeps polling).
 * @param {{ relay: string, seed: Uint8Array, name?: string, waitMs?: number, pollMs?: number, fetch?: typeof fetch, pairOptions?: object, once?: boolean,
 *   sleep?: (ms: number) => Promise<void> }} o
 * @returns {Promise<{ ok: true, paired: any } | { ok: false, reason: "offline" | "refused" | "expired" | "gone" }>}
 */
export async function finishJoin(o) {
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const until = Date.now() + (o.waitMs ?? 5 * 60_000);
  // The right ack makes the ticket appear at the relay; a closed code never does. Poll the lookup until it resolves or the code's life ends.
  for (;;) {
    try {
      const paired = await pairTicket(o.seed, { relay: o.relay, name: o.name, fetch: o.fetch, ...(o.pairOptions || {}) });
      return { ok: true, paired };
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (o.once && code === "ticket_gone") return { ok: false, reason: "gone" };
      if (code !== "ticket_gone" && code !== "rate_limited") return { ok: false, reason: code === "bad_record" || code === "contested" ? "refused" : "offline" };
    }
    if (Date.now() >= until) return { ok: false, reason: "expired" };
    await sleep(o.pollMs ?? 3000);
  }
}
