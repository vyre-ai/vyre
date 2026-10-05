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
import { directKey } from "./directkey.js";

const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {{ root: string, ownHandover: () => any, log?: (m: string) => void, deps?: { createHost?: any, findBinaries?: () => { forwarder: string | null }, },
 *   relayPeer?: (space: string) => Promise<any>, graceMs?: number, retryMs?: number }} o
 */
export function createNetJoin(o) {
  const log = o.log || (() => {});
  const D = { createHost: realHost, findBinaries: realFind, ...(o.deps || {}) };
  /** @type {{ state: "none" | "no-binary" | "starting" | "up" | "failed", why: string | null, since: number }} */
  const st = { state: "none", why: null, since: Date.now() };
  const set = (/** @type {typeof st.state} */ state, /** @type {string | null} */ why = null) => { st.state = state; st.why = why; st.since = Date.now(); };
  /** @type {any} */ let host = null, link = null;
  let sig = "", space = "";
  /** @type {Promise<void>} */ let chain = Promise.resolve();
  let stopped = false;

  async function teardown() {
    const l = link, h = host;
    link = null; host = null; space = ""; sig = "";
    try { if (l) l.close(); } catch { /* going down */ }
    try { if (h) await h.stopAll(); } catch { /* going down */ }
  }

  async function bring() {
    const h = o.ownHandover();
    const ok = h && h.controlUrl && h.authKey && h.hostname && h.space && h.device && h.peerSecret;
    if (!ok) { await teardown(); set("none", null); return; }
    const next = [h.controlUrl, h.hostname, h.space, h.device, h.peerAddr || ""].join("\n");
    if (next === sig && (st.state === "up" || st.state === "starting")) return;
    await teardown();
    if (!SPACE_ID.test(String(h.space))) { set("failed", "the home's space id is not usable"); return; }
    const bins = D.findBinaries();
    if (!bins.forwarder) { set("no-binary", "wink-forwarder is not installed here"); log("wink join: the node program is not installed; the relay carries everything"); return; }
    set("starting");
    sig = next; space = String(h.space);
    try {
      const key = directKey(String(h.peerSecret));
      host = D.createHost({ root: path.join(o.root, "wink-net", "join"), forwarderBin: bins.forwarder, log: (/** @type {string} */ m) => log(`wink join: ${m}`),
        device: { id: String(h.device), sign: key.sign }, ...(o.relayPeer ? { relayPeer: o.relayPeer } : {}), ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}), ...(o.retryMs !== undefined ? { retryMs: o.retryMs } : {}) });
      host.addSpace({ id: space, controlUrl: String(h.controlUrl), authKey: String(h.authKey), hostname: String(h.hostname), box: String(h.box || ""), ...(h.peerAddr ? { peerAddr: String(h.peerAddr) } : {}) });
      await host.start(space);
      link = host.connect(space);
      set("up");
      log(`wink join: joined the home's network as ${h.hostname}`);
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
    call: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opt) => { if (!link) throw Object.assign(new Error("this server has no link to its home's network"), { code: "unavailable" }); return link.call(tool, input, opt); },
    link: () => link,
    host: () => host,
    status() { return { ...st, ...(link ? { link: link.status() } : {}) }; },
    async stop() { stopped = true; await chain.catch(() => {}); await teardown(); },
  };
}
