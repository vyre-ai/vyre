// @ts-check
// network.tailscale.*: the box's Tailscale sign-in and state, for the setup page and Settings
// (plans/tailnet.md 3.3). Three tools and one event.
//
//   network.tailscale.status  state (off, needs-login, needs-approval, connected), the login, the
//                             tailnet and its kind (personal or organization), the address and node.
//   network.tailscale.login   starts `tailscale up` if needed and answers {loginUrl, state}. The
//                             link is a bearer invitation onto this node: it is only ever the
//                             tool's answer, never in an event, a log line or the setup mailbox,
//                             and it is fetched again on every click.
//   network.tailscale.peers   other nodes of the same login (a new computer or phone signing in).
//
// `tailscale.changed { state, tailnetKind }` fires (the login and address are read with status: every module reads events) on every state change, so the page
// never polls. The box learns of a change only by looking, so while a sign-in is pending (after
// login, until connected, at most 15 minutes from the first click) it looks every 3 seconds;
// otherwise nothing runs. A recorded exception to the 60 s floor: a person waits, on the box, for a bounded time.

import * as ts from "../names/tailscale.js";
import { ownerDevice } from "../modules/index.js";

const PENDING_MS = 3000;
const PENDING_MAX = 15 * 60_000;
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * personal: a login (name@provider) or a .github/.passkey tailnet; organization: a bare domain.
 * @param {string|null} name the tailnet's name
 */
export function tailnetKind(name) {
  const n = String(name || "");
  if (!n) return null;
  return n.includes("@") || /\.(github|passkey)$/.test(n) ? "personal" : "organization";
}

/**
 * Pure: a `tailscale status --json` as the setup page reads it.
 * @param {any} s
 */
export function shape(s) {
  const p = ts.parseStatus(s || {});
  const backend = p.backend;
  const state = backend === "Running" ? "connected" : backend === "NeedsLogin" ? "needs-login" : backend === "NeedsMachineAuth" ? "needs-approval" : "off";
  const tailnet = (s && s.CurrentTailnet && s.CurrentTailnet.Name) || null;
  return {
    state,
    login: p.owner,
    tailnet: tailnet ? String(tailnet) : null,
    tailnetKind: tailnetKind(tailnet),
    ip: p.node ? (p.node.ips.find(i => i.includes(".")) || null) : null,
    node: p.node ? p.node.name : null,
    why: state === "connected" ? null : state === "off" ? (backend ? `Tailscale is ${backend}` : "Tailscale is not running") : state === "needs-login" ? "this server is not signed in to Tailscale" : "Tailscale is holding this server until someone approves it",
  };
}

/**
 * @param {any} ctx
 * @param {{ run?: typeof ts.run, up?: typeof ts.up, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval, now?: () => number }} [seam] tests pass a fake tailscale
 */
