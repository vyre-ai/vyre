// @ts-check
// fill: the computers side of a Vault fill (ADR 0028, decision 3). The vault signs an agent in
// on the agent's own computer without the agent ever seeing the login.
//
// begin raises the shield with reason "fill": the agent's hands refuse reads and input, and
// computerd cuts every CDP socket the agent has open and refuses new ones. computerd then accepts
// one more kind of CDP client, the fill's, by a token minted here for this fill only. The vault
// connects with it, signs in in a fresh browser context, and calls end, which drops the token (and
// the vault's socket with it) and lowers the shield. The agent's hands see the new tab after that.
//
// A fill lasts at most LIMIT_MS: a vault that never calls end cannot leave an agent blind, and
// the fill ends "expired". A computer that stops ends it "stopped". Only the vault may call
// either tool, and a fill never starts while a person holds the keyboard or signs in privately.
//
// The token goes back to the vault in memory and to computerd in the /shield body. It is never
// logged, emitted or put in an error. Events carry the agent, the fill id, the origin and why.

import { randomBytes, randomUUID } from "node:crypto";

/** The longest a fill may keep an agent's computer shielded. */
export const LIMIT_MS = 60_000;

/** @typedef {{ id: string, origin: string, token: string, since: number, expires: number, cancel: () => void }} Open */

const busy = message => Object.assign(new Error(message), { code: "busy" });

export class Fills {
  /**
   * @param {{ pool: import("./pool.js").Pool, shield: import("./shield.js").Shield, keyboard: import("./keyboard.js").Keyboard,
   *   emit: (type: string, payload: any, where?: any) => any, on?: (pattern: string, fn: (e: any) => void) => () => void,
   *   helper: (agent: string) => Promise<{ url: string, token: string }>, log?: (m: string) => void,
   *   now?: () => number, schedule?: (fn: () => void, ms: number) => () => void }} deps
   */
  constructor(deps) {
    this.pool = deps.pool;
    this.shield = deps.shield;
    this.keyboard = deps.keyboard;
    this.send = deps.emit;
    this.helper = deps.helper;
    this.log = deps.log || (() => {});
    this.now = deps.now || (() => deps.pool.now());
    this.schedule = deps.schedule || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    /** Open fills, by agent. @type {Map<string, Open>} */
    this.open = new Map();
    this.off = deps.on ? deps.on("computer.stopped", e => {
      const agent = e && e.payload && e.payload.agent;
      const f = agent && this.open.get(String(agent));
      if (f) this.end(String(agent), f.id, { why: "stopped" }).catch(err => this.log(`end ${agent}'s fill: ${err.message}`));
    }) : () => {};
  }

  has(agent) { return this.open.has(agent); }

  /**
   * Shield the agent's computer and hand the vault a CDP address and a token for this fill only.
   * @param {string} agent @param {string} origin
   * @returns {Promise<{ fill: string, cdpUrl: string, token: string, expires: number }>}
   */
  async begin(agent, origin) {
    if (this.open.has(agent)) throw busy(`${agent}'s computer is busy: another sign-in is being filled`);
    const holder = this.keyboard.holder(agent);
    if (holder) throw busy(`${agent}'s computer is busy: ${holder} has the keyboard`);
    // Thaw (or start) it first: a shield computerd never heard about would not cut the agent's sockets.
    let h;
    try { h = await this.helper(agent); }
    catch (e) {
      const err = /** @type {any} */ (e);
      if (!err.code) err.code = !this.pool.driver ? "no_driver" : /has no computer|no agent /.test(String(err.message)) ? "no_computer" : "failed";
      throw err;
    }
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const since = this.now();
    // Claimed before the await below, so a second begin for this agent is refused, not interleaved.
    /** @type {Open} */
    const f = { id, origin: String(origin || ""), token, since, expires: since + LIMIT_MS, cancel: () => {} };
    this.open.set(agent, f);
    try {
      const s = await this.shield.set(agent, true, { reason: "fill", fill_token: token });
      if (!s.computerd) throw new Error(`${agent}'s computer did not answer; nothing was filled`);
    } catch (e) {
      this.open.delete(agent);
      if (this.shield.reason(agent) === "fill") await this.shield.set(agent, false, { reason: "fill" }).catch(() => {});
      throw e;
    }
    f.cancel = this.schedule(() => { this.end(agent, id, { why: "expired" }).catch(err => this.log(`expire ${agent}'s fill: ${err.message}`)); }, LIMIT_MS);
    this.send("computer.fill-began", { agent, fill: id, origin: f.origin });
    this.log(`${agent}'s computer shielded for a fill (${f.origin})`);
    return { fill: id, cdpUrl: `${h.url.replace(/\/+$/, "")}/cdp`, token, expires: f.expires };
  }

  /**
   * Drop the fill's token, lower the shield, and tell the agent's side which tab was signed in.
   * @param {string} agent @param {string} fill
   * @param {{ target?: string, why?: "done"|"expired"|"stopped" }} [o]
   * @returns {Promise<{ agent: string, ended: boolean }>}
   */
  async end(agent, fill, o = {}) {
    const f = this.open.get(agent);
    if (!f || f.id !== fill) return { agent, ended: false };
    this.open.delete(agent);
    f.cancel();
    const why = o.why || "done";
    // A stopped computer's computerd is gone with its token; lowering still clears vyred's side.
    await this.shield.set(agent, false, { reason: "fill" }).catch(e => this.log(`lower ${agent}'s fill shield: ${e.message}`));
    const target = typeof o.target === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(o.target) ? o.target : undefined;
    this.send("computer.fill-ended", { agent, fill, why, ...(target ? { target } : {}) });
    this.log(`${agent}'s fill ended (${why}) after ${this.now() - f.since} ms`);
    // Its freeze clock starts from now, not from before the fill.
    this.pool.touch(agent);
    return { agent, ended: true };
  }

  stop() {
    for (const f of this.open.values()) f.cancel();
    this.off();
  }
}
