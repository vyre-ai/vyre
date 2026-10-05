// @ts-check
// server-tools: the paired server, from this computer. `wink.server.home` (which server, its name and address, whether it answers), `wink.server.call` (one tool call on it, over the Wink path),
// `wink.server.health` (the menu bar's line) and the events stream (`wink.server.events`, and /v1/wink/server-events as server-sent events), all over the peer session core/wink/serverlink.js keeps.
// The server answers as this device: its peer door runs the call as the paired device and nothing more. The one tool the server adds is `wink.events.read`, a cursor read of its own event log
// for its owner's devices (the box's /v1/events/stream was HTTP over the tailnet; a Wink peer session carries tool calls only).
import { withinOrThrow } from "../../lib/within.js";
import { isPerson } from "../../lib/caller.js";

const PROBE_MS = 4000, CACHE_MS = 15_000, MAX_WAIT_MS = 25_000, MAX_LIMIT = 500, POLL_MS = 400;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };

/**
 * @param {{ ctx: any, owner: (meta: any, what: string) => void, identity: () => Promise<string>, serverLinks: () => any, homeServerId: () => string | null, devices: any, now?: () => number }} d
 */
export function serverTools(d) {
  const { ctx, owner } = d;
  const now = d.now || Date.now;
  /** @type {Map<string, { at: number, ok: boolean, ms: number | null, why?: string, since: number | null, lastSeen: number | null, address?: string | null }>} */
  const seen = new Map();

  /** The paired server this call names, or the home one: only a server this identity paired. @param {string | undefined} device */
  const serverOf = async device => {
    const sid = device ? String(device) : d.homeServerId();
    if (!sid) return null;
    const row = d.devices.list(await d.identity()).find((/** @type {any} */ x) => x.id === sid && x.kind === "server");
    return row ? { sid, name: String(row.name || "") } : null;
  };
  /** One call on the server, its failures in the words every caller uses: unreachable is `server_unreachable`. @param {string} sid @param {string} tool @param {any} input @param {number} [ms] */
  const callOn = async (sid, tool, input, ms) => {
    try {
      const run = d.serverLinks().sessionFor(sid).call(tool, input);
      return ms ? await withinOrThrow(run, ms, () => err("server_unreachable", "the server did not answer")) : await run;
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (code === "unreachable" || code === "not_found" && /paired server/.test(String(/** @type {any} */ (e).message))) throw err("server_unreachable", String(/** @type {Error} */ (e).message || "the server could not be reached"));
      throw e;
    }
  };
  /** Does the server answer now: a read-only system.info, timed, kept for 15 seconds. @param {string} sid @param {boolean} [fresh] */
  const probe = async (sid, fresh = false) => {
    const had = seen.get(sid);
    if (!fresh && had && now() - had.at < CACHE_MS) return had;
    const t0 = now();
    /** @type {any} */ let r;
    try { await callOn(sid, "system.info", {}, PROBE_MS); r = { at: now(), ok: true, ms: now() - t0, since: had && had.ok ? had.since : now(), lastSeen: now() }; }
    catch (e) { r = { at: now(), ok: false, ms: null, why: String(/** @type {Error} */ (e).message || "no answer").slice(0, 200), since: had && !had.ok ? had.since : now(), lastSeen: had ? had.lastSeen : null }; }
    seen.set(sid, r);
    return r;
  };
  /** The server's address, from its own names.status: its https name, or null when it has none yet (never a guess). @param {string} sid */
  const addressOf = async sid => {
    const had = seen.get(sid);
    if (had && had.address !== undefined && now() - had.at < 5 * CACHE_MS) return had.address;
    let address = null;
    try {
      const s = await callOn(sid, "names.status", {}, PROBE_MS);
      const a = s && typeof s.address === "string" ? s.address : "";
      address = /^https:\/\//.test(a) ? a : s && s.name && s.via === "vyre.run" ? `https://${String(s.name)}.vyre.run` : null;
    } catch { address = null; }
    const cur = seen.get(sid); if (cur) cur.address = address;
    return address;
  };

  // The person's own surfaces only, as link.call was: a module hop made for a model never rides this computer's paired-device identity to the server.
  const person = (/** @type {any} */ meta, /** @type {string} */ what) => {
    owner(meta || {}, what);
    if (!isPerson(meta || {}) || (meta && meta.origin && !isPerson(String(meta.origin)))) throw err("denied", `${what} is the person's own; a model, or a module acting for one, may not`);
  };

  ctx.tool("wink.server.home", {
    effect: "read",
    description: "The server this computer paired with: { linked, reachable, box: { device, name, address }, lastSeen?, via, error? }. `reachable` is whether it answered in the last 15 seconds over the Wink path; `address` is its https name when it has one. { linked: false } when no server is paired.",
    input: obj(),
    run: async (_i, meta = {}) => {
      person(meta, "reading the paired server");
      const s = await serverOf(undefined);
      if (!s) return { linked: false };
      const p = await probe(s.sid);
      const address = p.ok ? await addressOf(s.sid) : (seen.get(s.sid) || {}).address ?? null;
      return { linked: true, reachable: p.ok, box: { device: s.sid, name: s.name || null, address }, lastSeen: p.lastSeen, via: "wink", ...(p.ok ? {} : { error: p.why || "the server did not answer" }) };
    },
  });

  ctx.tool("wink.server.health", {
    effect: "read",
    description: "How this computer reaches its paired server right now, for the menu bar: { state: connected | relayed | offline, path: relay | none, dot: direct | relay | unknown, handshake (ms of the last answer), reach, reachable, latencyMs, since, why? }. Checked at most every 15 seconds.",
    input: obj({ fresh: { type: "boolean" } }),
    run: async (i, meta = {}) => {
      person(meta, "reading the server's health");
      const s = await serverOf(undefined);
      if (!s) return { state: "offline", path: "none", dot: "unknown", handshake: null, reach: "none", reachable: false, why: "this computer is not paired with a server", since: null, latencyMs: null };
      const p = await probe(s.sid, Boolean(i && i.fresh));
      return { state: p.ok ? "relayed" : "offline", path: p.ok ? "relay" : "none", dot: p.ok ? "relay" : "unknown", handshake: p.lastSeen, reach: p.ok ? "relay" : "none", reachable: p.ok, latencyMs: p.ms, since: p.since, ...(p.ok ? {} : { why: p.why || "the server did not answer" }) };
    },
  });

  ctx.tool("wink.server.call", {
    effect: "write",
    description: "Call one tool on the paired server, as this computer's person: { device?, tool, input?, proof? } -> the server tool's own answer (as link.call gave it). `device` defaults to the paired server; `proof` is a presence proof the server asked for, sent in the input. Answers server_unreachable when the server is away. Never for a model or a module acting for one.",
    input: obj({ device: str, tool: str, input: { type: "object" }, proof: { type: "object" } }, ["tool"]),
    run: async (i, meta = {}) => {
      person(meta, "calling the paired server");
      const tool = String(i.tool || "");
      if (!/^[a-z][a-z0-9_.-]{0,80}$/.test(tool)) throw err("bad_input", "name a tool");
      const s = await serverOf(i.device);
      if (!s) throw err("not_found", "this computer has no paired server by that id");
      const input = i.input && typeof i.input === "object" ? i.input : {};
      return callOn(s.sid, tool, i.proof !== undefined ? { ...input, proof: i.proof } : input);
    },
  });

  // The events the server keeps for its owner's devices, after a cursor. Runs on the server (the peer door calls it as the paired device). Long-polls up to 25 seconds.
  ctx.tool("wink.events.read", {
    effect: "read",
    description: "On a server: its event log after a cursor, for its owner's paired devices: { since, type?, limit?, wait_ms? } -> { events, cursor }. `type` or `types` are exact names or a prefix ending in .* (thread.*); several are an OR. Waits up to wait_ms (at most 25000) for the first new event.",
    input: obj({ since: { type: "number" }, type: str, types: { type: "array", items: str }, limit: { type: "number" }, wait_ms: { type: "number" } }),
    run: async (i = {}, meta = {}) => {
      person(meta, "reading the server's events");
      const since = Math.max(0, Number(i.since) || 0), limit = Math.min(MAX_LIMIT, Math.max(1, Number(i.limit) || 200));
      const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(i.wait_ms) || 0));
      // `types` (or `type`): exact names, or a prefix ending in ".*" (thread.*), or "*"; several are an OR. No other pattern.
      const given = [].concat(i.types === undefined ? (i.type === undefined || i.type === "" ? [] : [i.type]) : i.types).map(x => String(x));
      if (given.length > 20 || given.some(t => !/^(\*|[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,79}(\.\*)?)$/.test(t))) throw err("bad_input", "a type is an exact name or a prefix ending in .*");
      const matches = (/** @type {string} */ ty) => !given.length || given.some(t => t === "*" || (t.endsWith(".*") ? ty.startsWith(t.slice(0, -1)) : ty === t));
      const exact = given.length === 1 && !given[0].endsWith("*") ? given[0] : "";
      let scanned = since;
      // one exact type is the log's own filter; anything else reads the log in pages and keeps what matches, and the cursor passes what it read so a quiet pattern is not scanned again
      const read = () => {
        if (exact || !given.length) { const e = ctx.events.since(since, { ...(exact ? { type: exact } : {}), limit }); scanned = e.length ? e[e.length - 1].id : scanned; return e; }
        /** @type {any[]} */ const out = [];
        for (let from = since; out.length < limit;) {
          const page = ctx.events.since(from, { limit: MAX_LIMIT });
          if (!page.length) break;
          for (const e of page) { from = e.id; scanned = e.id; if (matches(e.type)) { out.push(e); if (out.length >= limit) break; } }
          if (page.length < MAX_LIMIT) break;
        }
        return out;
      };
      let events = read();
      for (const t0 = now(); !events.length && now() - t0 < wait; events = read()) await new Promise(r => setTimeout(r, POLL_MS));
      return { events, cursor: !(exact || !given.length) ? Math.max(since, scanned) : events.length ? events[events.length - 1].id : Math.max(since, Number(ctx.events.latestId()) || 0) };
    },
  });

  ctx.tool("wink.server.events", {
    effect: "read",
    description: "The paired server's events after a cursor, over the Wink path: { since?, type?, limit?, wait_ms? } -> { events, cursor }. Call again with the cursor to follow; /v1/wink/server-events does that as a stream.",
    input: obj({ since: { type: "number" }, type: str, types: { type: "array", items: str }, limit: { type: "number" }, wait_ms: { type: "number" } }),
    run: async (i = {}, meta = {}) => {
      person(meta, "reading the paired server's events");
      const s = await serverOf(undefined);
      if (!s) throw err("not_found", "this computer has no paired server");
      return callOn(s.sid, "wink.events.read", { since: i.since, type: i.type, ...(i.types ? { types: i.types } : {}), limit: i.limit, wait_ms: Math.min(MAX_WAIT_MS, Number(i.wait_ms) || 0) });
    },
  });

  /** @type {Set<() => void>} */ const streams = new Set();
  // The same events as server-sent events, for a surface that followed /v1/link/events: `link.down` and `link.up` when the server goes away and comes back, ids are the server's cursor.
  ctx.route("server-events", (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ { caller, url }) => {
    try { person({ caller }, "following the paired server"); } catch { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: "denied", message: "the paired server's events are the person's own" } })); }
    const types = url.searchParams.getAll("type").filter(Boolean);
    let since = Number(req.headers["last-event-id"] || url.searchParams.get("since") || 0) || 0;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    let closed = false, down = false, failures = 0;
    /** @type {any} */ let timer = null;
    const end = () => { if (closed) return; closed = true; clearTimeout(timer); streams.delete(end); res.end(); };
    streams.add(end); req.on("close", end);
    (async () => {
      while (!closed) {
        try {
          const s = await serverOf(undefined);
          if (!s) throw err("server_unreachable", "this computer is not paired with a server");
          const r = await callOn(s.sid, "wink.events.read", { since, ...(types.length ? { types } : {}), limit: 200, wait_ms: 20_000 });
          if (down) { down = false; res.write(`event: link.up\ndata: {}\n\n`); }
          failures = 0;
          for (const e of r.events || []) { since = Number(e.id); res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e, source: "box" })}\n\n`); }
          if (!(r.events || []).length) res.write(": beat\n\n");
        } catch (e) {
          if (closed) return;
          if (!down) { down = true; res.write(`event: link.down\ndata: ${JSON.stringify({ error: String(/** @type {Error} */ (e).message || "the server is not reachable") })}\n\n`); }
          failures++;
          await new Promise(r => { timer = setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(failures, 5))); });
        }
      }
    })();
  }, { readOnly: true });

  return { stop() { for (const e of [...streams]) e(); } };
}
