// @ts-check
// wink.network.*: what the person's network looks like, in Wink's words, and the two things they can do to it (spec 4.7, TAILSCALE-removal step 1).
// These four are the Wink module's INTERNAL tools (reach modules, caller module:network only). The names the surfaces call are network.wink.status, .whois, .join and .leave,
// registered by the network module (core/network/wink.js), which owns the `network.` prefix; a module's tools must start with its own name, so the Wink module cannot hold them.
// The network module does the owner's check and the person's presence; these do the work.
//
//   wink.network.status   one read: signed in, and per space whether this machine's node is up, the path (direct or through the relay), the relay, the peer door,
//                         the storage devices and the clock. Read-only: it asks the node host, the relay and the storage tools and writes nothing.
//   wink.network.whois    who is the peer at an address or with a device id: the device, its identity, its kind and its space. Taken only from the identity list's
//                         entry and from the sessions the node host admitted, never from tags or host information a peer could set.
//   wink.network.join     bring up this machine's link to a space it has a way into (the node host's connect, with the person present).
//   wink.network.leave    take it down again.
//
// Every dependency is a port, so a test passes fakes and the composition root passes the real ones; a port that is absent says so ("unknown"), it is never guessed.
//   storage   { status(): Promise<{ devices }> }   the storage devices (core/wink/storage), looked at without forcing a new probe
//   host      the node host (core/wink/node/host.js), or a function returning it: status(), whois(), info(), addSpace(), start(), connect(), stop()
//   identity  { self?(): { signedIn, name?, id?, devices? }, entry(eid): { eid, kind, deviceKind?, identity?, name? } }   the live identity list
//   spaces    { spec(space): SpaceSpec | null, name?(space): string }   what a join needs to know about a space (control address, one-time key)
//   clock     () => { skewMs: number | null }   how far this clock is from the relay's
//   relayPing () => Promise<number | null>      a round trip to the relay in ms
//   otherVpn  () => Promise<boolean>            another VPN of the person's own runs here: join then stays relay-only (core/network/other-vpn.js)

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const SPACE = /^[A-Za-z0-9_-]{1,64}$/;
const within = (/** @type {Promise<any>} */ p, /** @type {number} */ ms, /** @type {any} */ fallback) => { let t; return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise(r => { t = setTimeout(() => r(fallback), ms); })]).finally(() => clearTimeout(t)); };
const data = (/** @type {any} */ r) => (r && typeof r === "object" && "data" in r ? r.data : r);

/** Only the network module may call these: it has done the owner's check and the person's presence. @param {any} meta @param {string} what */
function networkModule(meta, what) {
  if (String((meta && meta.caller) || "") !== "module:network") throw fail("denied", `${what} comes through the network module`);
}

/**
 * @param {any} ctx @param {{ host?: any, storage?: { status: (o?: any) => Promise<any> }, identity?: any, spaces?: any, clock?: () => any, relayPing?: () => Promise<number | null>, otherVpn?: () => Promise<boolean>, now?: () => number, pingMs?: number }} [deps]
 */
