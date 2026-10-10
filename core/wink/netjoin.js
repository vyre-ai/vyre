// @ts-check
// netjoin: a paired server's side of the built-in network. The home hands a server what it needs at adopt time (controlUrl, a one-time join key, the node name it must join as,
// the home's door address) and this joins the home's network with it, dials the door and keeps the link: direct when the node path is up, through the relay otherwise.
//
//   starting | up | failed | no-binary | none      (none: this server was handed no network, so the relay carries everything, which is correct)
//
// Everything is a dependency (createHost, findBinaries), so a test passes fakes and netjoin.real.test.js runs real nodes.
import path from "node:path";
import { createHost as realHost } from "./node/host.js";
import { findBinaries as realFind } from "./netd.js";
import { directKey, relayKeyPair } from "./directkey.js";
import { connect as realRelayConnect } from "../../relay/client/client.js";
import { nodeCrypto } from "../../relay/client/nodecrypto.js";
import { withinOrThrow } from "../../lib/within.js";
import { streamPipe } from "./node/peer-wire.js";
import { PEER_HOME } from "./serverlink.js";

const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The relay way to the home: one kept relay connection with this server's own key (derived from the peer secret, so the home admitted it without being told it) and a `peer` stream opened
 * on it for each connection the host wants. The Noise handshake pins the home's key, so a relay that is not carrying the home's route never gets a stream head.
 * @param {any} h the hand-over (relay, route, box, peerSecret) @param {{ relayConnect?: any, name?: string, openMs?: number, log?: (m: string) => void }} o
 */
function makeRelayPeer(h, o) {
  const kp = relayKeyPair(String(h.peerSecret));
  const keyStore = { get: async () => kp, set: async () => {} };
  /** @type {any} */ let conn = null;
  const open = async () => {
    if (!conn) conn = (o.relayConnect || realRelayConnect)({ relay: String(h.relay), route: String(h.route), box: String(h.box), name: o.name || "a server", crypto: nodeCrypto(), keyStore, backoff: { min: 1000, max: 15_000 } });
    const chan = await withinOrThrow(conn.ready(), o.openMs ?? 10_000, () => Object.assign(new Error("the relay did not answer; check it is on (relay.status) and try again"), { code: "unreachable" }));
    const s = chan.open({ peer: "wink", space: PEER_HOME });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.reset("no answer"); reject(Object.assign(new Error("the home did not accept the peer stream; check the home is on and try again"), { code: "unreachable" })); }, o.openMs ?? 10_000);
      s.onhead = (/** @type {any} */ x) => { clearTimeout(timer); x && x.status === 200 ? resolve(undefined) : reject(Object.assign(new Error(`the home refused the peer stream (${x && x.status})`), { code: x && x.status === 429 ? "rate_limited" : "denied" })); };
      s.onreset = (/** @type {any} */ why) => { clearTimeout(timer); reject(Object.assign(new Error(String(why || "reset")), { code: "unreachable" })); };
    });
    return streamPipe(s);
  };
  return { open, close() { try { if (conn) conn.close(); } catch { /* going down */ } conn = null; } };
}

/**
 * @param {{ root: string, ownHandover: () => any, log?: (m: string) => void, deps?: { createHost?: any, findBinaries?: () => { forwarder: string | null }, relayConnect?: any, },
 *   relayPeer?: (space: string) => Promise<any>, name?: string, graceMs?: number, retryMs?: number, settleMs?: number }} o
 */
