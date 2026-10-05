// @ts-check
// join: the typing side of a Wink typed code, end to end (DESIGN-wink.md section 4). The code runs the PAKE through the relay (code.js),
// both sides then hold the same key, THIS side shows a second code (the ack) and the person types it back on the showing device, which then
// mints a ticket whose seed both sides derive from that key (so the relay never sees it and nobody has to carry a second secret). This side
// then pairs with that ticket exactly as a ring does. There is no pick-a-number step. Browser and Node safe; the Windows first-run page
// and the Deck call joinWithCode(); the app's `wink.pair.server` uses the two halves (typeWinkCode, then finishJoin) so it can show the ack
// code between them.

import { enterCode, hmac512, ackCode } from "./code.js";
import { pairTicket } from "./client.js";

const SEED_LABEL = new TextEncoder().encode("vyre-wink-ticket-seed-v1");

/** The ticket seed both ends derive from the PAKE key: 16 bytes. @param {Uint8Array} key */
export function seedFromKey(key) {
  return new Uint8Array(hmac512(key, SEED_LABEL)).slice(0, 16);
}

/**
 * First half: type the code. On success the person is shown `ack` (type this on the showing device).
 * @param {{ relay: string, input: string, fetch?: typeof fetch, rng?: (n: number) => Uint8Array }} o
 * @returns {Promise<{ ok: true, ack: string, seed: Uint8Array, route: string } | { ok: false, reason: "format" | "busy" | "offline" | "refused" }>}
 */
export async function typeWinkCode(o) {
  const base = String(o.relay).replace(/^ws/, "http");
  const r = await enterCode({ base, input: o.input, fetch: o.fetch, rng: o.rng });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, ack: ackCode(r.key), seed: seedFromKey(r.key), route: r.route };
}

/**
 * Second half: wait for the showing device's person to type the ack back (the ticket then appears at the relay), then pair.
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

/**
 * Type a code, show the ack, wait for it to be typed back, then pair.
 * @param {{ relay: string, input: string, name?: string, onState?: (s: { state: string, code?: string }) => void,
 *   waitMs?: number, pollMs?: number, fetch?: typeof fetch, rng?: (n: number) => Uint8Array, pairOptions?: object, sleep?: (ms: number) => Promise<void> }} o
 *   relay: the relay's ws(s) address. States: `checking`, `ack` (show `code`: "type this on your other device"), `waiting`, `joining`.
 * @returns {Promise<{ ok: true, paired: any } | { ok: false, reason: "format" | "busy" | "offline" | "refused" | "closed" | "expired" }>}
 */
export async function joinWithCode(o) {
  const say = o.onState || (() => {});
  say({ state: "checking" });
  const t = await typeWinkCode(o);
  if (!t.ok) return { ok: false, reason: t.reason };
  say({ state: "ack", code: t.ack });
  say({ state: "waiting" });
  const f = await finishJoin({ relay: o.relay, seed: t.seed, name: o.name, waitMs: o.waitMs, pollMs: o.pollMs, fetch: o.fetch, pairOptions: o.pairOptions, sleep: o.sleep });
  if (f.ok) say({ state: "joining" });
  return f;
}
