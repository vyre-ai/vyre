// @ts-check
// health: how the app reaches its box right now, in the one shape every surface reads
// (plans/tailnet.md 3.9, C5), built from what paths.js and the relay Connection already know.
//
//   { reach: "direct"|"relay"|"none", why, fix?: { action, label }, since, tailnet?: { path, latencyMs } }
//
// "direct" is the tailnet path being current, "relay" is the relay path being current with its
// channel open, "none" is neither. A phone cannot see which route Tailscale took inside, so
// `tailnet` appears only when the caller measured a round trip (`rtt`, as paths.js reports it).
// No timers: the answer is read when asked, and `watch` only remembers when the reach last changed.

const now0 = () => Date.now();

/**
 * One read.
 * @param {any} source a paths object from createPaths (it has .paths), or one relay Connection
 * @param {{ since?: number, rtt?: number|null }} [o] since: when this reach began; rtt: the last measured round trip in ms
 * @returns {{ reach: "direct"|"relay"|"none", why: string, fix?: { action: string, label: string }, since: number,
 *   tailnet?: { path: string, latencyMs: number|null } }}
 */
export function health(source, o = {}) {
  const since = Number.isFinite(o.since) ? /** @type {number} */ (o.since) : now0();
  const rtt = Number.isFinite(o.rtt) ? /** @type {number} */ (o.rtt) : null;
  const retry = { action: "retry", label: "Try again" };
  if (!source) return { reach: "none", why: "The app is not connected to your server.", fix: retry, since };
  const list = Array.isArray(source.paths) ? source.paths : null;
  const cur = list ? list[source.index] : null;

  // A bare Connection: it only ever is the relay.
  const conn = list ? (cur && cur.kind === "relay" ? cur.connection : null) : source;
  const kind = list ? (cur ? cur.kind : null) : "relay";

  if (kind === "direct") {
    // Current is the best path that answered; good === false is a failure not yet moved off.
    if (cur.good === false) return { reach: "none", why: "Your server does not answer over Tailscale.", fix: { action: "open-tailscale", label: "Open Tailscale" }, since };
    return { reach: "direct", why: "Connected to your server over Tailscale.", since,
      ...(rtt !== null ? { tailnet: { path: "direct", latencyMs: rtt } } : {}) };
  }
  if (kind === "relay") {
    const state = conn ? conn.state : "connecting";
    if (state === "open") return { reach: "relay", why: "Connected to your server through Vyre's relay.", since };
    if (state === "connecting") return { reach: "none", why: "Connecting to your server through Vyre's relay.", since };
    return { reach: "none", why: "Cannot reach your server. Check this device's internet connection.", fix: retry, since };
  }
  return { reach: "none", why: "The app is not connected to your server.", fix: retry, since };
}

/**
 * Remember when the reach last changed, so `since` is the start of the current reach. Reads on
 * the paths object's own onstate and on the Connection's, and chains what was there.
 * @param {any} paths from createPaths
 * @param {{ now?: () => number, rtt?: () => number|null }} [o]
 */
export function watch(paths, o = {}) {
  const now = o.now || now0;
  let last = "";
  let at = now();
  const read = () => {
    const h = health(paths, { since: at, rtt: o.rtt ? o.rtt() : null });
    if (h.reach !== last) { if (last) at = now(); last = h.reach; return { ...h, since: at }; }
    return h;
  };
  read();
  return {
    /** The shape now. `since` moves only when the reach does. */
    read: () => read(),
  };
}
