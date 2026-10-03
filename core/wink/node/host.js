// @ts-check
// host: the embedded node host behind the Wink module and the runner (DESIGN-wink section 8, spec 4.7).
//
// One embedded node per space the person's identity has a grant for, each its own control URL, key
// and state directory. Here every node is one wink-forwarder process (wink/forwarder): per space on
// a box, as the spike recommended, and the same on a desktop, where a node's crash then costs one
// space and not all of them. The forwarder is the node: it listens for peers (the home side) and
// dials out on a Unix socket of its own (the paired-server side). Nothing in this file touches a
// Tailscale the person installed, a system route or a resolver.
//
// What it gives callers:
//   host.addSpace({...}); await host.start(id);          join a space's network
//   host.serveHome(id, {...})                            answer peers: direct ones through the forwarder, relay ones through acceptRelay
//   const link = host.connect(id, {...})                 a channel to that space's home:
//     await link.call(tool, input)                       a registry tool call on the home
//     link.status()                                      { state, path: "direct" | "relay" | null, ... }
//
// The path is chosen at application level (SPIKE-wink.md verdict 5). A tsnet dial with no path takes
// 25 s to fail, so the direct dial starts first and, when it is not up within graceMs (3 s), the
// relay peer stream starts too. The first answer carries the calls; direct is preferred as soon as
// it is up, and the relay stream is closed when it is no longer the way in. A dead direct path is
// retried at most once a minute while the relay carries the work.

import net from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { listenPeers } from "./peer-channel.js";
import { peerSession, socketPipe, admitPeer, joinPeer, streamPipe } from "./peer-wire.js";

export const GRACE_MS = 3000;
export const DIRECT_RETRY_MS = 60_000;
/** A direct link that has been silent this long is probed by a ping before a call, and while it is up and idle every this often. */
export const PROBE_MS = 20_000;
/** A direct call with no answer for this long makes the link ping; no pong means the path is dead and the call moves to the relay stream. */
export const RACE_MS = 5000;

const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const err = (code, message) => Object.assign(new Error(message), { code });

/** Read one line from a socket, then hand back the rest. @param {net.Socket} sock @param {number} timeoutMs @returns {Promise<{ line: string, rest: Buffer }>} */
function readLine(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (/** @type {Error|null} */ e, /** @type {any} */ v) => { clearTimeout(timer); sock.off("data", onData); sock.off("close", onClose); sock.off("error", onErr); sock.pause(); e ? reject(e) : resolve(v); };
    const timer = setTimeout(() => done(err("timeout", "no answer from the node"), null), timeoutMs);
    const onData = (/** @type {Buffer} */ c) => {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf(10);
      if (i >= 0) { if (i > 4096) return done(err("bad_input", "answer too long"), null); done(null, { line: buf.subarray(0, i).toString("utf8"), rest: buf.subarray(i + 1) }); }
      else if (buf.length > 4096) done(err("bad_input", "answer too long"), null);
    };
    const onClose = () => done(err("unreachable", "the node closed the connection"), null);
    const onErr = (/** @type {Error} */ e) => done(err("unreachable", e.message), null);
    sock.on("data", onData); sock.on("close", onClose); sock.on("error", onErr);
  });
}

/**
 * @typedef {{ id: string, controlUrl: string, authKey?: string, hostname: string, box: string,
 *   peerPort?: number, peerAddr?: string }} SpaceSpec
 *   box: the home's id (bound into the device proof). peerPort: the port this node listens on as a home.
 *   peerAddr: "100.x.y.z:port", where a paired server finds the home's door.
 * @typedef {{ nodeKey: string, ips: string[] }} NodeUp
 * @typedef {{ call: (tool: string, input?: any, opt?: { timeoutMs?: number }) => Promise<any>, ping: (t?: number) => Promise<number|null>, status: () => any, close: () => void, onchange: (f: () => void) => void, ready: () => Promise<void> }} SpaceLink
 */

