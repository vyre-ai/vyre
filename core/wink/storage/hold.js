// @ts-check
// The connection a drive's device holds open to its home, and the home's side of it.
//
// A drive's device sits behind a home or office router, so the space's home can never dial it. The device dials out instead and keeps the connection
// (the node host's `connect(space, { serve })`: direct over WireGuard when it can, the relay peer stream when not), and the home calls back down it with
// storage frames for the chunks that device holds. Peer sessions are two-way (core/wink/node/peer-wire.js: either side may call, `serve` answers), so no new
// wire is needed: the home reads each admitted session from the host's `onSession(caller, session)` and keeps the newest open one per device id.
//   device:  holdDrive({ connect, serve, space })        connects, serves frames, and reconnects with exponential backoff when the link stays down
//   home:    createHolds().onSession / .linkTo(device)   linkTo(device).call(tool, input) goes down the connection that device holds; a call made while the
//                                                        device is between connections waits a short while for it to come back, then says unreachable
// Fair queueing is the session's own (peer-wire.js: small calls first, big messages cut into slices that take turns), so a storage frame never starves a ping.

const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * Home side: the connections the devices hold open.
 * `beatMs`: a held session is pinged this often (a connection a NAT dropped quietly shows no pong, and is closed so the device's new one is used).
 * `raceMs`: a call with no answer after this long makes a ping; no pong means the session is dead, it is closed and the call goes down the next one (a call
 * that is only slow, with a pong, is left alone). Calls are tried on at most `attempts` sessions; each frame the pool sends is idempotent by key.
 * @param {{ waitMs?: number, beatMs?: number, raceMs?: number, probeMs?: number, attempts?: number, log?: (m: string) => void }} [o] `waitMs`: how long a call waits for a device that is between connections.
 */
export function createHolds(o = {}) {
  const waitMs = o.waitMs ?? 15_000, beatMs = o.beatMs ?? 10_000, raceMs = o.raceMs ?? 5000, probeMs = o.probeMs ?? 2500, attempts = o.attempts ?? 3, log = o.log || (() => {});
  /** @type {Map<string, any[]>} */ const sessions = new Map();
  /** @type {Map<string, Array<() => void>>} */ const waiting = new Map();
  const idOf = (/** @type {string} */ caller) => String(caller).replace(/^device:/, "");
  const openOne = (/** @type {string} */ id) => { const l = (sessions.get(id) || []).filter(s => !s.closed); if (l.length) sessions.set(id, l); else sessions.delete(id); return l.length ? l[l.length - 1] : null; };

  /** The host's `serveHome({ onSession })`: a device's session was admitted. @param {string} caller @param {any} session */
  function onSession(caller, session) {
    const id = idOf(caller);
    const list = sessions.get(id) || [];
    list.push(session); sessions.set(id, list);
    /** @type {any} */ let beat = null;
    session.onclose = (/** @type {string} */ why) => { if (beat) clearInterval(beat); openOne(id); log(`wink storage: the connection held by ${id} closed (${String(why).slice(0, 60)})`); };
    if (typeof session.ping === "function" && beatMs > 0) {
      let busy = false;
      beat = setInterval(async () => {
        if (busy || session.closed) return; busy = true;
        try { const r = await session.ping(probeMs); if (r === null && !session.closed) { log(`wink storage: the connection held by ${id} did not answer a ping, closing it`); session.close("no pong"); } } catch { /* closed meanwhile */ } finally { busy = false; }
      }, beatMs);
      beat.unref?.();
    }
    for (const w of waiting.get(id) || []) w();
    waiting.delete(id);
  }

  /** Wait up to `ms` for a session of this device. @param {string} id @param {number} ms */
  function until(id, ms) {
    const s = openOne(id);
    if (s) return Promise.resolve(s);
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); resolve(openOne(id)); };
      const t = setTimeout(() => { const l = waiting.get(id) || []; const i = l.indexOf(done); if (i >= 0) l.splice(i, 1); resolve(null); }, ms);
      const l = waiting.get(id) || []; l.push(done); waiting.set(id, l);
    });
  }

  /** One call with a watch: no answer in raceMs makes a ping, and no pong closes the session (the call then rejects as unreachable). */
  function raced(/** @type {any} */ s, /** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opt) {
    return new Promise((resolve, reject) => {
      let done = false;
      const end = (/** @type {(v: any) => void} */ f, /** @type {any} */ v) => { if (done) return; done = true; clearInterval(t); f(v); };
      const t = setInterval(async () => {
        if (done || typeof s.ping !== "function") return;
        let rtt = null; try { rtt = await s.ping(probeMs); } catch { /* closed */ }
        if (done) return;
        if (rtt === null) { log("wink storage: a call got no answer and the connection did not answer a ping, closing it"); try { s.close("no pong"); } catch { /* gone */ } end(reject, err("unreachable", "the connection stopped answering")); }
      }, raceMs);
      s.call(tool, input, opt).then((/** @type {any} */ v) => end(resolve, v), (/** @type {any} */ e) => end(reject, e));
    });
  }

  return {
    onSession,
    /** Is the device connected right now? @param {string} device */
    has: device => Boolean(openOne(idOf(device))),
    /**
     * The channel to a device: `{ call(tool, input, opt) }` down the connection it holds. A call that finds none waits `waitMs` for the device to reconnect.
     * @param {string} device
     */
    linkTo(device) {
      const id = idOf(device);
      return {
        async call(/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {{ timeoutMs?: number }} */ opt = {}) {
          /** @type {any} */ let last = null;
          for (let n = 0; n < attempts; n++) {
            const s = await until(id, waitMs);
            if (!s) throw last || err("unreachable", "That device is not connected to the space's home right now.");
            try { return await raced(s, tool, input, opt); }
            catch (e) { if (!e || e.code !== "unreachable") throw e; last = e; }
          }
          throw last;
        },
      };
    },
  };
}