export function createNetwork(ctx, deps = {}) {
  const now = deps.now || Date.now;
  const pingMs = deps.pingMs ?? 1500;
  const hostOf = () => { const h = typeof deps.host === "function" ? deps.host() : deps.host; return h || null; };
  /** Links this module made with join, by space. @type {Map<string, any>} */
  const joined = new Map();
  /** Spaces this module joined relay-only, and why. @type {Map<string, string>} */
  const relayOnly = new Map();
  const nameOf = (/** @type {string} */ id) => { try { return (deps.spaces && deps.spaces.name && deps.spaces.name(id)) || id; } catch { return id; } };

  /** One space's state in the words of spec 4.7: connected, relayed, offline or joining. @param {any} sp @param {number | null} rtt */
  function spaceView(sp, rtt) {
    const link = sp.links[0] || null;
    /** @type {"connected" | "relayed" | "offline" | "joining"} */
    let state;
    let why = null;
    if (link) {
      state = link.state === "up" ? (link.path === "direct" ? "connected" : "relayed") : link.state === "connecting" ? "joining" : "offline";
      if (state !== "connected" && link.lastError) why = String(link.lastError);
    } else state = sp.node === "up" ? "connected" : "offline";
    const refused = Boolean(link && link.lastError && /unknown device|proof|no longer on the identity list|denied/i.test(String(link.lastError)));
    return {
      id: sp.id, name: nameOf(sp.id), state, node: sp.node, path: link ? link.path : null, latencyMs: rtt, peers: sp.peers.length, peerList: sp.peers.map((/** @type {any} */ x) => ({ eid: x.eid, via: x.via, since: x.since })),
      since: link ? link.since : null, ...(why ? { why } : {}),
      door: { listening: sp.door === "listening", refused },
      ...(relayOnly.has(sp.id) ? { relayOnly: relayOnly.get(sp.id) } : {}),
    };
  }

  /** @param {{ ping?: boolean }} [o] */
  async function status(o = {}) {
    const host = hostOf();
    const ping = o.ping !== false;
    const raw = host ? host.status() : [];
    const spaces = await Promise.all(raw.map(async (/** @type {any} */ sp) => {
      const l = joined.get(sp.id) || null;
      const rtt = ping && sp.links[0] && sp.links[0].state === "up" && l ? await within(l.ping(pingMs), pingMs + 200, null) : null;
      return spaceView(sp, typeof rtt === "number" ? rtt : null);
    }));
    let me = null;
    try { me = deps.identity && deps.identity.self ? await within(deps.identity.self(), 1000, null) : null; } catch { me = null; }
    const rs = await within(ctx.call("relay.status", {}), 1500, null);
    const relay = data(rs);
    const relayRtt = relay && relay.connected && deps.relayPing ? await within(deps.relayPing(), pingMs, null) : null;
    const st = deps.storage ? await within(deps.storage.status({ refresh: false }), 1500, null) : null;
    const devices = (st && st.devices) || [];
    const clock = deps.clock ? await within(Promise.resolve().then(() => deps.clock?.()), 1500, null) : null;
    const vpn = deps.otherVpn ? await within(deps.otherVpn(), 1500, false) : false;
    return {
      at: now(),
      identity: me ? { signedIn: me.signedIn !== false, ...(me.name ? { name: me.name } : {}), ...(typeof me.devices === "number" ? { devices: me.devices } : {}) } : { signedIn: null },
      spaces,
      relay: relay ? { enabled: Boolean(relay.enabled), reachable: Boolean(relay.connected), latencyMs: typeof relayRtt === "number" ? relayRtt : null } : { enabled: null, reachable: null, latencyMs: null },
      storage: devices.map((/** @type {any} */ d) => ({ id: d.id, name: d.name, state: d.state, reachable: d.state === "online", ...(d.reason ? { reason: d.reason } : {}),
        ...(d.storage && typeof d.storage.capacity === "number" ? { capacity: d.storage.capacity, used: d.storage.used || 0, free: Math.max(0, d.storage.capacity - (d.storage.used || 0)) } : {}) })),
      clock: { skewMs: clock && typeof clock.skewMs === "number" ? clock.skewMs : null },
      otherVpn: Boolean(vpn),
    };
  }

  /** @param {{ addr?: string, eid?: string }} q */
  async function whois(q) {
    const addr = q && q.addr ? String(q.addr) : "", eid = q && q.eid ? String(q.eid) : "";
    if (!addr && !eid) throw fail("bad_input", "give an address or a device id");
    const host = hostOf();
    const seen = host ? host.whois({ ...(addr ? { addr } : {}), ...(eid ? { eid } : {}) }) : null;
    const id = seen ? seen.eid : eid;
    if (!id) throw fail("not_found", "No connected device has that address.");
    const e = deps.identity && deps.identity.entry ? await Promise.resolve(deps.identity.entry(id)) : null;
    if (!e) throw fail("not_found", "That device is not on the identity list.");
    let identity = e.identity || (e.owner && e.owner.id) || null;
    if (!identity && deps.identity && deps.identity.self) { const me = await within(deps.identity.self(), 1000, null); identity = me && (me.id || me.name) || null; }
    return { eid: id, identity, kind: e.deviceKind || e.kind, ...(e.name ? { name: e.name } : {}), space: seen ? seen.space : null, online: Boolean(seen), via: seen ? seen.via : null };
  }

  /** @param {{ space: string }} i */
  async function join(i) {
    const space = String((i && i.space) || "");
    if (!SPACE.test(space)) throw fail("bad_input", "name a space");
    const host = hostOf();
    if (!host) throw fail("unavailable", "This computer has no network link program yet.");
    if (joined.has(space)) return { joined: true, space: (await status({ ping: false })).spaces.find(s => s.id === space) };
    const known = host.info(space);
    const spec = known ? known.spec : deps.spaces && deps.spaces.spec ? await deps.spaces.spec(space) : null;
    if (!spec) throw fail("not_found", "This computer has no way into that space yet. Pair it first.");
    if (known && known.spec && known.spec.peerPort && host.status().find((/** @type {any} */ s) => s.id === space)?.door === "listening") throw fail("bad_input", "This server hosts that space; it does not join it.");
    const vpn = deps.otherVpn ? await within(deps.otherVpn(), 1500, false) : false;
    if (!known) host.addSpace(spec);
    if (vpn) relayOnly.set(space, "another VPN is running here");
    else await host.start(space);
    const link = host.connect(space, vpn ? { dial: () => Promise.reject(fail("unavailable", "another VPN is running here, so the link goes through the relay")) } : {});
    joined.set(space, link);
    await link.ready(10_000).catch(() => {});
    ctx.events.emit("wink.network-changed", { space, state: link.status().state === "up" ? "joined" : "joining" });
    return { joined: true, space: (await status({ ping: false })).spaces.find(s => s.id === space) };
  }

  /** @param {{ space: string }} i */
  async function leave(i) {
    const space = String((i && i.space) || "");
    if (!SPACE.test(space)) throw fail("bad_input", "name a space");
    const host = hostOf();
    const link = joined.get(space);
    if (!host || !link) throw fail("not_found", "This computer is not joined to that space.");
    link.close();
    joined.delete(space);
    relayOnly.delete(space);
    await host.stop(space);
    ctx.events.emit("wink.network-changed", { space, state: "left" });
    return { left: true, space };
  }

  return { status, whois, join, leave };
}

