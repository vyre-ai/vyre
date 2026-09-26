// @ts-check
// mac — the Mac's half of the link: pairing with the box, calling its tools, and following its
// events.
//
// The Mac keeps working when the box is away (floor rule 9). Every call to the box fails fast
// with `box_unreachable` once the box is known to be down, and is retried with a growing pause,
// so a module that asked for box results gets the Mac's own instead of a hang.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connector, identifyBox, tailnetPeers, certNames } from "./transport.js";

const MAX_BACKOFF = 30_000;

/**
 * @param {any} ctx the module's context
 * @param {{ verify?: (ip: string) => Promise<any>, insecure?: boolean, heartbeat?: number, pollMs?: number,
 *   hostname?: string, timeout?: number, ttl?: number }} seam test seams; production passes nothing
 */
export function macSide(ctx, seam = {}) {
  const file = path.join(ctx.paths.root, "link.json");
  const verify = seam.verify || identifyBox;
  /** @type {{ box: { address: string, stableId: string, node?: string, name?: string|null }, key: string, peer: string, pairedAt: number, revoked?: boolean } | null} */
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const save = v => {
    saved = v;
    if (!v) { fs.rmSync(file, { force: true }); return; }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const connect = (address, pin) => connector({ address, verify, pinned: () => pin, insecure: Boolean(seam.insecure), ...(seam.ttl !== undefined ? { ttl: seam.ttl } : {}) });
  let conn = saved ? connect(saved.box.address, saved.box.stableId) : null;

  const state = { reachable: false, lastSeen: /** @type {number|null} */ (null), error: /** @type {string|null} */ (null), failures: 0, nextTry: 0, announced: /** @type {boolean|null} */ (null) };
  /** @type {{ id: string, secret: string, code: string, expires: number, address: string, stableId: string, node?: string, timer?: any } | null} */
  let pairing = null;
  let stopped = false;

  // A call in flight when vyred stops must not write to the closed store.
  const emit = (type, payload) => { if (!stopped) ctx.events.emit(type, payload); };
  const up = () => {
    state.failures = 0; state.nextTry = 0; state.lastSeen = Date.now(); state.reachable = true; state.error = null;
    if (state.announced !== true) { state.announced = true; emit("link.connected", { box: saved && saved.box.address }); }
  };
  const down = why => {
    state.failures++; state.reachable = false; state.error = why;
    state.nextTry = Date.now() + Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(state.failures - 1, 5));
    if (state.announced !== false) { state.announced = false; emit("link.lost", { box: saved && saved.box.address, error: why }); }
  };

  /** One tool call on the box. Never throws: { data } or { error }, as registry.call does. */
  async function boxCall(tool, input, c = conn) {
    if (!c) return { error: { code: "no_link", message: "this Mac is not paired with a box (vyre link pair <address>)" } };
    try {
      const r = await c.json("POST", "/v1/tools/" + encodeURIComponent(tool), input, { timeout: seam.timeout || 10_000 });
      if (c === conn) up();
      if (r.status === 403 && r.body && r.body.error && r.body.error.code === "not_owner") return { error: { code: "not_owner", message: "the box does not recognise this device as its owner" } };
      return r.body;
    } catch (e) {
      const err = /** @type {any} */ (e);
      const why = err.code === "not_box" ? err.message : `the box is not reachable (${err.code || err.message})`;
      if (c === conn) down(why);
      return { error: { code: err.code === "not_box" ? "not_box" : "box_unreachable", message: why } };
    }
  }

  /** A box tool for a module or a surface on the Mac. Fails fast while the box is known to be away. */
  async function remote(tool, input = {}) {
    if (!saved || !conn) return { error: { code: "no_link", message: "this Mac is not paired with a box (vyre link pair <address>)" } };
    if (saved.revoked) return { error: { code: "unpaired", message: "the box no longer knows this Mac; pair again" } };
    // The link's own tools on the box are for the link, not for other modules to drive.
    if (String(tool).startsWith("link.")) return { error: { code: "denied", message: "link tools on the box are not callable through the link" } };
    if (!state.reachable && Date.now() < state.nextTry) return { error: { code: "box_unreachable", message: state.error || "the box is not reachable" } };
    return boxCall(tool, input);
  }

  async function hello() {
    if (!saved || saved.revoked) return;
    const r = await boxCall("link.hello", { key: saved.key });
    if (r.data && r.data.paired === false) { save({ ...saved, revoked: true }); state.error = "the box no longer knows this Mac; pair again"; }
    else if (r.data && r.data.box && r.data.box.name !== saved.box.name) save({ ...saved, box: { ...saved.box, name: r.data.box.name } });
  }
  const beat = setInterval(() => { if (!stopped) hello(); }, seam.heartbeat || 30_000);
  beat.unref();
  if (saved) setImmediate(() => { if (!stopped) hello(); });

  function poll() {
    const p = pairing;
    if (!p || stopped) return;
    if (Date.now() > p.expires) { pairing = null; state.error = "the pairing code expired; start again"; return; }
    boxCall("link.pair.poll", { id: p.id, secret: p.secret }, connect(p.address, p.stableId)).then(r => {
      if (pairing !== p || stopped) return;
      const s = r.data && r.data.state;
      if (s === "approved") {
        pairing = null;
        save({ box: { address: p.address, stableId: p.stableId, node: p.node, name: r.data.box && r.data.box.name }, key: r.data.key, peer: r.data.peer, pairedAt: Date.now() });
        conn = connect(p.address, p.stableId);
        state.announced = null;
        emit("link.paired", { box: p.address, peer: r.data.peer });
        hello();
      } else if (s === "denied" || s === "expired" || s === "gone") {
        pairing = null; state.error = `pairing ${s === "gone" ? "was cancelled" : s}; start again`;
      } else p.timer = setTimeout(poll, seam.pollMs || 2000);
    });
  }

  ctx.tool("link.pair", {
    description: "Pair this Mac with your box. Shows a code to approve on the box: `vyre link approve <code>` there, or in the Deck.",
    input: { type: "object", properties: { box: { type: "string" } }, required: ["box"] },
    callers: ["cli", "local", "capsule"],
    run: async ({ box }) => {
      let address = String(box).trim();
      if (!/^[a-z]+:\/\//i.test(address)) address = "https://" + address;
      if (pairing && pairing.timer) clearTimeout(pairing.timer);
      pairing = null;
      // The first connection is unpinned: it is how the box's node is learned. Everything after is
      // pinned to it, and the owner approving on that very box is what makes the pin trustworthy.
      const first = connect(address, null);
      let r;
      try { r = await first.json("POST", "/v1/tools/link.pair.request", { name: seam.hostname || os.hostname() }, { timeout: seam.timeout || 10_000 }); }
      catch (e) { throw new Error(/** @type {any} */ (e).code === "not_box" ? /** @type {Error} */ (e).message : `could not reach the box at ${address}: ${/** @type {Error} */ (e).message}`); }
      if (r.body.error) throw new Error(r.body.error.code === "not_owner" ? "the box does not serve this device: sign in to Tailscale as the box's owner" : r.body.error.message);
      const d = r.body.data;
      pairing = { id: d.id, secret: d.secret, code: d.code, expires: d.expires, address: first.address, stableId: r.who.stableId, node: r.who.node };
      pairing.timer = setTimeout(poll, seam.pollMs || 2000);
      state.error = null;
      return { id: d.id, code: d.code, expires: d.expires };
    },
  });

  ctx.tool("link.find", {
    description: "Look for your box on your tailnet: online peers that answer as a Vyre box. For `vyre up` to offer pairing.",
    input: { type: "object", properties: {} },
    callers: ["cli", "local", "capsule"],
    run: async () => {
      const peers = await (seam.peers || tailnetPeers)();
      const names = seam.certNames || certNames;
      const found = await Promise.all(peers.map(async p => {
        // The box answers at the name on its certificate; the node is pinned to the peer's own ID.
        for (const name of [...new Set([...(await names(p.ip, p.dns)), p.dns].filter(Boolean))]) {
          const address = seam.addressOf ? seam.addressOf(name) : `https://${name}`;
          try {
            const c = connect(address, p.stableId);
            const r = await c.json("GET", "/v1/health", undefined, { timeout: 3000 });
            if (r.body && r.body.data && r.body.data.role === "box") return { address: c.address, node: p.dns || p.host, version: r.body.data.version || null };
          } catch {}
        }
        return null;
      }));
      return { boxes: found.filter(Boolean), paired: saved ? saved.box.address : null };
    },
  });

  ctx.tool("link.status", {
    description: "Whether this Mac is paired with a box, and whether the box is reachable right now.",
    input: { type: "object", properties: {} },
    run: async () => ({
      role: "local", linked: Boolean(saved && !saved.revoked),
      box: saved ? { address: saved.box.address, name: saved.box.name || null, node: saved.box.node || null } : null,
      reachable: state.reachable, lastSeen: state.lastSeen,
      pending: pairing ? { id: pairing.id, code: pairing.code, expires: pairing.expires } : null,
      ...(state.error ? { error: state.error } : {}),
    }),
  });

  ctx.tool("link.unpair", {
    description: "Forget the box on this Mac, and tell the box to forget this Mac when it can be reached.",
    input: { type: "object", properties: {} },
    callers: ["cli", "local", "capsule"],
    run: async () => {
      if (!saved) return { unpaired: false };
      const told = saved.revoked ? { data: true } : await boxCall("link.unpair", { key: saved.key });
      const was = saved.box.address;
      save(null); conn = null; state.reachable = false; state.announced = null;
      ctx.events.emit("link.unpaired", { box: was });
      return { unpaired: true, boxForgot: !told.error };
    },
  });

  ctx.tool("link.call", {
    description: "Call a tool on your box from this Mac (threads, agents, files). Answers box_unreachable when the box is away.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] },
    run: async ({ tool, input }) => {
      const r = await remote(tool, input || {});
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    },
  });

  ctx.tool("link.remote", {
    description: "ctx.remote's carrier: a box tool for a module on this Mac.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] },
    internal: true,
    run: async ({ tool, input }) => ({ result: await remote(tool, input || {}) }),
  });

  /** @type {Set<() => void>} */
  const streams = new Set();
  ctx.route("events", (req, res, { url }) => {
    const type = url.searchParams.get("type") || "*";
    let since = String(req.headers["last-event-id"] || url.searchParams.get("since") || "latest");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    let closed = false, upstream = null, wait = null, saidDown = false, failures = 0;
    const end = () => { if (closed) return; closed = true; clearTimeout(wait); if (upstream) upstream.destroy(); streams.delete(end); res.end(); };
    streams.add(end);
    req.on("close", end);
    const lost = why => {
      upstream = null;
      if (closed) return;
      if (!saidDown) { saidDown = true; res.write(`event: link.down\ndata: ${JSON.stringify({ error: why })}\n\n`); }
      failures++;
      wait = setTimeout(follow, Math.min(15_000, 500 * 2 ** Math.min(failures, 5)));
    };
    const follow = () => {
      if (closed) return;
      if (!saved || !conn || saved.revoked) return lost("this Mac is not paired with a box");
      let buf = "", over = false;
      const fail = why => { if (!over) { over = true; lost(why); } };
      conn.open("GET", `/v1/events/stream?type=${encodeURIComponent(type)}&since=${encodeURIComponent(since)}`, { timeout: 60_000,
        headers: { accept: "text/event-stream" }, onResponse: up => {
          if (up.statusCode !== 200) { up.resume(); return fail(`the box answered ${up.statusCode}`); }
          if (saidDown) res.write(`event: link.up\ndata: {}\n\n`);
          saidDown = false; failures = 0;
          up.setEncoding("utf8");
          up.on("data", chunk => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const data = block.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
              if (!data) { res.write(": beat\n\n"); continue; }
              let e;
              try { e = JSON.parse(data); } catch { continue; }
              e.source = "box";
              since = String(e.id);
              res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            }
          });
          up.on("end", () => fail("the box closed the stream"));
          up.on("error", () => fail("the stream from the box broke"));
        } }).then(({ req: r }) => { upstream = r; }, e => fail(`the box is not reachable (${e.code || e.message})`));
    };
    follow();
  });

  return {
    async stop() {
      stopped = true; clearInterval(beat);
      if (pairing && pairing.timer) clearTimeout(pairing.timer);
      for (const end of streams) end();
    },
  };
}