/**
 * Device side: connect to the home, serve what it calls, and come back after a drop. `connect(space, { serve })` is the node host's (a link with status() and
 * onchange()); it already retries on its own, so this loop only steps in when the link has been down longer than `stuckMs`: it closes it and makes a new one
 * after a wait that doubles from `minMs` to `maxMs` and resets once a link is up. `stop()` ends it.
 * @param {{ connect: (space: string, o: { serve: (tool: string, input: any) => Promise<any> }) => any, serve: (tool: string, input: any) => Promise<any>, space: string,
 *   stuckMs?: number, minMs?: number, maxMs?: number, checkMs?: number, now?: () => number, log?: (m: string) => void }} o
 */
export function holdDrive(o) {
  const stuckMs = o.stuckMs ?? 30_000, minMs = o.minMs ?? 1000, maxMs = o.maxMs ?? 60_000, checkMs = o.checkMs ?? 2000, now = o.now || Date.now, log = o.log || (() => {});
  /** @type {any} */ let link = null;
  /** @type {any} */ let timer = null, wait = null;
  let stopped = false, delay = minMs, downSince = now(), made = 0, recycled = 0;

  function open() {
    if (stopped) return;
    try { link = o.connect(o.space, { serve: o.serve }); made++; downSince = now(); }
    catch (e) { log(`wink storage: could not connect to the home (${String((/** @type {any} */ (e)).code || "failed")})`); link = null; downSince = now(); }
  }
  function check() {
    if (stopped) return;
    const up = link && link.status().state === "up";
    if (up) { delay = minMs; downSince = null; return; }
    if (downSince === null) downSince = now();
    if (wait) return;
    if (!link || now() - downSince >= stuckMs) {
      try { link?.close(); } catch { /* gone */ }
      link = null; recycled++;
      const d = delay; delay = Math.min(maxMs, delay * 2);
      log(`wink storage: the connection to the home is down; trying again in ${Math.round(d / 100) / 10} s`);
      wait = setTimeout(() => { wait = null; open(); downSince = now(); }, d);
      wait.unref?.();
    }
  }
  open();
  timer = setInterval(check, checkMs); timer.unref?.();
  return {
    /** The state the person-facing words need. */
    status: () => ({ up: Boolean(link && link.status().state === "up"), path: link ? link.status().path || null : null, made, recycled, nextWaitMs: delay }),
    /** Resolves when connected. @param {number} [ms] */
    ready: (ms = 45_000) => (link ? link.ready(ms) : Promise.reject(err("unreachable", "not connected"))),
    stop() { stopped = true; if (timer) clearInterval(timer); if (wait) clearTimeout(wait); try { link?.close(); } catch { /* gone */ } link = null; },
  };
}
