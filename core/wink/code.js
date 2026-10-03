// @ts-check
// The showing device's side of a typed Wink code (spec 6.5): a pure state machine with an injected
// clock, crypto and transport, and no coupling to vyred. The module that wires it (relay link,
// events, the card) lives elsewhere; this file owns the rules.
//
// The rules, each one tested in code.test.js:
//   a. THE TYPIST CONFIRMS FIRST. This device sends nothing derived from the shared key (its own
//      confirmation tag, the number, the key) before it has verified the typist's confirmation. A
//      bad confirmation answers nothing key-derived, ever.
//   b. EVERY SESSION IN WHICH THIS DEVICE PROCESSED THE TYPIST'S FIRST MESSAGE COUNTS AS AN ATTEMPT,
//      completed or abandoned. An abort after message 1 costs an attempt.
//   c. THE CEILING IS CHECKED BEFORE EACH KEY EVALUATION, and the TENTH attempt closes the code as it
//      starts, so parallel sessions cannot get more than ten evaluations. A closed code answers
//      nothing, so the tenth session (evaluated, then closed) cannot complete: in practice an
//      attacker has nine live guesses a code.
//   d. A CLOSED CODE IS REPLACED by a fresh one with a fresh rendezvous, with no user action, and the
//      events say so: `wink.code.closed { reason }` then `wink.code.replaced { code, rv, expires,
//      reason }`. Reasons that replace: expired, too_many, wrong_number (and wrong_code, only when
//      `rotateOnWrong` is set). Reasons that do not: used (the code worked), cancelled.
//   e. AFTER THE PAKE a 3-digit number derived from the transcript is known on both sides. The typing
//      side shows one number; this side offers 3 choices at W0 to W2 and 5 above W2
//      (`wink.code.pick { id, choices }`). ONE TRY PER CODE: one wrong pick closes the code.
//   f. A CODE IS SINGLE USE AND LASTS 5 MINUTES.
//
// Events (all through `emit(name, data)`; `opened`, `replaced` carry the code to display, which is a
// secret: show it on this device only):
//   wink.code.opened   { code, rv, expires }                a first code is showing
//   wink.code.replaced { code, rv, expires, reason }        a fresh code took the place of a closed one
//   wink.code.closed   { reason }                           expired | too_many | wrong_number | wrong_code | used | cancelled
//   wink.code.wrong    { attempts }                         a typist's confirmation failed (a wrong code was tried)
//   wink.code.pick     { id, choices }                      the PAKE completed; the approver picks the number
//   wink.code.ack      { id }                               (two-sided) the PAKE completed; the person types back the code the other device shows
//   wink.code.done     { id }                               the right number was picked
//   wink.code.unavailable { reason }                        no rendezvous could be had (the relay is away or full)

import * as client from "../../relay/client/code.js";

export const CODE_TTL_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 10;
/** Reasons after which a fresh code appears with no tap. */
const REPLACING = new Set(["expired", "too_many", "wrong_number", "wrong_code"]);

/**
 * @typedef {{
 *   route: string,
 *   allocate: () => Promise<{ rv: string, exp?: number } | null>,
 *   release?: () => void,
 *   emit?: (name: string, data: any) => void,
 *   now?: () => number,
 *   level?: number,
 *   rotateOnWrong?: boolean,
 *   twoSided?: boolean,
 *   maxAttempts?: number,
 *   ttlMs?: number,
 *   crypto?: Pick<typeof client, "newCode" | "showingStart" | "numberChoices" | "unb64url" | "b64url">,
 *   rng?: (n: number) => Uint8Array,
 * }} Options
 *   route: this box's route id (it is in the transcript). allocate: ask the relay for a free
 *   rendezvous (link.codeAlloc). release: give it back. level: the W level of the flow, 0 to 2 gives
 *   3 choices and above gives 5.
 */