/**
 * @param {{ root: string, forwarderBin?: string, spawn?: typeof nodeSpawn, log?: (m: string) => void, graceMs?: number, retryMs?: number,
 *   device?: { id: string, sign: (message: Buffer) => Promise<string> | string },
 *   relayPeer?: (space: string) => Promise<import("./peer-wire.js").Pipe>, probeMs?: number, raceMs?: number, pingMs?: number, probeWaitMs?: number }} deps
 *   device: this machine's eid on the owner's identity list and a signer with the key on that entry (the proof on the direct path; peer-wire.js).
 *   relayPeer: opens a `peer` stream to the home through the relay and returns it as a pipe (the relay client's channel.open({peer: "wink", space})).
 */
export function createHost(deps) {
  const log = deps.log || (() => {});
  const graceMs = deps.graceMs ?? GRACE_MS;
  const retryMs = deps.retryMs ?? DIRECT_RETRY_MS;
  const probeMs = deps.probeMs ?? PROBE_MS;
  const raceMs = deps.raceMs ?? RACE_MS;
  const pingMs = deps.pingMs ?? 3000;
  const probeWait = deps.probeWaitMs ?? 2000;
  const spawnFn = deps.spawn || nodeSpawn;
  fs.mkdirSync(deps.root, { recursive: true, mode: 0o700 });
  /** @type {Map<string, { spec: SpaceSpec, dir: string, proc: any, up: NodeUp | null, door: any, serve: any, identity?: any, onSession?: any }>} */
  const spaces = new Map();
  /** @type {Set<SpaceLink>} */
  const links = new Set();

  const dirOf = (/** @type {string} */ id) => path.join(deps.root, id);
  const dialSock = (/** @type {string} */ id) => path.join(dirOf(id), "run", "dial.sock");
  const peerSock = (/** @type {string} */ id) => path.join(dirOf(id), "run", "peer.sock");

  /** Register a space. Nothing runs until start(). @param {SpaceSpec} spec */
  function addSpace(spec) {
    if (!SPACE_ID.test(spec.id)) throw err("bad_input", "a space id is letters, digits, - and _");
    if (spaces.has(spec.id)) throw err("bad_input", `space ${spec.id} is already added`);
    const dir = dirOf(spec.id);
    fs.mkdirSync(path.join(dir, "run"), { recursive: true, mode: 0o700 });
    spaces.set(spec.id, { spec, dir, proc: null, up: null, door: null, serve: null });
  }

  /** Start the space's node. Resolves when the forwarder reports ready. @param {string} id @returns {Promise<NodeUp>} */
  async function start(id) {
    const sp = spaces.get(id);
    if (!sp) throw err("not_found", `no space ${id}`);
    if (sp.up) return sp.up;
    if (!deps.forwarderBin) throw err("unavailable", "the Wink node program is not installed");
    const args = ["-state-dir", path.join(sp.dir, "ts"), "-control-url", sp.spec.controlUrl, "-hostname", sp.spec.hostname, "-dial-sock", dialSock(id)];
    if (sp.spec.authKey) {
      const f = path.join(sp.dir, "authkey");
      fs.writeFileSync(f, sp.spec.authKey, { mode: 0o600 });
      args.push("-auth-key-file", f);
    }
    if (sp.spec.peerPort) args.push("-listen", `${sp.spec.peerPort}=${peerSock(id)}`);
    const proc = spawnFn(deps.forwarderBin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TS_NO_LOGS_NO_SUPPORT: "true", TS_AUTHKEY: "", TS_AUTH_KEY: "" } });
    sp.proc = proc;
    /** @type {NodeUp} */
    const up = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(err("timeout", "the node did not come up")), 120_000);
      proc.stdout.on("data", (/** @type {Buffer} */ c) => {
        buf += c.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.event === "ready") { clearTimeout(timer); resolve({ nodeKey: j.nodeKey, ips: j.ips || [] }); }
          else if (j.event === "error") { clearTimeout(timer); reject(err("unavailable", `${j.what}: ${j.error}`)); }
          else log(`wink node ${id}: ${line.slice(0, 200)}`);
        }
      });
      proc.stderr?.on("data", (/** @type {Buffer} */ c) => log(`wink node ${id}: ${c.toString("utf8").trim().slice(0, 300)}`));
      proc.on("close", (/** @type {number|null} */ code) => { clearTimeout(timer); sp.up = null; sp.proc = null; reject(err("unavailable", `the node stopped (${code})`)); });
    });
    sp.up = up;
    return up;
  }

  /** The leg a home call really arrived on, set by the door that accepted it (never read from the request): "wink" for the direct node door, "relay" for the relay peer stream. */
  const legOf = new AsyncLocalStorage();
  /** For the kernel's withKernelCall `pathOf`: "wink" only inside a call the direct door accepted; the relay door, and anything unknown, is "relay". @param {string} [_caller] @returns {"wink" | "relay"} */
  const pathOf = _caller => (legOf.getStore() === "wink" ? "wink" : "relay");

  /**
   * The home side: answer peers for this space. Direct peers come through the forwarder's door and
   * must prove the device key; relay peers come from the bridge's peer stream (acceptRelay) already
   * authenticated by the channel. `serve(caller, tool, input)` is the registry (ctx.call as that caller).
   *
   * `identity.entry(eid)` is the live identity list (the chain through the identity module; a fake in tests): the key a direct peer must prove is the key on
   * its entry, and every call on a direct or relay session re-reads the entry first, so a removed device is refused at once. The caller is `device:<eid>` on both paths.
   * `peers.serve(serve)` still wraps the dispatcher: a direct call reaches the wrapper with `{ nodeKey, stableId }` of the connection that just proved the device key,
   * and a relay call carries no node key and binds nothing. `relayServe` is the relay door's own dispatcher (the chain can then record "relay" as the path).
   * @param {string} id
   * `onSession(caller, session)` is told of each admitted peer session (direct or relay): the home calls back on a connection a drive's device holds open
   * (that device sits behind its own router; the home never dials it). `session.call(tool, input, opt)` is the same call the device could make.
   * @param {{ onSession?: (caller: string, session: any) => void, relayServe?: (caller: string, tool: string, input: any) => Promise<any>, identity: { entry: import("./peer-wire.js").EntryPort }, serve: (caller: string, tool: string, input: any) => Promise<any>,
   *   peers?: { serve: (inner: any) => (caller: string, tool: string, input: any, proof?: { nodeKey?: string, stableId?: string }) => Promise<any> } }} o
   */
  async function serveHome(id, o) {
    const sp = spaces.get(id);
    if (!sp) throw err("not_found", `no space ${id}`);
    sp.identity = o.identity || null;
    const wrapped = o.peers ? o.peers.serve(o.serve) : null;
    sp.onSession = o.onSession || null;
    sp.serve = { serve: wrapped ? (/** @type {string} */ c, /** @type {string} */ t, /** @type {any} */ i) => wrapped(c, t, i) : o.serve };
    const relayWrapped = o.relayServe ? (o.peers ? o.peers.serve(o.relayServe) : o.relayServe) : null;
    sp.serve.relay = relayWrapped ? (/** @type {string} */ c, /** @type {string} */ t, /** @type {any} */ i) => relayWrapped(c, t, i) : sp.serve.serve;
    if (sp.door || !sp.spec.peerPort) return;
    sp.door = await listenPeers({ path: peerSock(id),
      onRefuse: why => log(`wink ${id}: refused a peer: ${why}`),
      onPeer: (conn, who) => {
        if (who.via !== "direct") { conn.destroy(); log(`wink ${id}: a relay-form header on the node door was refused`); return; }
        const serve = wrapped ? (/** @type {string} */ c, /** @type {string} */ t, /** @type {any} */ i) => legOf.run("wink", () => wrapped(c, t, i, { nodeKey: who.nodeKey, stableId: who.stableId })) : (/** @type {string} */ c, /** @type {string} */ t, /** @type {any} */ i) => legOf.run("wink", () => o.serve(c, t, i));
        if (!o.identity || typeof o.identity.entry !== "function") { conn.destroy(); return; }
        admitPeer(socketPipe(conn), { id: { nodeKey: who.nodeKey }, box: sp.spec.box, entry: o.identity.entry, serve })
          .then(({ session, caller }) => { if (o.onSession) o.onSession(caller, session); })
          .catch(e => log(`wink ${id}: peer not admitted: ${e.message}`));
        conn.resume();
      } });
  }

  /** The bridge's `peers.accept` for this space: a relay peer stream becomes a session served as that device. @param {string} id */
  function acceptRelay(id) {
    return (/** @type {any} */ stream, /** @type {{ deviceId: string }} */ who) => {
      const sp = spaces.get(id);
      if (!sp?.serve) { stream.reset("no peer service"); return; }
      const caller = `device:${who.deviceId}`;
      const session = peerSession(streamPipe(stream), { first: 2, serve: async (tool, input) => {
        // the entry is read again on every call: a device removed after the stream opened is refused at once, whatever the sync allow cache says
        const e = sp.identity ? await sp.identity.entry(who.deviceId) : null;
        if (!e || e.eid !== who.deviceId || e.kind !== "device") { session.close("device removed"); throw err("denied", "this device is no longer on the identity list"); }
        return legOf.run("relay", () => sp.serve.relay(caller, tool, input));
      } });
      if (sp.onSession) try { sp.onSession(caller, session); } catch { /* the listener must not break the stream */ }
    };
  }

  /** Dial the home through this space's node. @param {string} id @param {string} addr @param {number} [timeoutMs] */
  async function dialDirect(id, addr, timeoutMs = 35_000, serve = undefined) {
    const sp = spaces.get(id);
    if (!sp?.up) throw err("unavailable", "this space's node is not running");
    const dev = deps.device;
    if (!dev) throw err("unavailable", "this machine has no device key to prove");
    const sock = net.connect(dialSock(id));
    await new Promise((resolve, reject) => { sock.once("connect", () => resolve(undefined)); sock.once("error", reject); });
    sock.write(JSON.stringify({ addr }) + "\n");
    let rest;
    try {
      const { line, rest: r } = await readLine(sock, timeoutMs);
      rest = r;
      const j = JSON.parse(line);
      if (!j.ok) throw err("unreachable", String(j.error || "no path"));
    } catch (e) { sock.destroy(); throw e; }
    if (rest.length) sock.unshift(rest);
    sock.resume();
    return joinPeer(socketPipe(sock), { device: dev.id, nodeKey: sp.up.nodeKey, sign: dev.sign, ...(serve ? { serve } : {}) });
  }

  /**
   * A channel to a space's home, over whichever path is up. `dial` overrides how the direct path
   * is made (tests, or a different transport).
   * @param {string} id
   * `serve(tool, input)` answers calls the home makes back on this connection (a drive's device holds one open for the home's storage frames).
   * @param {{ dial?: () => Promise<any>, relay?: () => Promise<any>, serve?: (tool: string, input: any) => Promise<any> }} [o]
   * @returns {SpaceLink}
   */
  function connect(id, o = {}) {
    const sp = spaces.get(id);
    if (!sp) throw err("not_found", `no space ${id}`);
    const direct = o.dial || (() => { if (!sp.spec.peerAddr) throw err("unavailable", "the home's address is not known"); return dialDirect(id, sp.spec.peerAddr, undefined, o.serve); });
    const relay = o.relay || (async () => {
      if (!deps.relayPeer) throw err("unavailable", "no relay path is configured");
      const pipe = await deps.relayPeer(id);
      return peerSession(pipe, { first: 1, ...(o.serve ? { serve: o.serve } : {}) });
    });
    /** @type {{ direct: any, relay: any }} */
    const sess = { direct: null, relay: null };
    const st = { direct: /** @type {"idle"|"trying"|"up"|"failed"} */ ("idle"), relay: /** @type {"idle"|"trying"|"up"|"failed"} */ ("idle"), since: Date.now(), lastError: /** @type {string|null} */ (null) };
    /** @type {Array<() => void>} */ const listeners = [];
    /** @type {any[]} */ const waiters = [];
    let closed = false, graceTimer = null, retryTimer = null, relayStartedAt = 0, probeTimer = null, lastOk = 0;
    const changed = () => { for (const f of listeners) try { f(); } catch { /* a listener must not break the link */ } };
    const current = () => (sess.direct && !sess.direct.closed ? "direct" : sess.relay && !sess.relay.closed ? "relay" : null);
    const wake = () => { const p = current(); if (p) for (const w of waiters.splice(0)) w.resolve(p); };

    function tryDirect() {
      if (closed || st.direct === "trying" || st.direct === "up") return;
      st.direct = "trying"; changed();
      if (!graceTimer && !sess.relay && st.relay !== "trying") graceTimer = setTimeout(() => { graceTimer = null; if (st.direct !== "up") tryRelay(); }, graceMs);
      // "up" is said only after a ping round trip: a first session in a fresh Space can connect and then answer nothing.
      Promise.resolve().then(direct).then(async s => {
        const rtt = closed ? 0 : await s.ping(pingMs);
        if (rtt === null) { s.close("no answer"); throw err("unreachable", "the direct path connected but did not answer"); }
        return s;
      }).then(s => {
        if (closed) { s.close(); return; }
        sess.direct = s; st.direct = "up"; st.since = Date.now(); lastOk = Date.now();
        if (probeTimer) clearInterval(probeTimer);
        // an idle link that is in use is probed, so a path that died quietly is noticed before the next call needs it
        probeTimer = setInterval(() => { const d = sess.direct; if (d && Date.now() - lastOk >= probeMs) d.ping(probeWait).then(ms => { if (ms === null) directDead("no answer to a probe"); else lastOk = Date.now(); }, () => {}); }, probeMs);
        probeTimer.unref?.();
        s.onclose = why => {
          sess.direct = null; st.direct = "failed"; st.lastError = String(why);
          if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
          changed();
          if (closed) return;
          tryRelay();
          if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; tryDirect(); }, retryMs); retryTimer.unref?.(); }
          reconnect();
        };
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        // direct is the way in now; let the relay stream go once nothing is waiting on it
        if (sess.relay) { const r = sess.relay; sess.relay = null; st.relay = "idle"; setTimeout(() => r.close("direct is up"), 1000).unref?.(); }
        changed(); wake();
      }, e => {
        st.direct = "failed"; st.lastError = String(e.message); changed();
        // no direct path: the relay must be running, whatever the grace timer says
        if (!closed && !sess.relay && st.relay !== "trying") tryRelay();
        if (!closed) { retryTimer = setTimeout(() => { retryTimer = null; tryDirect(); }, retryMs); retryTimer.unref?.(); }
      });
    }
    function tryRelay() {
      if (closed || st.relay === "trying" || st.relay === "up" || st.direct === "up") return;
      st.relay = "trying"; relayStartedAt = Date.now(); changed();
      Promise.resolve().then(relay).then(s => {
        if (closed || st.direct === "up") { s.close(); st.relay = "idle"; return; }
        sess.relay = s; st.relay = "up";
        if (!sess.direct) st.since = Date.now();
        s.onclose = why => { sess.relay = null; st.relay = "failed"; st.lastError = String(why); changed(); if (!closed && !sess.direct) reconnect(); };
        changed(); wake();
      }, e => { st.relay = "failed"; st.lastError = String(e.message); changed(); void relayStartedAt; });
    }
    /** The direct path stopped answering: close it (onclose starts the relay and the retry). @param {string} why */
    function directDead(why) { const d = sess.direct; if (d && !d.closed) d.close(why); else if (d) { sess.direct = null; } }
    /** One direct call that is watched: no answer in raceMs makes a ping; no pong means the path is dead and the caller retries on the relay. */
    function raceDirect(/** @type {any} */ d, /** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opt) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (/** @type {(v: any) => void} */ f, /** @type {any} */ v) => { if (settled) return; settled = true; clearTimeout(timer); f(v); };
        const timer = setTimeout(async () => {
          if (settled) return;
          const rtt = await d.ping(probeWait).catch(() => null);
          if (settled) return;
          if (rtt !== null) { lastOk = Date.now(); return; } // alive: the call is only slow
          directDead("no answer in " + Math.round(raceMs / 1000) + " s");
          done(reject, Object.assign(err("unreachable", "the direct path stopped answering"), { pathDead: true }));
        }, raceMs);
        timer.unref?.();
        d.call(tool, input, opt).then((/** @type {any} */ v) => { lastOk = Date.now(); done(resolve, v); }, (/** @type {any} */ e) => { if (e && e.code === "unreachable") e.pathDead = true; done(reject, e); });
      });
    }
    function reconnect() { if (closed) return; st.direct = st.direct === "up" ? "idle" : st.direct; setTimeout(() => { if (!closed && !current()) { if (st.relay !== "up") st.relay = "idle"; tryDirect(); } }, 500).unref?.(); }

    tryDirect();
    const link = {
      /** @param {number} [timeoutMs] */
      ready(timeoutMs = 45_000) {
        if (current()) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const w = { resolve: () => { clearTimeout(t); resolve(undefined); } };
          const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(err("unreachable", `no path to the space (direct ${st.direct}, relay ${st.relay}${st.lastError ? `: ${st.lastError}` : ""})`)); }, timeoutMs);
          waiters.push(w);
        });
      },
      async call(/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {{ timeoutMs?: number }} */ opt = {}) {
        if (closed) throw err("unreachable", "this connection is closed");
        const total = opt.timeoutMs ?? 45_000, t0 = Date.now();
        const left = () => Math.max(1000, total - (Date.now() - t0));
        await link.ready(total);
        let p = current();
        if (p === "direct" && Date.now() - lastOk > probeMs) {
          const rtt = await sess.direct?.ping(probeWait).catch(() => null);
          if (rtt === null || rtt === undefined) { directDead("no answer to a probe"); await link.ready(left()); p = current(); } else lastOk = Date.now();
        }
        if (!p) throw err("unreachable", "this connection is closed");
        if (p !== "direct") return sess.relay.call(tool, input, opt);
        try { return await raceDirect(sess.direct, tool, input, opt); }
        catch (e) {
          // the direct path died under this call: once more, on whatever path is up (the relay stream first)
          if (!/** @type {any} */ (e).pathDead || closed) throw e;
          await link.ready(left());
          const q = current();
          if (!q) throw e;
          return sess[/** @type {"direct"|"relay"} */ (q)].call(tool, input, opt);
        }
      },
      async ping(/** @type {number} */ t = 2000) { const p = current(); const r = p ? await sess[/** @type {"direct"|"relay"} */ (p)].ping(t) : null; if (r !== null && p === "direct") lastOk = Date.now(); return r; },
      status() { const p = current(); return { state: p ? "up" : closed ? "closed" : "connecting", path: p, direct: st.direct, relay: st.relay, since: st.since, ...(st.lastError ? { lastError: st.lastError } : {}) }; },
      onchange(/** @type {() => void} */ f) { listeners.push(f); },
      close() {
        closed = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (retryTimer) clearTimeout(retryTimer);
        if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
        for (const k of /** @type {const} */ (["direct", "relay"])) { try { sess[k]?.close("closed"); } catch { /* gone */ } sess[k] = null; }
        for (const w of waiters.splice(0)) w.resolve(null);
        links.delete(link); changed();
      },
    };
    links.add(link);
    return link;
  }

  /** Stop one space's node and its door. @param {string} id */
  async function stop(id) {
    const sp = spaces.get(id);
    if (!sp) return;
    if (sp.door) { await sp.door.close(); sp.door = null; }
    const proc = sp.proc;
    if (proc && !proc.killed) { proc.kill("SIGTERM"); await new Promise(r => { const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } r(undefined); }, 3000); proc.once("exit", () => { clearTimeout(t); r(undefined); }); }); }
    sp.up = null; sp.proc = null;
  }
  async function stopAll() { for (const l of [...links]) l.close(); for (const id of spaces.keys()) await stop(id); }
  const info = (/** @type {string} */ id) => { const sp = spaces.get(id); return sp ? { id, up: sp.up, spec: sp.spec } : null; };

  return { addSpace, start, serveHome, acceptRelay, pathOf, connect, stop, stopAll, info, dialSock, peerSock };
}
