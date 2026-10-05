// @ts-check
// netd: the built-in network, started by the daemon on a server home (DESIGN-wink 4, PLAN-built-in-network, SPEC-wink-network 4.2 to 4.7).
//
// One Headscale per space on this box (supervised, loopback only), the gate in front of it (the only listener anything else reaches), the Wink node
// (wink-forwarder, one process per space) joined to it, and the node host's door answering peers as `device:<eid>`. Nobody installs, signs in to or
// sees any of it; the person sees Wink. This file is the composition: the engines are core/wink/control/headscale.js, control/gate.js and node/host.js.
//
// Honest degradation, never a guess:
//   off          switched off (config wink.network: false, or VYRE_WINK_NET=0)
//   no-binary    the Headscale or the node program is not installed here; the relay carries everything, which is correct
//   starting     the pieces are coming up
//   up           Headscale healthy, the node is joined, the door is listening
//   failed       a piece did not come up; `why` says which, the relay still carries everything
//
// Every engine is a dependency, so a test passes fakes (netd.test.js) and the real one runs under VYRE_WINK_REAL=1 (netd.real.test.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createHeadscale as realHeadscale, headscaleBin as realHeadscaleBin, freePort as realFreePort } from "./control/headscale.js";
import { createGate as realGate } from "./control/gate.js";
import { createHost as realHost } from "./node/host.js";
import { compilePolicy } from "./control/policy.js";
import { createPublicGate as realPublicGate } from "./control/publicgate.js";

/** The port the home's door listens on, on its own node (the peer address a paired server dials is `<node ip>:8443`). */
export const PEER_PORT = 8443;
/** The public gate's default port (config wink.publicPort). Fixed, so a router mapping and the name's address agree on it; 443 needs a person who allows it. */
export const PUBLIC_PORT = 7443;
/** The name a paired device's node joins this network under: derived from the device's id, so the home can tell WHICH device row a node belongs to (Headscale names are lowercase labels). @param {string} device */
export function nodeNameFor(device) { return "w-" + crypto.createHash("sha256").update(String(device)).digest("hex").slice(0, 20); }

