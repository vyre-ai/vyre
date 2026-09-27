// @ts-check
// mac — the Mac's half of the link: pairing with the box, calling its tools, and following its
// events.
//
// The Mac keeps working when the box is away (floor rule 9). Every call to the box fails fast
// with `box_unreachable` once the box is known to be down, and is retried with a growing pause,
// so a module that asked for box results gets the Mac's own instead of a hang.
//
// The box reads this Mac the other way round, without a port open here: while paired, the Mac
// holds one request to the box's link.serve open, runs the question it gets (only the read tools
// in allow.js), answers with link.reply and asks again. When the box is away the loop stops, and
// the next call that reaches the box (the minute's heartbeat, at the latest) starts it again.
//
// The one write (allow.js WRITE, threads.send) runs only when the box says it is the person's,
// as the caller "link:box", and the Mac then follows that thread's events and sends them to the
// box with link.events, batched, until the answer is finished (see follow below).
//
// The other write, threads.answer, runs only with an assertion signed by the box's key, which this
// Mac pinned when it paired (or once, over the pinned channel, when it paired before answers
// crossed). assert.js checks it. While paired, the Mac also forwards every ask it raises and its end
// (allow.js ASKS), so the person sees the Mac's asks on the box and can answer them there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connector, identifyBox, tailnetPeers, certNames } from "./transport.js";
import { createHealth, unknown } from "./health.js";
import { realBoxAllowed } from "../config/dialogs.js";
import { ALLOW, WRITE, FOLLOWED, ASKS } from "./allow.js";
import { checkAnswer, Nonces } from "./assert.js";
import { gatedAsk } from "../modules/federate.js";

const MAX_BACKOFF = 30_000;
/** How long the box holds link.serve open (box.js); the Mac waits this plus a margin. */
const HOLD = 60_000;
/** A thread the box sent to is followed at most this long after the last send. */
const FOLLOW = 30 * 60_000;
/** Followed events go to the box at most this often, while they flow. */
const FLUSH = 250;
/** At most this many events in one link.events call. */
const BATCH = 500;

/**
 * @param {any} ctx the module's context
 * @param {{ verify?: (ip: string) => Promise<any>, insecure?: boolean, heartbeat?: number, pollMs?: number,
 *   hostname?: string, timeout?: number, ttl?: number, hold?: number, health?: { check: (which: any) => Promise<any> } }} seam test seams; production passes nothing
 */
