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
import { parseSetupCode, setupDerive, setupHelloOk, setupWords, setupFingerprint, setupClaimMessage, verifyP256, isP256Spki, CLAIM_TTL, SETUP_TTL } from "./wire.js";

const sha = s => crypto.createHash("sha256").update(String(s)).digest();

/**
 * Exactly what the setup channel may call (condition 3, tailnet plan 3.6b). Any addition is posted
 * in the team's CHAT.md and added to the plan first. `relay.pair.ticket` is REFUSED here since 4 Oct (one pairing path); it was allowed once, by the
 * gate below; `relay.setup.end` and `relay.setup.begin` are internal tools and never reachable
 * from a channel, whatever this list says.
 */
export const SETUP_TOOLS = Object.freeze(new Set([
  "relay.setup.status",
  "names.check", "names.claim", "names.status", "names.domain.check", "relay.setup.claim-token", "link.health", "system.info", "onboard.machine",
]));
/** The network tool the channel may call, by exact name: a later tool is not exposed by being added. */
export const SETUP_TOOL_FAMILIES = Object.freeze([/^network\.wink\.status$/]);
/** The events the setup page may follow, one type per stream. */
export const SETUP_EVENTS = Object.freeze(new Set(["relay.paired", "name.claimed", "certificate.issued", "certificate.failed"]));

// Tools added later (the sessions sign-in tool, for "Sign in to your AI") come from the registry,
// not from a call: a shipped module lists them under "setupTools" in its module.json. Nothing under
// relay., presence. or vault. is ever taken, so a module cannot widen the channel into pairing,
// presence or secrets.
/**
 * May the setup channel call this tool? The fixed list above, or a tool a shipped module declared
 * under "setupTools" in its module.json (`extra`, read from the registry by the caller; the loader
 * only honours the field for shipped modules). Never a relay, presence or vault tool.
 * @param {string} name @param {readonly string[]} [extra]
 */
export const setupToolAllowed = (name, extra = []) => SETUP_TOOLS.has(name) || SETUP_TOOL_FAMILIES.some(r => r.test(name)) || (extra.includes(name) && !/^(relay|presence|vault)\./.test(name));

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
    /** @type {{ challenge: Buffer, exp: number, host: string } | null} the one live claim challenge */
    this.claim = null;
    this.ended = false;
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

  /**
   * Make the claim challenge (B4): 32 random bytes, two minutes, for one address. A new one replaces
   * the last, so at most one is live. Only the setup device's channel calls this.
   * @param {string} host the address the claim will be made at
   */
  mintClaim(host) {
    const h = String(host || "").toLowerCase();
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)) throw Object.assign(new Error("that is not an address"), { code: "bad_input" });
    if (!this.live) throw Object.assign(new Error("this setup session has ended"), { code: "setup_over" });
    const challenge = crypto.randomBytes(32);
    this.claim = { challenge, exp: this.now() + CLAIM_TTL, host: h };
    return { challenge: challenge.toString("base64url"), exp: this.claim.exp };
  }

  /**
   * Check a claim token made at the address (B4). The challenge is burned by the first try, right or
   * wrong. It must be live, made for this address (the request's own origin), signed by the page key
   * the code names, over this box's route. One message for every refusal.
   * @param {{ token: string, spki: string, route: string, origin: string }} o @returns {string} the address
   */
  takeClaim(o) {
    const c = this.claim; this.claim = null;
    const no = () => Object.assign(new Error("that claim is not valid"), { code: "denied" });
    if (!c || !this.live || this.now() >= c.exp) throw no();
    const raw = Buffer.from(String(o.token || ""), "base64url"), spki = Buffer.from(String(o.spki || ""), "base64url");
    if (raw.length !== 96 || !isP256Spki(spki)) throw no();
    const fp = setupFingerprint(spki);
    if (fp.length !== this.fp.length || !crypto.timingSafeEqual(fp, this.fp)) throw no();
    let originHost = "";
    try { const u = new URL(String(o.origin || "")); if (u.protocol !== "https:") throw 0; originHost = u.hostname.toLowerCase(); } catch { throw no(); }
    if (originHost !== c.host) throw no();
    const challenge = raw.subarray(0, 32), sig = raw.subarray(32);
    if (challenge.length !== c.challenge.length || !crypto.timingSafeEqual(challenge, c.challenge)) throw no();
    if (!verifyP256(spki, setupClaimMessage(o.route, c.challenge, c.host), sig)) throw no();
    return c.host;
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