const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** First file in `list` that is an executable file, or null. @param {string[]} list */
function firstExecutable(list) {
  for (const f of list) { try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  return null;
}
/** A bare name found on PATH, or an absolute path that is executable. @param {string} name */
function which(name) {
  if (path.isAbsolute(name)) return firstExecutable([name]);
  return firstExecutable((process.env.PATH || "").split(path.delimiter).filter(Boolean).map(d => path.join(d, name)));
}

/** Where the two programs are: env first, then the fixed places the image and the installer put them. @param {NodeJS.ProcessEnv} [env] */
export function findBinaries(env = process.env) {
  // under node --test nothing starts a real program by accident (the same rule as headscaleBin): only an explicit path or VYRE_WINK_REAL=1
  if (env.NODE_TEST_CONTEXT && env.VYRE_WINK_REAL !== "1" && !(env.VYRE_HEADSCALE_BIN && env.VYRE_WINK_FORWARDER_BIN)) return { headscale: null, forwarder: null };
  const hsEnv = env.VYRE_HEADSCALE_BIN;
  const hs = hsEnv ? which(hsEnv) : firstExecutable(["/usr/local/bin/headscale", "/usr/bin/headscale"]);
  const fwdEnv = env.VYRE_WINK_FORWARDER_BIN;
  const fwd = fwdEnv ? which(fwdEnv) : firstExecutable(["/usr/local/bin/wink-forwarder", "/usr/bin/wink-forwarder"]);
  return { headscale: hs, forwarder: fwd };
}

/**
 * @param {{
 *   root: string,                                   this box's Vyre home: state lives in <root>/wink-net
 *   space: () => Promise<string>,                   the home's space id (the node host's space key)
 *   box: () => Promise<string>,                     the home's box id (bound into the device proof)
 *   entry: (eid: string) => Promise<any>,           the live identity-list entry of a device: { eid, kind, pub }
 *   serve?: ((caller: string, tool: string, input: any) => Promise<any>) | null,   the door's dispatcher; none means the node comes up but answers no peers yet
 *   onSession?: (caller: string, session: any) => void,
 *   relayServe?: (caller: string, tool: string, input: any) => Promise<any>,
 *   log?: (m: string) => void,
 *   enabled?: boolean,
 *   retryMs?: number,                               how long to wait before trying again after a failure (default 30 s; 0 tries once)
 *   controlUrl?: string,                            a public https address peers can reach (config wink.controlUrl); without it only this box's own node uses the network
 *   binaries?: { headscale: string | null, forwarder: string | null },
 *   devices?: () => Promise<string[]> | string[],   the ids of the devices that have a live paired row now (core/wink pairing devices): a node reaches the door only while its device has one
 *   name?: () => string | null,                     this box's claimed name ("alex" for alex.vyre.run), for the public gate; none means a loopback-only network
 *   directory?: { acme(token: string): Promise<any>, acmeClear(): Promise<any>, publish(): Promise<any> },   the name directory's DNS calls for this box (names.directory.*)
 *   domain?: string,                                the name's zone (default vyre.run)
 *   ingress?: { hooks: () => number | null | Promise<number | null>, share: () => number | null | Promise<number | null> },   the loopback ports of the hooks listener and the share server: the public gate carries webhooks and share links to them
 *   onIngress?: (base: string | null) => void,      the public https origin for links and webhooks appeared (or went)
 *   publicGate?: boolean,                           false keeps the network loopback-only whatever the name
 *   certDeps?: any,                                 test seam for the public gate ({ deps: { createGate, certs, acme, waitDns } })
 *   gatePort?: number,                              a fixed port for the gate behind a configured control address (config wink.gatePort; a router forward or a test names it); default a free one
 *   publicPort?: number,                            the public gate's port (default 7443)
 *   publish?: boolean,                              publish the name's address without the outside check (config wink.publish)
 *   acme?: string,                                  "production", "staging" or a test CA's directory URL
 *   relayUrl?: string,                              the relay used for the outside reachability check
 *   reach?: any,                                    createReach (core/wink/reach.js) result, or a function creating it
 *   deps?: { createHeadscale?: any, createGate?: any, createHost?: any, createPublicGate?: any, freePort?: () => Promise<number> },
 * }} o
 */
export function createNetd(o) {
  const log = o.log || (() => {});
  const retry = { retryMs: 30_000, ...o };
  const D = { createHeadscale: realHeadscale, createGate: realGate, createHost: realHost, createPublicGate: realPublicGate, freePort: realFreePort, ...(o.deps || {}) };
  /** @type {{ state: "off" | "no-binary" | "starting" | "up" | "failed", why: string | null, since: number }} */
  const st = { state: "starting", why: null, since: Date.now() };
  const set = (/** @type {typeof st.state} */ state, /** @type {string | null} */ why = null) => { st.state = state; st.why = why; st.since = Date.now(); };
  /** @type {any} */ let hs = null, gate = null, host = null, reach = null, pub = null;
  /** @type {string} */ let space = "";
  /** @type {string} */ let control = "";
  /** @type {string[]} */ let ips = [];
  /** @type {Promise<void> | null} */ let starting = null;
  let stopped = false;
  /** @type {any} */ let retryTimer = null;
  /** @type {(() => void) | null} */ let wake = null;

  /** The node host with no program behind it: status and the relay path still work, a join says plainly the node program is missing. */
  const bareHost = () => D.createHost({ root: path.join(o.root, "wink-net", "node"), log });

  async function bringUp() {
    if (o.enabled === false) { host = bareHost(); return set("off", "switched off"); }
    const bins = o.binaries || findBinaries();
    if (!bins.headscale || !bins.forwarder) {
      host = bareHost();
      const missing = [!bins.headscale && "headscale", !bins.forwarder && "wink-forwarder"].filter(Boolean).join(" and ");
      log(`wink net: ${missing} not installed here; the relay carries everything`);
      return set("no-binary", `${missing} not installed`);
    }
    space = await o.space();
    if (!SPACE_ID.test(space)) throw new Error("this home has no usable space id yet");
    const box = await o.box();
    const dir = path.join(o.root, "wink-net");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // the public face. The loopback gate always runs (the home's own node joins through it). With a configured control address (wink.controlUrl) the gate is the one exposed piece;
    // otherwise, a box with a name gets a second, TLS gate on the public port (control/publicgate.js) whose address is https://<name>.vyre.run:<port>. A box with no name yet stays
    // loopback-only and says so; the relay carries everything meanwhile.
    const gatePort = o.gatePort || await D.freePort();
    const nameNow = o.name ? o.name() : null;
    const pubPort = o.publicPort || PUBLIC_PORT;
    const publicUrl = o.controlUrl ? String(o.controlUrl) : "";
    const wantPublic = !publicUrl && Boolean(nameNow) && Boolean(o.directory) && o.publicGate !== false;
    control = publicUrl || (wantPublic ? `https://${nameNow}.${o.domain || "vyre.run"}:${pubPort}` : `http://127.0.0.1:${gatePort}`);
    const hsPort = await D.freePort();
    hs = D.createHeadscale({ dir: path.join(dir, "hs"), serverUrl: control, bin: bins.headscale, listenPort: hsPort, onLog: (/** @type {string} */ l) => log(`headscale: ${l}`) });
    await hs.start();
    gate = D.createGate({ listen: { host: publicUrl ? "0.0.0.0" : "127.0.0.1", port: gatePort }, tls: null, upstream: { port: hs.listen ? hs.listen.port : hsPort }, onEvent: (/** @type {any} */ e) => { if (e && e.type !== "accept") log(`gate: ${e.type}${e.addr ? " " + e.addr : ""}`); } });
    await gate.listen();
    /** The ports the reachability helper must open: the public gate's when there is one, else the loopback gate's (a configured control address). */
    const reachPort = wantPublic ? pubPort : gatePort;
    const reachNow = () => Boolean(reach && reach.status && reach.status().state === "direct");
    if (!publicUrl && o.directory && o.publicGate !== false) {
      pub = D.createPublicGate({
        name: () => (o.name ? o.name() : null), domain: o.domain, dir: path.join(dir, "certs"), directory: o.directory || { acme: async () => { throw new Error("no directory"); }, acmeClear: async () => {}, publish: async () => {} },
        upstream: { port: hs.listen ? hs.listen.port : hsPort }, listen: { host: "0.0.0.0", port: pubPort }, ...(o.acme ? { acme: o.acme } : {}), ...(o.publish ? { publish: true } : {}), ...(o.ingress ? { ingress: o.ingress, onIngress: (/** @type {string | null} */ b) => { if (o.onIngress) o.onIngress(b); } } : {}),
        reachable: reachNow, log, ...(o.certDeps || {}),
      });
      // started in the background below: a certificate can take a minute, and the network does not wait for it
    }
    // the reachability helper (UPnP, NAT-PMP, IPv6, relay): optional and best effort; it never blocks the network from coming up. It maps a port on the person's router only for a gate that is
    // listening in public: a configured control address (wink.controlUrl, the gate binds every address), or the public gate once it is up with its certificate. A box with no name yet, or with the
    // public gate off, has only the loopback gate, and nothing is ever mapped for that (NW2-2).
    const startReach = async () => {
      if (reach || stopped) return;
      try {
        const mk = (/** @type {any} */ x) => ({ ...x, onchange: (/** @type {any} */ s) => { try { x.onchange && x.onchange(s); } catch { /* a listener */ } if (pub) pub.reachChanged().catch(() => {}); } });
        const r = typeof o.reach === "function" ? o.reach(mk({ log, ports: [{ port: reachPort, proto: "tcp" }] })) : o.reach;
        reach = r || (o.reach === undefined ? await loadReach(reachPort) : null);
        if (reach && reach.start) Promise.resolve(reach.start()).catch(e => log(`wink net: reach did not start: ${/** @type {Error} */ (e).message}`));
      } catch (e) { log(`wink net: reach unavailable: ${/** @type {Error} */ (e).message}`); }
    };
    if (publicUrl) await startReach();
    if (pub) Promise.resolve(pub.start()).then(s => { if (s && s.state === "up") return startReach(); return undefined; }).catch(e => log(`wink net: public gate: ${/** @type {Error} */ (e).message}`));

    // the node: one wink-forwarder process joined with a one-time key; the door answers peers as device:<eid>
    host = D.createHost({ root: path.join(dir, "node"), forwarderBin: bins.forwarder, log });
    const key = await hs.createPreauthKey({ ttlMs: 120_000 });
    host.addSpace({ id: space, controlUrl: `http://127.0.0.1:${gatePort}`, authKey: key.key, hostname: `home-${space.slice(0, 20).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`, box, peerPort: PEER_PORT });
    const up = await host.start(space);
    ips = up.ips || [];
    if (o.serve) {
      await host.serveHome(space, { identity: { entry: o.entry }, serve: o.serve, relayServe: o.relayServe || o.serve, ...(o.onSession ? { onSession: o.onSession } : {}) });
    } else log("wink net: no door dispatcher yet; the node is up and answers no peers");
    if (stopped) return;
    await syncPolicy().catch(e => log(`wink net: policy: ${/** @type {Error} */ (e).message}`));
    set("up");
    log(`wink net: up, node ${ips.join(" ") || "no address"}`);
  }

  /** @param {number} gatePort */
  async function loadReach(gatePort) {
    let m;
    try { m = await import("./reach.js"); } catch { return null; }
    if (typeof m.createReach !== "function") return null;
    // the outside check goes to the relay this box already uses (a self-hosted one answers /v1/reach/check; the hosted one does not, and then nothing is called direct)
    const url = String((o.relayUrl || "") || (o.ctx && o.ctx.config && o.ctx.config.relay && o.ctx.config.relay.url) || "").replace(/^ws/, "http");
    const verify = url && typeof m.relayVerifier === "function" ? m.relayVerifier(url) : undefined;
    return m.createReach({ log, ports: [{ port: gatePort, proto: "tcp" }], ...(verify ? { verify } : {}), onchange: () => { if (pub) pub.reachChanged().catch(() => {}); } });
  }

  const v4 = (/** @type {string[] | undefined} */ l) => (l || []).find(x => /^\d+\.\d+\.\d+\.\d+$/.test(x)) || null;
  /**
   * The network half of the grants: this home is the hub, and a node is a device only while its paired device row exists. A node joined with a one-time key under the name
   * nodeNameFor(device) the pairing handed out; it gets a rule that reaches the hub's door port (control/policy.js, deny by default) only when `o.devices()` lists that device,
   * so removing the row takes the rule away on the next sync and the node itself is deleted. A node whose name matches no row is bound to nothing: it reaches nothing, and once no
   * join key is outstanding it is deleted. WHO the device is stays decided at the door by its identity-list key.
   */
  async function syncPolicy() {
    if (!hs) return { changed: false };
    const nodes = await hs.listNodes();
    const homeIp = v4(ips);
    if (!homeIp) return { changed: false };
    const live = new Set((await Promise.resolve(o.devices ? o.devices() : [])).map(nodeNameFor));
    const others = nodes.filter((/** @type {any} */ n) => v4(n.ips) && v4(n.ips) !== homeIp);
    const bound = others.filter((/** @type {any} */ n) => live.has(String(n.name)) || live.has(String(n.givenName)));
    const stray = nodes.filter((/** @type {any} */ n) => !bound.includes(n) && n.ips && v4(n.ips) !== homeIp && Date.now() > joinUntil);
    for (const n of stray) await hs.deleteNode(n.id).catch((/** @type {Error} */ e) => log(`wink net: could not delete node ${n.id}: ${e.message}`));
    const rows = [{ id: "home", kind: /** @type {const} */ ("hub"), bound: true, ip: homeIp },
      ...bound.map((/** @type {any} */ n) => ({ id: `d-${n.id}`, kind: /** @type {const} */ ("device"), bound: true, ip: v4(n.ips) }))];
    const text = compilePolicy({ rows, hubPort: PEER_PORT, jobPort: PEER_PORT, ...(hs.prefix ? { prefix: hs.prefix } : {}) }).text;
    return hs.setPolicy(text);
  }
  let joinUntil = 0;
  /** @type {any} */ let watch = null;
  /** After a join key is handed out, look for the new node every 2 s until the key's life is over (the node appears when the device uses its key; nothing says when). Authorization is not the poll's: a node only gets a rule while its device row exists. Nothing recurs once no key is outstanding. @param {number} ttlMs */
  function watchJoin(ttlMs) {
    if (watch) clearInterval(watch);
    const end = Date.now() + ttlMs + 5000;
    joinUntil = Math.max(joinUntil, end);
    watch = setInterval(() => { if (stopped || Date.now() > end) { clearInterval(watch); watch = null; if (!stopped) syncPolicy().catch(() => {}); return; } syncPolicy().catch(e => log(`wink net: policy: ${/** @type {Error} */ (e).message}`)); }, 2000);
    watch.unref && watch.unref();
  }

  async function teardown() {
    if (watch) { clearInterval(watch); watch = null; }
    for (const f of [() => pub && pub.stop(), () => reach && reach.stop && reach.stop(), () => host && host.stopAll(), () => gate && gate.close(), () => hs && hs.stop()]) {
      try { await Promise.race([Promise.resolve().then(f), new Promise((_, rej) => { const t = setTimeout(() => rej(new Error("timed out")), 5000); t.unref && t.unref(); })]); } catch (e) { log(`wink net: stopping: ${/** @type {Error} */ (e).message}`); }
    }
  }

  /** One try; a failure (the relay has no route yet, a port taken) is retried every `retryMs` while the box runs, the relay carrying everything meanwhile. */
  async function attempt() {
    for (;;) {
      try { await bringUp(); return; }
      catch (e) {
        set("failed", String((e && e.message) || e).slice(0, 300)); log(`wink net: ${st.why}`);
        await teardown(); hs = gate = reach = pub = null; if (!host) host = bareHost();
        if (stopped || !(retry.retryMs > 0)) return;
        await new Promise(r => { wake = r; retryTimer = setTimeout(r, retry.retryMs); });
        if (stopped) return;
        host = null; set("starting");
      }
    }
  }

  return {
    /** Start in the background: the module's own start never waits for a Headscale. Resolves when the attempt has finished, whichever way. */
    start() {
      if (!starting) starting = attempt();
      return starting;
    },
    async stop() { stopped = true; if (retryTimer) clearTimeout(retryTimer); if (wake) wake(); if (starting) await starting.catch(() => {}); await teardown(); },
    /** The box's name changed (claimed, released): the network starts again so the control address and the public gate follow it. */
    async nameChanged() {
      if (stopped || !starting) return;
      await starting.catch(() => {});
      await teardown(); hs = gate = reach = pub = null; host = null; set("starting");
      starting = attempt();
      return starting;
    },
    /** The public origin for webhooks and share links, in the words `wink.network.status` carries: up (with the base), no-name, getting-cert, failed, off. */
    ingress() {
      if (o.ingress === undefined) return { state: "off", base: null, why: "public links are not wired on this box" };
      const ps = pub ? pub.status() : null;
      if (!ps) return { state: "off", base: null, why: o.controlUrl ? "this box is reached through a configured address, not a public gate" : "no public gate" };
      const base = pub.ingressBase();
      if (base) return { state: "up", base };
      if (ps.state === "up") return { state: "waiting", base: null, why: "the gate is up but this box's name does not point at it yet (the outside check has not reached it, or it is behind a router that does not forward the port)" };
      return { state: ps.state, base: null, ...(ps.why ? { why: ps.why } : {}) };
    },
    /** The node host (status, whois, join, leave, acceptRelay): always present once start() has been called. */
    host: () => host,
    /** What `wink.network.status` and the doctor read, in plain fields. */
    status() {
      return {
        state: st.state, why: st.why, since: st.since, space: space || null, ips, controlUrl: control || null,
        public: Boolean(o.controlUrl) || Boolean(pub && pub.status().state === "up"), publicGate: pub ? pub.status() : null, reach: reach && reach.status ? reach.status() : null,
      };
    },
    /**
     * What a server being paired needs to reach this home (composeWinkHome's handoverSource, createWink's `handover`): the control address and a one-time join key,
     * or null when the network is not up or has no address another machine can reach (the pairing then hands over only the device id and the relay carries everything).
     * @param {{ target?: any, device?: string }} [_q]
     */
    /** A one-time join key for a node that will reach this network on `controlUrl`, in memory only, and the watch that gives the new node its door rule. For in-process callers (the pairing's hand-over, the real test); never a tool. @param {number} [ttlMs] @param {string} [device] the paired device the key is for: its node must join as nodeNameFor(device) */
    async joinKey(ttlMs = 120_000, device) {
      if (st.state !== "up" || !hs) throw Object.assign(new Error("the network is not up"), { code: "unavailable" });
      const key = await hs.createPreauthKey({ ttlMs });
      watchJoin(ttlMs);
      return key.key;
    },
    /** A device row was added or removed: give or take away the node's rule now. */
    deviceChanged() { return syncPolicy().catch(e => { log(`wink net: policy: ${/** @type {Error} */ (e).message}`); }); },
    syncPolicy,
    async handover(_q) {
      // an address another machine can reach: the configured one, or the public gate's once it is up AND its name points here (published); else nothing, the relay carries everything
      const ps = pub ? pub.status() : null;
      const url = o.controlUrl ? String(o.controlUrl) : ps && ps.state === "up" && ps.published ? pub.controlUrl() : null;
      if (st.state !== "up" || !hs || !url) return null;
      const key = await hs.createPreauthKey({ ttlMs: 300_000 });
      watchJoin(300_000);
      return { controlUrl: url, authKey: key.key, space, box: await o.box(), ...(v4(ips) ? { peerAddr: `${v4(ips)}:${PEER_PORT}` } : {}), ...(ps && ps.pin && !o.controlUrl ? { pin: ps.pin } : {}), ...(_q && _q.device ? { hostname: nodeNameFor(String(_q.device)) } : {}) };
    },
  };
}