/** @param {Options} o */
export function createWinkCode(o) {
  const now = o.now || Date.now;
  const emit = o.emit || (() => {});
  const cx = o.crypto || client;
  const max = o.maxAttempts || MAX_ATTEMPTS;
  const ttl = o.ttlMs || CODE_TTL_MS;
  const count = (o.level || 0) <= 2 ? 3 : 5;

  /**
   * @typedef {{ code: string, rv: string, pw: string, expires: number, attempts: number, closed: boolean, matched: boolean,
   *   sessions: Map<string, { eval: any, done: boolean }>,
   *   pick: null | { id: string, number: string, key: Uint8Array } }} Live
   * @type {Live | null}
   */
  let live = null;
  let generation = 0;
  /** @type {Promise<any> | null} */
  let opening = null;

  /** Takes a rendezvous and makes a code on it. Returns the code's details, or null. */
  async function make() {
    const a = await o.allocate();
    if (!a || typeof a.rv !== "string" || !client.isRendezvous(a.rv)) { emit("wink.code.unavailable", { reason: "relay" }); return null; }
    const c = cx.newCode(a.rv, o.rng);
    const expires = Math.min(now() + ttl, a.exp || Infinity);
    live = { code: c.code, rv: c.rv, pw: c.pw, expires, attempts: 0, closed: false, matched: false, sessions: new Map(), pick: null };
    generation++;
    return { code: c.code, rv: c.rv, expires };
  }

  /** Closes the live code (nothing more is accepted for it), gives its rendezvous back and says why. @param {string} reason */
  function close(reason) {
    const l = live;
    if (!l || l.closed) return false;
    l.closed = true;
    l.pick = null;
    l.sessions.clear();
    try { o.release?.(); } catch {}
    emit("wink.code.closed", { reason });
    return true;
  }

  /** Closes, then replaces if the reason says so. @param {string} reason */
  async function end(reason) {
    if (!close(reason)) return;
    if (!REPLACING.has(reason)) return;
    const gen = generation;
    opening = (async () => {
      const made = await make();
      if (made && generation !== gen) emit("wink.code.replaced", { ...made, reason });
      return made;
    })();
    try { await opening; } finally { opening = null; }
  }

  /** Expiry is checked on every use, and by `tick()` for a wiring that sets one timer at `expires`. */
  function expired() {
    const l = live;
    if (!l || l.closed || now() < l.expires) return false;
    void end("expired");
    return true;
  }

  return {
    /** Shows a first code. Resolves { code, rv, expires }, or null when no rendezvous could be had. */
    async open() {
      if (opening) return opening;
      if (live && !live.closed) return { code: live.code, rv: live.rv, expires: live.expires };
      opening = (async () => {
        const made = await make();
        if (made) emit("wink.code.opened", made);
        return made;
      })();
      try { return await opening; } finally { opening = null; }
    },

    /** Closes the code on purpose: no replacement. */
    cancel() { close("cancelled"); },

    /** Call at `expires` (one timer, nothing polls): closes and replaces an expired code. @returns {Promise<void>} */
    async tick() { const l = live; if (l && !l.closed && now() >= l.expires) await end("expired"); },

    /** @returns {{ code: string, rv: string, expires: number, attempts: number, matching: boolean } | null} */
    status() { const l = live; return l && !l.closed ? { code: l.code, rv: l.rv, expires: l.expires, attempts: l.attempts, matching: l.matched } : null; },

    /**
     * A message from a typing device, as the relay forwards it: { rv, s, n, m }. Returns the reply
     * (`{ m }`, base64url) or null, and null is all a refusal says: the relay gives the typist one
     * generic answer, so nothing here distinguishes a wrong code from a closed one.
     * @param {{ rv: string, s: string, n: number, m: string }} msg
     * @returns {{ m: string } | null}
     */
    handle(msg) {
      if (expired()) return null;
      const l = live;
      if (!l || l.closed || !msg || msg.rv !== l.rv) return null;
      const bytes = cx.unb64url(String(msg.m));
      const nonce = cx.unb64url(String(msg.s));
      if (!bytes || bytes.length !== 32 || !nonce || nonce.length !== 16) return null;
      if (msg.n === 1) {
        // Once a session has completed the PAKE, the code is spoken for: nobody else is evaluated.
        if (l.matched || l.sessions.has(msg.s)) return null;
        // The ceiling is checked BEFORE the key evaluation, and the attempt is counted now: a
        // session that is abandoned after this point has already cost one.
        if (l.attempts >= max) { void end("too_many"); return null; }
        l.attempts++;
        const session = { eval: /** @type {any} */ (null), done: false };
        l.sessions.set(msg.s, session);
        // The tenth attempt closes the code as it starts, before it is answered, but it is still evaluated
        // once, so the count of evaluations is exactly the count of attempts.
        let out = null;
        try {
          session.eval = cx.showingStart({ pw: l.pw, rv: l.rv, route: o.route, s: msg.s, first: bytes, rng: o.rng });
          out = { m: cx.b64url(session.eval.second) };
        } catch { session.done = true; }
        if (l.attempts >= max) void end("too_many");
        return out;
      }
      if (msg.n === 3) {
        const session = l.sessions.get(msg.s);
        if (!session || session.done || !session.eval || l.matched) return null;
        session.done = true;
        // The typist's confirmation is verified before anything derived from the key leaves this device.
        const r = session.eval.confirm(bytes);
        session.eval = null;
        if (!r.ok) {
          emit("wink.code.wrong", { attempts: l.attempts });
          if (o.rotateOnWrong) void end("wrong_code");
          return null;
        }
        l.matched = true;
        const id = cx.b64url(o.rng ? o.rng(9) : globalThis.crypto.getRandomValues(new Uint8Array(9)));
        l.pick = { id, number: r.number, key: r.key };
        if (o.twoSided) emit("wink.code.ack", { id });
        else emit("wink.code.pick", { id, choices: cx.numberChoices(r.number, count, o.rng) });
        return { m: cx.b64url(r.tag) };
      }
      return null;
    },

    /**
     * Two-sided pairing (DESIGN-wink.md, section 4): the person types back the code the typing device shows (`ackCode` of the shared key).
     * One try per code, like the pick: the right code uses the code up, a wrong one closes it (and a fresh one replaces it).
     * @param {string} id @param {string} typed
     * @returns {Promise<{ ok: true, key: Uint8Array } | { ok: false }>}
     */
    async ack(id, typed) {
      if (expired()) return { ok: false };
      const l = live;
      if (!l || l.closed || !l.pick || l.pick.id !== id) return { ok: false };
      const p = l.pick;
      l.pick = null;
      const want = client.normaliseAck(client.ackCode(p.key));
      const got = client.normaliseAck(String(typed));
      if (!got || !want || !client.equalBytes(new TextEncoder().encode(got), new TextEncoder().encode(want))) { await end("wrong_number"); return { ok: false }; }
      close("used");
      emit("wink.code.done", { id });
      return { ok: true, key: p.key };
    },

    /**
     * The approver's pick. One try per code: the right number uses the code up, a wrong one closes it
     * (and a fresh one replaces it). Resolves { ok: true, key } on success; the key seals the record.
     * @param {string} id @param {string} number
     * @returns {Promise<{ ok: true, key: Uint8Array } | { ok: false }>}
     */
    async pick(id, number) {
      if (expired()) return { ok: false };
      const l = live;
      if (!l || l.closed || !l.pick || l.pick.id !== id) return { ok: false };
      const p = l.pick;
      l.pick = null;
      if (typeof number !== "string" || number !== p.number) { await end("wrong_number"); return { ok: false }; }
      close("used");
      emit("wink.code.done", { id });
      return { ok: true, key: p.key };
    },
  };
}
