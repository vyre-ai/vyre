// @ts-check
// join: the typing side of a Wink typed code, end to end (spec 6.5, 6.6). The code runs the PAKE through the relay (code.js), both sides
// then hold the same key and show the same number, the person picks the number on the approver's card, and the approver mints a ticket
// whose seed both sides derive from that key (so the relay never sees it and nobody has to carry a second secret). This side then
// pairs with that ticket exactly as a ring does. Browser and Node safe; the Windows first-run page and the Deck call joinWithCode().

import { enterCode, hmac512, ackCode } from "./code.js";
import { pairTicket } from "./client.js";

const SEED_LABEL = new TextEncoder().encode("vyre-wink-ticket-seed-v1");

/** The ticket seed both ends derive from the PAKE key: 16 bytes. @param {Uint8Array} key */
export function seedFromKey(key) {
  return new Uint8Array(hmac512(key, SEED_LABEL)).slice(0, 16);
}

/**
 * Type a code, wait for the approver's pick, then pair.
 * @param {{ relay: string, input: string, name?: string, onState?: (s: { state: string, code?: string, number?: string }) => void,
 *   waitMs?: number, pollMs?: number, fetch?: typeof fetch, rng?: (n: number) => Uint8Array, pairOptions?: object, sleep?: (ms: number) => Promise<void> }} o
 *   relay: the relay's ws(s) address. States: `checking`, `ack` (show `code`: "type this on your other device"), `waiting`, `joining`.
 * @returns {Promise<{ ok: true, paired: any, number: string } | { ok: false, reason: "format" | "busy" | "offline" | "refused" | "closed" | "expired" }>}
 */
export async function joinWithCode(o) {
  const say = o.onState || (() => {});
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  say({ state: "checking" });
  const base = String(o.relay).replace(/^ws/, "http");
  const r = await enterCode({ base, input: o.input, fetch: o.fetch, rng: o.rng });
  if (!r.ok) return { ok: false, reason: r.reason };
  // Two-sided (DESIGN-wink.md, section 4): this device now shows the code the person types back on the other one.
  say({ state: "ack", code: ackCode(r.key), number: r.number });
  const seed = seedFromKey(r.key);
  const until = Date.now() + (o.waitMs ?? 5 * 60_000);
  say({ state: "waiting", number: r.number });
  // The approver's right pick makes the ticket appear at the relay; a closed code never does. Poll the lookup until it resolves or the code's life ends.
  for (;;) {
    try {
      const paired = await pairTicket(seed, { relay: o.relay, name: o.name, fetch: o.fetch, ...(o.pairOptions || {}) });
      say({ state: "joining", number: r.number });
      return { ok: true, paired, number: r.number };
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (code !== "ticket_gone" && code !== "rate_limited") return { ok: false, reason: code === "bad_record" || code === "contested" ? "refused" : "offline" };
    }
    if (Date.now() >= until) return { ok: false, reason: "expired" };
    await sleep(o.pollMs ?? 3000);
  }
}