export function startTailscale(ctx, { run = ts.run, up = ts.up, setTimer = setInterval, clearTimer = clearInterval, now = Date.now } = {}) {
  /**
   * Positive list. The person's own surfaces (cli, local, deck, capsule), their owner devices (which
   * is also the setup channel's caller), the onboard module, and the person's own model session
   * (mcp:thread:<id>, which the person's chat and assistant run as). Everything else is refused:
   * a guest, another agent, an added module, a bare mcp or anonymous label. The sign-in link that a
   * session may receive is kept out of the recall index (core/recall/indexer.js redactLinks).
   */
  const allowed = (/** @type {any} */ caller, /** @type {any} */ meta, /** @type {string} */ what) => {
    const c = String(caller || "");
    const ok = !(meta && meta.agent) && ((ownerDevice(c) && !/(^|[\s:])(agent|thread):/i.test(c)) || ["cli", "local", "deck", "capsule"].includes(c) || c === "module:onboard" || /^mcp:thread:[^\s:]+$/.test(c));
    if (!ok) throw fail("denied", `${what} is the owner's: from their own surfaces, their devices or their own session`);
  };

  async function read() {
    const r = await run(["status", "--json"], { timeout: 8000 });
    if (r.code === 127) return { state: "off", login: null, tailnet: null, tailnetKind: null, ip: null, node: null, why: "Tailscale is not installed", raw: null };
    let raw;
    try { raw = JSON.parse(r.out); } catch { return { state: "off", login: null, tailnet: null, tailnetKind: null, ip: null, node: null, why: (r.err || r.out).trim().split("\n")[0] || "tailscale status failed", raw: null }; }
    return { ...shape(raw), raw };
  }

  // While a setup session is live and this box has no owner yet, the login that signed this node in
  // becomes the tailnet owner the box serves: whoever opened the sign-in link is the setup page's
  // person. Without it the box's listener would admit nobody at its own address, and the claim
  // (relay.setup.claim) could never reach it. A tagged node has no login and never sets one.
  let ownerSet = false;
  const adoptOwner = async (/** @type {any} */ v) => {
    if (ownerSet || v.state !== "connected" || !v.login || (ctx.config && ctx.config.network && ctx.config.network.owner)) return;
    try {
      const st = /** @type {any} */ (await ctx.call("relay.setup.status", {}));
      if (!st || st.error || !st.data || !["waiting", "paired"].includes(st.data.state)) return;
      const r = /** @type {any} */ (await ctx.call("names.owner", { login: v.login }));
      if (r && !r.error) ownerSet = true;
    } catch {}
  };

  /** @type {string|null} */ let last = null;
  const announce = (/** @type {any} */ v) => {
    adoptOwner(v);
    const key = [v.state, v.login, v.tailnetKind, v.ip].join("|");   // any change counts, but the event says only the state
    if (key === last) return;
    const first = last === null;
    last = key;
    if (first) return;
    try { ctx.events.emit("tailscale.changed", { state: v.state, tailnetKind: v.tailnetKind }); } catch {}
  };

  /** @type {Promise<any>|null} */ let upFlight = null;   // one `tailscale up` at a time, however many clicks
  /** @type {any} */ let timer = null;
  let pendingSince = 0;
  const stopWatching = (cool = false) => { if (timer) { clearTimer(timer); timer = null; if (cool) coolUntil = now() + 60_000; } };
  let coolUntil = 0;
  const watch = () => {
    // 15 minutes from the first click: more clicks do not extend it, and a finished watch rests a minute.
    if (timer || now() < coolUntil) return;
    pendingSince = now();
    timer = setTimer(async () => {
      try {
        const v = await read(); announce(v);
        if (v.state === "connected") stopWatching(); else if (now() - pendingSince > PENDING_MAX) stopWatching(true);
      } catch {}
    }, PENDING_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  ctx.tool("network.tailscale.status", {
      effect: "read",
    description: "This server's Tailscale: off, needs-login, needs-approval (held until someone approves it) or connected, with the login, the tailnet and whether it is personal or an organization's, and the tailnet address.",
    input: { type: "object", properties: {} },
    run: async (_, meta = {}) => {
      allowed(meta.caller, meta, "Tailscale's status");
      const { raw, ...v } = await read();
      announce({ ...v });
      return v;
    },
  });

  ctx.tool("network.tailscale.login", {
      effect: "write", callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module"],
    description: "Start Tailscale's sign-in for this server and answer the link to open, or none when it is already signed in. The link lets whoever opens it put this server on their network, so it is given only to the caller and fetched again on each click.",
    input: { type: "object", properties: {} },
    run: async (_, meta = {}) => {
      allowed(meta.caller, meta, "Tailscale's sign-in");
      let v = await read();
      if (v.state === "connected") return { loginUrl: null, state: v.state };
      // A pending login has its own link in the status; a stopped one needs `up` to make one.
      let loginUrl = v.raw && v.raw.AuthURL ? String(v.raw.AuthURL) : null;
      if (!loginUrl) {
        upFlight = upFlight || up({ wait: 10_000 }).finally(() => { upFlight = null; });
        const r = await upFlight;
        loginUrl = r.loginUrl;
        v = await read();
      }
      announce(v);
      if (v.state !== "connected") watch();
      return { loginUrl: v.state === "connected" ? null : loginUrl, state: v.state };
    },
  });

  ctx.tool("network.tailscale.peers", {
      effect: "read",
    description: "Other devices on this server's network: their node name, addresses, whether they are online and whose login they belong to. The setup page ticks a new computer or phone when one of the owner's appears.",
    input: { type: "object", properties: {} },
    run: async (_, meta = {}) => {
      allowed(meta.caller, meta, "the list of devices");
      const v = await read();
      const peers = v.raw ? ts.parsePeers(v.raw) : [];
      return { login: v.login, peers: peers.map(p => ({ node: p.node, ips: p.ips, online: p.online, login: p.login, tagged: p.tagged, sharee: p.sharee, mine: Boolean(v.login && p.login === v.login) })) };
    },
  });

  return { stop() { stopWatching(); } };
}
