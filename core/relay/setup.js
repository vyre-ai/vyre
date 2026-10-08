// @ts-check
// setup: the box's half of the setup session over the relay (tailnet plan 3.5, 3.6, 3.6b).
//
// The setup page makes a code (core/relay/wire.js: secret16 || the fingerprint of its own P-256
// key), the install line carries it in VYRE_SETUP_CODE, and this box registers a sealed offer at the
// code's locator. Three things live here:
//   SetupSession  one code's whole life: the hello check, the one-ticket rule, the hour, the end.
//   setupGate     the allowlist handler the setup device's channel gets in place of owner powers.
//   the tool list  what that handler lets through, and the extension point for more.
// core/relay/index.js wires them to the database, the presence keys and the link.

import crypto from "node:crypto";
import { parseSetupCode, setupDerive, setupHelloOk, setupWords, SETUP_TTL } from "./wire.js";

const sha = s => crypto.createHash("sha256").update(String(s)).digest();

import { SETUP_TOOLS, SETUP_TOOL_FAMILIES, SETUP_REASONS, SETUP_EVENTS, setupToolAllowed } from "../../lib/setup-gate.js";
export { SETUP_TOOLS, SETUP_TOOL_FAMILIES, SETUP_REASONS, SETUP_EVENTS, setupToolAllowed };

/**
 * One setup code, from install to claim or expiry. State only: the database rows, the presence
 * key and the channel are index.js's, which it drops when `onEnd` fires.
 */
export class SetupSession {
  /**
   * @param {{ code: string, now?: () => number, ttl?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
   *   onEnd?: (why: string) => void }} o
   */
  constructor(o) {
    const c = parseSetupCode(o.code);
    if (!c) throw Object.assign(new Error("not a setup code"), { code: "bad_input" });
    this.now = o.now || Date.now;
    this.secret = c.secret;
    this.fp = c.fp;
    this.loc = setupDerive("loc", c.secret).toString("base64url");
    /** The pairing secret the page presents; hashed, and never in the pendingTickets an ordinary device could redeem. */
    this.secHash = sha(setupDerive("sec", c.secret).toString("base64url"));
    this.secUsed = false;
    this.exp = this.now() + (o.ttl || SETUP_TTL);
    /** "none": the one relay.pair.ticket is still unmade; "busy": one is being made; "minted": it was. */
    this.ticket = "none";
    /** @type {string|null} the setup device's id, once admitted */
    this.device = null;
    /** @type {"waiting"|"paired"|"contested"|"ended"} */
    this.state = "waiting";
    /** Whether the relay confirmed the offer (200). */
    this.registered = false;
    this.onEnd = o.onEnd || (() => {});
    this.clearTimer = o.clearTimer || clearTimeout;
    // The hour runs from the code, claimed or not: at its end the device, its presence key and the channel go.
    this.timer = (o.setTimer || setTimeout)(() => this.end("expired"), Math.max(0, this.exp - this.now()));
    this.timer?.unref?.();
  }

  get live() { return !this.ended && this.now() < this.exp; }

  /** @param {string} why */
  end(why) {
    if (this.ended) return false;
    this.ended = true;
    this.state = "ended";
    this.clearTimer(this.timer);
    this.onEnd(why);
    return true;
  }

  /**
   * Admit a setup hello (condition 2): it must carry the exact SPKI whose fingerprint the code
   * holds and a valid signature over the route and this Noise session's own device key. Returns the
   * SPKI. One message for every refusal: a probe learns nothing about which part failed.
   * @param {{ route: string, pub: Buffer, hello: any }} o @returns {Buffer}
   */
  checkHello(o) {
    const h = o.hello && o.hello.setup;
    const spki = this.live && this.state !== "contested" && h && typeof h === "object"
      ? setupHelloOk({ fp: this.fp, route: o.route, noiseStatic: o.pub, key: h.key, sig: h.sig }) : null;
    if (!spki) throw new Error("this is not the setup page for this box");
    return spki;
  }

  /** Burn the pairing secret the first admission presents. Only after checkHello, so nobody without the key can spend it. @param {any} presented */
  takeSecret(presented) {
    if (this.secUsed || typeof presented !== "string") return false;
    const ok = crypto.timingSafeEqual(sha(presented), this.secHash);
    if (ok) this.secUsed = true;
    return ok;
  }

  /** Four check words for the box's static key and this code's secret (wire.js setupWords). @param {Buffer} boxPub */
  words(boxPub) { return setupWords(boxPub, this.secret); }
}

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/**
 * The setup device's handler (condition 3): an allowlist, not owner powers. It sits in front of
 * vyred's router, which is given a policy of its own (tools by name, a few paths, one event type
 * per stream) as a second layer. Beyond the list:
 *   - relay.pair.ticket is refused (it used to work once for the session, only while no owner exists, only within the
 *     session's hour, and only counts when it succeeded. It never reaches the router: presence
 *     there means a person session, which no one has before the claim. The channel itself is the
 *     proof: it was admitted only for a hello signed by the page key over this Noise key, so every
 *     request on it is that key's, and that key's presence covers this one ticket and nothing else.
 *   - a session that is over answers 401 to everything.
 * @param {{ session: () => SetupSession|null, ownerExists: () => boolean, mintTicket: () => Promise<any>,
 *   handlerFor: (policy: any) => (req: any, res: any, caller: string, peer: any) => any }} o
 */
export function setupGate(o) {
  /** @type {Map<string, (req: any, res: any, caller: string, peer: any) => any>} */
  const cache = new Map();
  const routed = (key, policy) => { let h = cache.get(key); if (!h) { h = o.handlerFor(policy); cache.set(key, h); } return h; };
  const tools = () => routed("tools", { tool: name => setupToolAllowed(name, o.extraTools ? o.extraTools() : []),
    path: (/** @type {string} */ m, /** @type {string} */ p) => (m === "POST" && p.startsWith("/v1/tools/")) || (m === "GET" && (p === "/v1/tools" || p === "/v1/health")) });
  const events = type => routed(`events:${type}`, { eventType: type, path: (m, p) => m === "GET" && p === "/v1/events" });

  return (req, res, caller, peer) => {
    const s = o.session();
    if (!s || !s.live) return send(res, 401, { error: { code: "setup_over", message: "this setup session has ended" } });
    const url = new URL(req.url || "/", "http://vyred");
    const method = String(req.method || "GET");
    if (method === "GET" && url.pathname === "/v1/events") {
      const type = url.searchParams.get("type") || "";
      if (!SETUP_EVENTS.has(type)) return send(res, 404, { error: { code: "not_found", message: `${method} ${url.pathname}` } });
      return events(type)(req, res, caller, peer);
    }
    // Compared as the router will read it (percent-decoded), so no spelling of the name skips the one-ticket rule.
    let tool = "";
    try { if (url.pathname.startsWith("/v1/tools/")) tool = decodeURIComponent(url.pathname.slice("/v1/tools/".length)); } catch { return send(res, 400, { error: { code: "bad_input", message: "bad path" } }); }
    // One pairing path in 0.3 (lead ruling, 4 Oct 2026): the setup page no longer mints a ticket. A device that redeemed it was paired at the relay with no three-word confirm (a row of kind
    // app, a presence key), and no owner exists yet to confirm it. The first device pairs by the code the installer prints (a gated server pairing, confirmed with three words).
    if (method === "POST" && tool === "relay.pair.ticket") {
      req.resume();
      return send(res, 403, { error: { code: "denied", message: "this box is paired with the code its installer prints, confirmed with three words; the setup page mints no pairing ticket" } });
    }
    return tools()(req, res, caller, peer);
  };
}