/** Register the four internal tools on the Wink module's context. @param {any} ctx @param {Parameters<typeof createNetwork>[1]} [deps] */
export function registerNetwork(ctx, deps = {}) {
  const net = createNetwork(ctx, deps);
  ctx.tool("wink.network.status", {
    description: "Internal, for the network module: how the network looks from this machine (signed in, per space the link, direct or relayed, the relay, the server's door, storage, the clock). Read only.",
    input: obj({ ping: { type: "boolean" } }),
    run: (/** @type {any} */ i, /** @type {any} */ meta) => { networkModule(meta, "the network status"); return net.status({ ping: i && i.ping }); },
  });
  ctx.tool("wink.network.whois", {
    description: "Internal, for the network module: who is the connected device at an address or with a device id, from the identity list and the connections this machine admitted.",
    input: obj({ addr: str, eid: str }),
    run: (/** @type {any} */ i, /** @type {any} */ meta) => { networkModule(meta, "who is"); return net.whois(i || {}); },
  });
  ctx.tool("wink.network.join", {
    description: "Internal, for the network module, after the owner's check and presence: bring up this machine's link to a space it has been given a way into.",
    input: obj({ space: str }, ["space"]),
    run: (/** @type {any} */ i, /** @type {any} */ meta) => { networkModule(meta, "joining a space's network"); return net.join(i); },
  });
  ctx.tool("wink.network.leave", {
    description: "Internal, for the network module, after the owner's check and presence: take this machine's link to a space down.",
    input: obj({ space: str }, ["space"]),
    run: (/** @type {any} */ i, /** @type {any} */ meta) => { networkModule(meta, "leaving a space's network"); return net.leave(i); },
  });
  return net;
}