export function createNetJoin(o) {
  const log = o.log || (() => {});
  const D = { createHost: realHost, findBinaries: realFind, ...(o.deps || {}) };
  /** @type {{ state: "none" | "no-binary" | "starting" | "up" | "failed", why: string | null, since: number }} */
  const st = { state: "none", why: null, since: Date.now() };
  const set = (/** @type {typeof st.state} */ state, /** @type {string | null} */ why = null) => { st.state = state; st.why = why; st.since = Date.now(); };
  /** @type {any} */ let host = null, link = null, relayLeg = null;
  let sig = "", space = "";
  /** @type {Promise<void>} */ let chain = Promise.resolve();
  let stopped = false;

  async function teardown() {
    const l = link, h = host, r = relayLeg;
    link = null; host = null; relayLeg = null; space = ""; sig = "";
    try { if (l) l.close(); } catch { /* going down */ }
    try { if (r) r.close(); } catch { /* going down */ }
    try { if (h) await h.stopAll(); } catch { /* going down */ }
  }

  async function bring() {
    const h = o.ownHandover();
    const base = h && h.space && h.device && h.peerSecret;
    const direct = base && h.controlUrl && h.authKey && h.hostname;
    const viaRelay = base && h.relay && h.route && h.box;
    if (!direct && !viaRelay) { await teardown(); set("none", null); return; }
    const next = [h.controlUrl || "", h.hostname || "", h.space, h.device, h.peerAddr || "", h.relay || "", h.route || "", h.box || ""].join("\n");
    if (next === sig && (st.state === "up" || st.state === "starting")) return;
    await teardown();
    if (!SPACE_ID.test(String(h.space))) { set("failed", "the home's space id is not usable"); return; }
    const bins = D.findBinaries();
    const canDirect = Boolean(direct && bins.forwarder);
    if (!canDirect && !viaRelay) { set("no-binary", "wink-forwarder is not installed here"); log("wink join: the node program is not installed; the relay carries everything"); return; }
    set("starting");
    sig = next; space = String(h.space);
    try {
      const key = directKey(String(h.peerSecret));
      let relayPeer = o.relayPeer;
      if (!relayPeer && viaRelay) { relayLeg = makeRelayPeer(h, { relayConnect: D.relayConnect, name: o.name, log }); relayPeer = () => relayLeg.open(); }
      host = D.createHost({ root: path.join(o.root, "wink-net", "join"), ...(canDirect ? { forwarderBin: bins.forwarder } : {}), log: (/** @type {string} */ m) => log(`wink join: ${m}`),
        device: { id: String(h.device), sign: key.sign }, ...(relayPeer ? { relayPeer } : {}), ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}),
        // the home gives a joined node its door rule a moment after the node first appears, so the first dial can be early: try the direct path again soon, not after the host's minute for a dead path
        retryMs: o.retryMs ?? 5000 });
      host.addSpace({ id: space, controlUrl: String(h.controlUrl || "http://127.0.0.1:1"), ...(canDirect ? { authKey: String(h.authKey) } : {}), hostname: String(h.hostname || "relay-only"), box: String(h.box || ""), ...(canDirect && h.peerAddr ? { peerAddr: String(h.peerAddr) } : {}) });
      if (canDirect) {
        await host.start(space);
        // the home gives a node its door rule a few seconds after the node first appears (it polls for new nodes), and a dial made before that hangs for its whole timeout: wait a moment
        if ((o.settleMs ?? 4000) > 0) await new Promise(r => setTimeout(r, o.settleMs ?? 4000));
      }
      link = host.connect(space);
      if (typeof link.onchange === "function") link.onchange(() => { const t = link && link.status(); if (t) log(`wink join: link ${t.state}, direct ${t.direct || "-"}, relay ${t.relay || "-"}${t.lastError ? `, last error: ${t.lastError}` : ""}`); });
      set("up", canDirect ? null : direct ? "the node program is not installed here, so the relay carries everything" : "the home handed no network address, so the relay carries everything");
      log(`wink join: ${canDirect ? `joined the home's network as ${h.hostname}` : "linked to the home through the relay"}`);
    } catch (e) {
      const why = String(/** @type {Error} */ (e).message || e).slice(0, 200);
      await teardown();
      set("failed", why);
      log(`wink join: did not join: ${why}`);
    }
  }

  /** (Re)read the hand-over and join, leave or stay. Calls queue, never overlap. */
  const refresh = () => { chain = chain.then(() => (stopped ? undefined : bring())).catch(e => log(`wink join: ${/** @type {Error} */ (e).message}`)); return chain; };

  return {
    start: refresh,
    refresh,
    /** A call on the home through the link (direct when up, the relay otherwise). */
    call: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opt) => { if (!link) throw Object.assign(new Error("this server has no link to its home's network; pair it with its home first (wink.server.code)"), { code: "unavailable" }); return link.call(tool, input, opt); },
    link: () => link,
    host: () => host,
    status() { return { ...st, ...(link ? { link: link.status() } : {}) }; },
    async stop() { stopped = true; await chain.catch(() => {}); await teardown(); },
  };
}