export function macSide(ctx, seam = {}) {
  const file = path.join(ctx.paths.root, "link.json");
  const verify = seam.verify || identifyBox;
  /** @type {{ box: { address: string, stableId: string, node?: string, name?: string|null, assertKey?: string }, key: string, peer: string, pairedAt: number, self?: string, revoked?: boolean } | null} */
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
  const health = seam.health || createHealth();

  // A temp home (a dev world, a demo, a stress run) never looks for or pairs with a real box: one
  // found the user's live box and sent it a pairing request. Test seams, a fake tailscale
  // (VYRE_TAILSCALE_BIN) and a box on this machine's loopback are not real boxes.
  const seamed = Object.keys(seam).length > 0;
  const REFUSED = `this home (${ctx.paths.root}) is not ~/.vyre, so it does not look for or pair with a real box. VYRE_ALLOW_REAL_BOX=1 allows it`;
  const refuse = () => Object.assign(new Error(REFUSED), { code: "not_real_home" });
  const loopback = a => { try { return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(a).hostname); } catch { return false; } };
  const mayFind = () => seamed || Boolean(process.env.VYRE_TAILSCALE_BIN) || realBoxAllowed(ctx.paths.root);
  const mayPair = address => seamed || loopback(address) || realBoxAllowed(ctx.paths.root);

  const state = { reachable: false, lastSeen: /** @type {number|null} */ (null), error: /** @type {string|null} */ (null), failures: 0, nextTry: 0, announced: /** @type {boolean|null} */ (null) };
  /** @type {{ id: string, secret: string, code: string, expires: number, address: string, stableId: string, node?: string, timer?: any } | null} */
  let pairing = null;
  let stopped = false;

  // A call in flight when vyred stops must not write to the closed store.
  const emit = (type, payload) => { if (!stopped) ctx.events.emit(type, payload); };
  const up = () => {
    state.failures = 0; state.nextTry = 0; state.lastSeen = Date.now(); state.reachable = true; state.error = null;
    if (state.announced !== true) { state.announced = true; emit("link.connected", { box: saved && saved.box.address }); }
    // The box answered, so the serve loop can run, if it is not already. On the next turn, so a
    // heartbeat that just learned the box forgot this Mac marks it revoked first.
    setImmediate(serveLoop);
  };
  const down = why => {
    state.failures++; state.reachable = false; state.error = why;
    state.nextTry = Date.now() + Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(state.failures - 1, 5));
    if (state.announced !== false) { state.announced = false; emit("link.lost", { box: saved && saved.box.address, error: why }); }
  };

  /**
   * One tool call on the box. Never throws: { data } or { error }, as registry.call does.
   * @param {string} tool @param {any} input @param {any} [c] the connection, the paired box's by default
   * @param {{ timeout?: number, signal?: AbortSignal }} [opts] a longer timeout for link.serve, and a way to cancel it
   */
  async function boxCall(tool, input, c = conn, { timeout, signal } = {}) {
    if (!c) return { error: { code: "no_link", message: "this Mac is not paired with a box (vyre link pair <address>)" } };
    try {
      const r = await c.json("POST", "/v1/tools/" + encodeURIComponent(tool), input, { timeout: timeout || seam.timeout || 10_000, signal });
      if (c === conn) up();
      if (r.status === 403 && r.body && r.body.error && r.body.error.code === "not_owner") return { error: { code: "not_owner", message: "the box does not recognise this device as its owner" } };
      return r.body;
    } catch (e) {
      const err = /** @type {any} */ (e);
      // Cancelled here, not lost there: the box's state is not known from this.
      if (signal && signal.aborted) return { error: { code: "cancelled", message: "the call was cancelled" } };
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
    const asked = saved;
    const r = await boxCall("link.hello", { key: saved.key });
    // An unpair or a new pairing while this was out wins: its answer is about a pairing that is gone.
    if (saved !== asked) return;
    if (r.data && r.data.paired === false) { save({ ...saved, revoked: true }); beating(false); unfollowAll(); askListen(false); state.error = "the box no longer knows this Mac; pair again"; }
    else if (r.data && r.data.box) {
      const b = r.data.box, you = r.data.you && typeof r.data.you.stableId === "string" ? r.data.you.stableId : null;
      // A Mac paired before answers crossed pins the box's key once, from this channel (already
      // pinned to the box's node). A pinned key is never replaced: a new one means pairing again.
      const pin = !saved.box.assertKey && typeof b.assertKey === "string" && b.assertKey ? { assertKey: b.assertKey } : {};
      const self = !saved.self && you ? { self: you } : {};
      if (b.name !== saved.box.name || pin.assertKey || self.self) save({ ...saved, ...self, box: { ...saved.box, name: b.name, ...pin } });
    }
  }
  // The heartbeat runs only while paired, once a minute (the 60-second floor for recurring timers).
  // A Mac that never paired keeps no timer at all. Between beats, a call to the box finds out on
  // its own when the box comes back, since a failed call only pauses retries, never stops them.
  let beat = null;
  const beating = on => {
    if (on && !beat && !stopped) { beat = setInterval(() => { if (!stopped) hello(); }, seam.heartbeat || 60_000); beat.unref(); }
    if (!on && beat) { clearInterval(beat); beat = null; }
  };
  if (saved && !saved.revoked) { beating(true); setImmediate(() => { if (!stopped) { hello(); askListen(true); } }); }

  // Following a thread the box sent to. Its events on this Mac (FOLLOWED) go to the box in
  // batches (link.events), at most every FLUSH ms while they flow; nothing is sent when idle, and
  // no listener or timer exists while nothing is followed. A follow starts (or is extended) with
  // each send, and ends at the thread's thread.finished or thread.stopped, 30 minutes after the
  // last send, on unpair, on revoke, and when vyred stops. The rule for queued words: a
  // thread.queued adds its id to the follow's `waiting`, and the thread.sent {queued} that hands
  // it over removes it; a thread.finished while any is still waiting is some other turn ending,
  // not the answer, so the follow goes on. Events that arrive while the send itself runs are held,
  // and sent only if the send succeeds. A batch the box does not take is dropped, never retried:
  // the Deck can read the thread again with recall.thread.
  /** @type {Map<string, { until: number, held: any[] | null, waiting: Set<number>, ended: boolean, sends: number }>} */
  const follows = new Map();
  /** @type {any[]} */
  let outbox = [];
  /** @type {any} */
  let flushTimer = null;
  let lastFlush = 0;
  /** @type {null | (() => void)} */
  let listening = null;

  const listen = () => {
    if (listening || stopped) return;
    const offs = ["thread.*"].map(p => ctx.events.on(p, heard));
    listening = () => { for (const off of offs) off(); };
  };
  const quiet = () => { if (!follows.size && listening) { listening(); listening = null; } };
  const end = thread => { follows.delete(thread); quiet(); };
  function unfollowAll() {
    follows.clear(); outbox = [];
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    quiet();
  }
  const expire = () => { const t = Date.now(); for (const [thread, f] of follows) if (f.until < t && f.held === null) follows.delete(thread); };

  /** An event on this Mac: pass it on if it is a followed thread's. */
  function heard(e) {
    if (!FOLLOWED.includes(e.type) || !e.thread) return;
    expire();
    const f = follows.get(e.thread);
    if (!f) { quiet(); return; }
    const p = e.payload || {};
    if (e.type === "thread.queued" && Number.isFinite(Number(p.queued))) f.waiting.add(Number(p.queued));
    if (e.type === "thread.sent" && p.queued !== undefined) f.waiting.delete(Number(p.queued));
    const out = { type: e.type, thread: e.thread, project: e.project || null, at: e.at, payload: p };
    if (f.held) f.held.push(out); else queueOut(out);
    if (e.type === "thread.stopped" || (e.type === "thread.finished" && !f.waiting.size)) {
      if (f.held) f.ended = true; else end(e.thread);
    }
  }
  function queueOut(ev) {
    outbox.push(ev);
    if (!flushTimer && !stopped) {
      flushTimer = setTimeout(flush, Math.max(0, lastFlush + FLUSH - Date.now()));
      flushTimer.unref?.();
    }
  }
  function flush() {
    flushTimer = null;
    lastFlush = Date.now();
    const batch = outbox.splice(0, BATCH);
    if (outbox.length) { flushTimer = setTimeout(flush, FLUSH); flushTimer.unref?.(); }
    if (!batch.length || stopped || !saved || saved.revoked || !conn) return;
    boxCall("link.events", { key: saved.key, events: batch }).catch(() => {});
  }

  // Every ask on this Mac goes to the box while paired: a listener only, no timer, and nothing sent
  // while no ask is raised or ends. Batched with the followed events.
  /** @type {null | (() => void)} */
  let askOff = null;
  function askListen(on) {
    if (on && !askOff && !stopped && saved && !saved.revoked) {
      const offs = ASKS.map(type => ctx.events.on(type, e => {
        if (!e.thread || !saved || saved.revoked) return;
        queueOut({ type: e.type, thread: e.thread, project: e.project || null, at: e.at, payload: e.payload || {} });
      }));
      askOff = () => { for (const off of offs) off(); };
    }
    if (!on && askOff) { askOff(); askOff = null; }
  }

  // Nonces of the box's answers seen here, each until its assertion expires (memory only).
  const nonces = new Nonces();
  /**
   * The box's answer to one of this Mac's asks: runs only when its assertion checks out.
   * @param {any} q the box's request
   */
  async function answer(q) {
    const input = q.input && typeof q.input === "object" ? q.input : {};
    // The Mac's own record of the ask says whether it is gated, not the box: an ask that approves
    // a floor tool needs a fresh proof of presence on the box (federate.js gatedAsk).
    const open = await ctx.call("threads.asks", {});
    const mine = !open.error && Array.isArray(open.data) ? open.data.find(a => a && a.id === input.ask) : null;
    const c = checkAnswer({ assertion: q.assertion, tool: q.tool, input, pinned: saved && saved.box.assertKey, self: saved && saved.self, nonces,
      now: seam.now ? seam.now() : Date.now(), gated: gatedAsk(mine) });
    if (!c.ok) return { error: { code: "denied", message: `the box's answer was refused: ${c.reason}` } };
    // write() follows input.thread, and an answer names none: nothing is followed for it.
    return write("threads.answer", input);
  }

  /**
   * threads.send for the person at the box: as "link:box", its surface marked as the box's, with
   * the thread followed while it runs and after, if it succeeded.
   * @param {string} tool @param {any} input
   */
  async function write(tool, input) {
    const thread = typeof input.thread === "string" ? input.thread : "";
    const { machine: _m, machines: _ms, ...rest } = input;
    const i = { ...rest, surface: "box:" + String(input.surface || "deck") };
    const had = follows.get(thread);
    const f = had || { until: 0, held: /** @type {any[] | null} */ ([]), waiting: new Set(), ended: false, sends: 0 };
    f.sends++;
    if (thread && !had) { follows.set(thread, f); listen(); }
    let r;
    try { r = await ctx.call(tool, i, { as: "link:box" }); }
    catch (e) { r = { error: { code: "failed", message: /** @type {Error} */ (e).message } }; }
    f.sends--;
    if (!thread || follows.get(thread) !== f) return r;
    // Refused, or not sent and not queued (another surface holds the keyboard): nothing will follow.
    if (!had && (r.error || (r.data && r.data.sent === false && !r.data.queued))) { end(thread); return r; }
    f.until = Date.now() + FOLLOW;
    if (f.held && f.sends === 0) {
      const held = f.held;
      f.held = null;
      for (const ev of held) queueOut(ev);
      if (f.ended) end(thread);
    }
    return r;
  }

  // The serve loop: the box's questions for this Mac. Request-driven, never on a timer: each turn
  // waits on the box (up to its hold), and a failure ends the loop until up() starts it again.
  let serving = false;
  /** @type {AbortController | null} */
  let serveStop = null;
  async function serveLoop() {
    if (serving || stopped || !saved || saved.revoked || !conn) return;
    serving = true;
    const c = conn, key = saved.key, ac = new AbortController();
    serveStop = ac;
    const live = () => !stopped && !ac.signal.aborted && c === conn && Boolean(saved) && !(/** @type {any} */ (saved).revoked);
    try {
      while (live()) {
        const r = await boxCall("link.serve", { key }, c, { timeout: (seam.hold || HOLD) + 15_000, signal: ac.signal });
        if (!live() || r.error) return;
        const q = r.data;
        if (q === null) continue;
        // { paired: false } or anything else unexpected: stop; the heartbeat finds out why.
        if (!q || typeof q.id !== "string" || typeof q.tool !== "string") return;
        const input = q.input && typeof q.input === "object" ? q.input : {};
        const result = WRITE.includes(q.tool)
          ? (q.as !== "person" ? { error: { code: "denied", message: `${q.tool} is answered through the link only for the person` } }
            : q.tool === "threads.answer" ? await answer(q) : await write(q.tool, input))
          : ALLOW.includes(q.tool) ? await ctx.call(q.tool, input)
          : { error: { code: "denied", message: `${q.tool} is not answered through the link` } };
        if (!live()) return;
        const sent = await boxCall("link.reply", { key, id: q.id, result: result.error ? { error: result.error } : { data: result.data } }, c, { signal: ac.signal });
        if (sent.error || (sent.data && sent.data.paired === false)) return;
      }
    } finally {
      serving = false;
      if (serveStop === ac) serveStop = null;
    }
  }
  const stopServing = () => { if (serveStop) serveStop.abort(); };

  function poll() {
    const p = pairing;
    if (!p || stopped) return;
    if (Date.now() > p.expires) { pairing = null; state.error = "the pairing code expired; start again"; return; }
    boxCall("link.pair.poll", { id: p.id, secret: p.secret }, connect(p.address, p.stableId)).then(r => {
      if (pairing !== p || stopped) return;
      const s = r.data && r.data.state;
      if (s === "approved") {
        pairing = null;
        const b = r.data.box || {}, you = r.data.you && typeof r.data.you.stableId === "string" ? r.data.you.stableId : null;
        save({ box: { address: p.address, stableId: p.stableId, node: p.node, name: b.name, ...(typeof b.assertKey === "string" && b.assertKey ? { assertKey: b.assertKey } : {}) },
          key: r.data.key, peer: r.data.peer, pairedAt: Date.now(), ...(you ? { self: you } : {}) });
        conn = connect(p.address, p.stableId);
        state.announced = null;
        emit("link.paired", { box: p.address, peer: r.data.peer });
        beating(true);
        hello();
        askListen(true);
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
      if (!mayPair(address)) throw refuse();
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
      if (!mayFind()) throw refuse();
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
      box: saved ? { address: saved.box.address, name: saved.box.name || null, node: saved.box.node || null, stableId: saved.box.stableId || null } : null,
      reachable: state.reachable, lastSeen: state.lastSeen, serving, following: follows.size,
      pending: pairing ? { id: pairing.id, code: pairing.code, expires: pairing.expires } : null,
      ...(state.error ? { error: state.error } : {}),
    }),
  });

  ctx.tool("link.health", {
    description: "How this Mac reaches its box right now: direct or relayed, latency, last handshake. Checked at most once a minute.",
    input: { type: "object", properties: {} },
    run: async () => {
      if (!saved || saved.revoked) return unknown(saved ? "the box no longer knows this Mac; pair again" : "this Mac is not paired with a box", Date.now());
      if (!saved.box.stableId) return unknown("the box's node is not known; pair again", Date.now());
      return health.check({ stableId: saved.box.stableId });
    },
  });

  ctx.tool("link.unpair", {
    description: "Forget the box on this Mac, and tell the box to forget this Mac when it can be reached.",
    input: { type: "object", properties: {} },
    callers: ["cli", "local", "capsule"],
    run: async () => {
      if (!saved) return { unpaired: false };
      const told = saved.revoked ? { data: true } : await boxCall("link.unpair", { key: saved.key });
      const was = saved.box.address;
      save(null); beating(false); stopServing(); unfollowAll(); askListen(false); conn = null; state.reachable = false; state.announced = null;
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
      stopped = true; beating(false); stopServing(); unfollowAll(); askListen(false);
      if (pairing && pairing.timer) clearTimeout(pairing.timer);
      for (const end of streams) end();
    },
  };
}
