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

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { connector, identifyBox, tailnetPeers, certNames } from "./transport.js";
import { createHealth, unknown, shaped, sinceTracker } from "./health.js";
import { realBoxAllowed } from "../config/dialogs.js";
import { ALLOW, WRITE, FOLLOWED, ASKS } from "./allow.js";
import { checkAnswer, Nonces, NONCES_FILE } from "./assert.js";
import { gatedAsk } from "../modules/federate.js";
import { HUMAN_ONLY, PERSON_ONLY, inputHash } from "../presence/index.js";
import * as enclave from "./se/index.js";
import { signed } from "../presence/person.js";
import { agentClaim, callerKind } from "../modules/index.js";

/** The callers that are the person on this Mac: its terminal, the Capsule, its own screens. */
const PEOPLE = new Set(["cli", "local", "capsule", "deck"]);
/** The person's own surfaces and the owner's devices (what link.status, which shows the pairing code, and link.call, which drives the box as this Mac, answer to). A model session is not one. */
const PERSON_SURFACES = Object.freeze(["cli", "local", "deck", "capsule", "mobile", "tailnet", "device"]);

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
  const reachSince = sinceTracker();
  /** The Secure Enclave (se/): a test passes a software stand-in, which asks nobody. */
  const se = seam.secureEnclave || enclave;
  /** Only on a Mac, or with a stand-in: elsewhere there is no enclave to ask. */
  const hasEnclave = () => Boolean(seam.secureEnclave) || process.platform === "darwin";

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
  async function boxCall(tool, input, c = conn, { timeout, signal, headers } = {}) {
    if (!c) return { error: { code: "no_link", message: "this Mac is not paired with a box (vyre link pair <address>)" } };
    try {
      const r = await c.json("POST", "/v1/tools/" + encodeURIComponent(tool), input, { timeout: timeout || seam.timeout || 10_000, signal, ...(headers ? { headers } : {}) });
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
  /**
   * Whether a caller is the person on this Mac: one of PEOPLE, and no agent or thread riding it.
   * The first word alone is not enough: "cli:agent:kit" is an agent inside the person's CLI, not
   * the person (lib/caller.js isPerson's rule: the agent claim is checked first). A thread label
   * is a model's session (ADR 0030), refused the same way.
   */
  const isPerson = caller => {
    const c = String(caller || "");
    if (agentClaim(c) !== null || /(?:^|[\s:])thread:/.test(c)) return false;
    return PEOPLE.has(callerKind(c));
  };

  /** A person session's headers for one request: the token and a fresh signature over it. */
  function personHeaders(person, pathname, body) {
    const t = Date.now(), n = crypto.randomBytes(12).toString("base64url");
    const key = crypto.createPrivateKey({ key: person.key, format: "jwk" });
    const sig = crypto.sign("sha256", Buffer.from(signed({ method: "POST", path: pathname, raw: JSON.stringify(body), t, n })), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { authorization: `Vyre ${person.token}`, "x-vyre-proof": `t=${t} n=${n} sig=${sig}` };
  }

  async function remote(tool, input = {}, caller = "module:link") {
    if (!saved || !conn) return { error: { code: "no_link", message: "this Mac is not paired with a box (vyre link pair <address>)" } };
    if (saved.revoked) return { error: { code: "unpaired", message: "the box no longer knows this Mac; pair again" } };
    // The link's own tools on the box are for the link, not for other modules to drive.
    if (String(tool).startsWith("link.")) return { error: { code: "denied", message: "link tools on the box are not callable through the link" } };
    // The box takes this Mac's calls as its owner's device, not as the person: a person's own
    // action (answering an ask, approving, a terminal) rides only with this Mac's person session
    // (`vyre link signin`), and only for the person's own callers here, whose process vyred's
    // socket has already traced. A module or a model never carries it. A human-only tool also
    // needs a proof the box can check, which this Mac cannot give: those are the Deck's.
    let extra = {};
    const human = HUMAN_ONLY.has(String(tool));
    if (human || PERSON_ONLY.has(String(tool))) {
      const person = saved.person;
      if (!person || !isPerson(caller)) {
        return { error: { code: "person_session_required", message: `${tool} is the person's own action on the box: sign this Mac in first (vyre link signin), or do it in the Deck, the Capsule or the phone` } };
      }
      extra = personHeaders(person, "/v1/tools/" + encodeURIComponent(tool), input);
      // A human-only tool also needs a proof the box can check: this Mac's Secure Enclave key,
      // enrolled on the box at sign-in, signs this exact call after Touch ID (ADR 0032 part 2c).
      if (human) {
        if (!person.human || !person.human.key) return { error: { code: "presence_required", message: `${tool} needs your passkey on the box, or sign this Mac in again (vyre link signin) to use Touch ID here` } };
        const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
        const msg = Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`);
        let sig;
        try { sig = await se.sign(person.human.handle, msg, `Vyre: ${tool} on your box`); }
        catch (e) { return { error: { code: /** @type {any} */ (e).code || "presence_required", message: /** @type {Error} */ (e).message } }; }
        extra["x-vyre-presence"] = `device key=${person.human.key} ts=${ts} nonce=${nonce} sig=${sig}`;
      }
    }
    if (!state.reachable && Date.now() < state.nextTry) return { error: { code: "box_unreachable", message: state.error || "the box is not reachable" } };
    return boxCall(tool, input, conn, { headers: extra });
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

  // Nonces of the box's answers seen here, each until its assertion expires, persisted so a
  // restart inside the 60 s TTL cannot forget one (e2e review of 0f2a8752, LOW 2).
  const nonces = new Nonces(path.join(ctx.paths.root, NONCES_FILE));
  /**
   * The box's answer to one of this Mac's asks: runs only when its assertion checks out.
   * @param {any} q the box's request
   */
  async function answer(q) {
    const input = q.input && typeof q.input === "object" ? q.input : {};
    // The Mac's own record of the ask says whether it is gated, not the box: an ask that approves
    // a floor tool needs a fresh proof of presence on the box (federate.js gatedAsk). Fail closed:
    // if threads.asks cannot be read, or this ask is not in it, gatedAsk(null) would say "ungated"
    // and an assertion with no fresh proof would be accepted for what may be a gated ask (e2e,
    // review of 0f2a8752). Refuse instead of guessing; the box can ask again once it can read it.
    const open = await ctx.call("threads.asks", {});
    if (open.error || !Array.isArray(open.data)) return { error: { code: "denied", message: "the box's answer was refused: could not read this ask" } };
    const mine = open.data.find(a => a && a.id === input.ask);
    if (!mine) return { error: { code: "denied", message: "the box's answer was refused: could not read this ask" } };
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
    effect: "write",
    description: "Pair this device with your box. Shows a code to approve on the box: `vyre link approve <code>` there, or in the Deck. kind: \"mac\" (the default, the full link feature set) or \"device\" (paired only to import its own sessions, core/sync).",
    input: { type: "object", properties: { box: { type: "string" }, kind: { type: "string", enum: ["mac", "device"] } }, required: ["box"] },
    callers: ["cli", "local", "capsule"],
    run: async ({ box, kind }) => {
      let address = String(box).trim();
      if (!/^[a-z]+:\/\//i.test(address)) address = "https://" + address;
      if (!mayPair(address)) throw refuse();
      if (pairing && pairing.timer) clearTimeout(pairing.timer);
      pairing = null;
      // The first connection is unpinned: it is how the box's node is learned. Everything after is
      // pinned to it, and the owner approving on that very box is what makes the pin trustworthy.
      const first = connect(address, null);
      let r;
      try { r = await first.json("POST", "/v1/tools/link.pair.request", { name: seam.hostname || os.hostname(), ...(kind === "device" ? { kind } : {}) }, { timeout: seam.timeout || 10_000 }); }
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
    effect: "read",
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

  // ---- this Mac's person session on the box (core/presence/person.js) ----
  // `vyre link signin` opens the box's sign-in page in the person's browser with a PKCE challenge
  // and a one-time loopback address here. The person confirms with their passkey (Touch ID) on
  // the box's own page; the box sends a code to the loopback, and vyred trades it, with the
  // verifier and the public half of a key it just made, for a 30-day session. The session and the
  // key are kept in link.json (0600): a process of this user can read them, which is the Mac's
  // accepted residual (team/archive/work-journals/e2e.md); minting one always takes the person's passkey.
  /** @type {{ server: http.Server, url: string, expires: number } | null} */
  let signing = null;
  ctx.tool("link.signin", {
    effect: "write",
    description: "Sign this Mac's command line and Capsule in as you on the box for 30 days, so they can answer asks and approve there. Answers the address to open; you confirm with your passkey on the box's page.",
    callers: ["cli", "local", "capsule"],
    input: { type: "object", properties: {} },
    run: async () => {
      if (!saved || !conn || saved.revoked) throw Object.assign(new Error("this Mac is not paired with a box (vyre link pair <address>)"), { code: "no_link" });
      if (signing && signing.expires > Date.now()) return { url: signing.url, expires: signing.expires };
      const verifier = crypto.randomBytes(32).toString("base64url");
      const cc = crypto.createHash("sha256").update(verifier).digest("base64url");
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const nonce = crypto.randomBytes(16).toString("base64url");
      const box = saved.box.address;
      const server = http.createServer((req, res) => { answer(req, res).catch(e => { if (!res.headersSent) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end(`Signing in did not work: ${e.message}`); } }); });
      const answer = async (req, res) => {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        const page = (status, text) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(text); };
        if (req.method !== "GET" || u.pathname !== `/cb/${nonce}` || !u.searchParams.get("code")) return page(404, "Not found");
        const pub = publicKey.export({ format: "jwk" });
        // A Secure Enclave key rides the sign-in, so this Mac can prove human-only calls too.
        let sek = null;
        if (hasEnclave()) { try { sek = await se.create(); } catch { sek = null; } }
        const human = sek ? crypto.createPublicKey({ key: Buffer.from(sek.spki, "base64url"), format: "der", type: "spki" }).export({ format: "jwk" }) : undefined;
        const r = await conn.json("POST", "/v1/person/token", { code: u.searchParams.get("code"), verifier, key: pub, ...(human ? { human } : {}) }).catch(e => ({ body: { error: { message: e.message } } }));
        const data = r.body && r.body.data;
        if (!data || !data.token) return page(403, `Signing in did not work: ${(r.body && r.body.error && r.body.error.message) || "the box refused"}`);
        const enrolled = sek && data.human && data.human.key ? { handle: sek.handle, key: String(data.human.key) } : null;
        save({ ...saved, person: { token: data.token, id: data.id, key: privateKey.export({ format: "jwk" }), expires: data.expires, ...(enrolled ? { human: enrolled } : {}) } });
        ctx.events.emit("link.signed-in", { box, expires: data.expires });
        // Closed once the page is sent: close() also drops idle connections, and would cut this one.
        res.on("close", stop);
        page(200, "This Mac is signed in for 30 days. You can close this tab.");
      };
      const stop = () => { if (signing && signing.server === server) signing = null; server.close(); };
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
      const port = /** @type {any} */ (server.address()).port;
      const back = `http://127.0.0.1:${port}/cb/${nonce}`;
      const url = `${box}/person/signin?cc=${cc}&return=${encodeURIComponent(back)}`;
      const expires = Date.now() + 10 * 60_000;
      signing = { server, url, expires };
      setTimeout(stop, 10 * 60_000).unref();
      return { url, expires };
    },
  });

  ctx.tool("link.signout", {
    effect: "write",
    description: "Sign this Mac out on the box: its command line and Capsule are only a device there again.",
    callers: ["cli", "local", "capsule"],
    input: { type: "object", properties: {} },
    run: async () => {
      const had = Boolean(saved && saved.person);
      if (had && conn) {
        const h = personHeaders(saved.person, "/v1/person/end", {});
        await conn.json("POST", "/v1/person/end", {}, { headers: h }).catch(() => null);
      }
      if (had) { const { person, ...rest } = saved; save(rest); ctx.events.emit("link.signed-out", {}); }
      return { signedOut: had };
    },
  });

  ctx.tool("link.status", {
    effect: "read", callers: [...PERSON_SURFACES, "module"],
    description: "Whether this Mac is paired with a box, and whether the box is reachable right now.",
    input: { type: "object", properties: {} },
    run: async () => ({
      role: "local", linked: Boolean(saved && !saved.revoked),
      box: saved ? { address: saved.box.address, name: saved.box.name || null, node: saved.box.node || null, stableId: saved.box.stableId || null } : null,
      reachable: state.reachable, lastSeen: state.lastSeen, serving, following: follows.size,
      pending: pairing ? { id: pairing.id, code: pairing.code, expires: pairing.expires } : null,
      signedIn: saved && saved.person && saved.person.expires > Date.now() ? { expires: saved.person.expires, touchId: Boolean(saved.person.human) } : null,
      ...(state.error ? { error: state.error } : {}),
    }),
  });

  ctx.tool("link.health", {
    effect: "read",
    description: "How this Mac reaches its box right now: reach (direct over the tailnet, or none), why, fix, since and the tailnet path and latency; the older path, latencyMs and lastHandshake stay. Checked at most once a minute.",
    input: { type: "object", properties: {} },
    run: async () => {
      if (!saved || saved.revoked) return shaped(unknown(saved ? "the box no longer knows this Mac; pair again" : "this Mac is not paired with a box", Date.now()), reachSince, "box");
      if (!saved.box.stableId) return shaped(unknown("the box's node is not known; pair again", Date.now()), reachSince, "box");
      return shaped(await health.check({ stableId: saved.box.stableId }), reachSince, "box");
    },
  });

  ctx.tool("link.unpair", {
    effect: "write",
    description: "Forget the box on this Mac, and tell the box to forget this Mac when it can be reached.",
    input: { type: "object", properties: {} },
    callers: ["cli", "local", "capsule"],
    run: async () => {
      if (!saved) return { unpaired: false };
      const told = saved.revoked ? { data: true } : await boxCall("link.unpair", { key: saved.key });
      // The box being away is expected and not an error (the tool's own description: "when it
      // can be reached") -- this Mac still forgets locally, and the box catches up when it is
      // next reachable. A REAL refusal while the box IS reachable (a stale key, a lookup that
      // failed) is different: something is actually wrong, and reporting `unpaired: true`
      // regardless silently hid it, leaving a stale row on the box with no error anyone saw
      // (the rc.2 find, 28 Sep -- personguard had made the box refuse this call outright, and
      // this swallowed that refusal too). Surface it instead of hiding it.
      if (told.error && !["box_unreachable", "not_box"].includes(told.error.code)) {
        throw Object.assign(new Error(`the server didn't forget this Mac: ${told.error.message}`), { code: told.error.code });
      }
      const was = saved.box.address;
      save(null); beating(false); stopServing(); unfollowAll(); askListen(false); conn = null; state.reachable = false; state.announced = null;
      ctx.events.emit("link.unpaired", { box: was });
      return { unpaired: true, boxForgot: !told.error };
    },
  });

  /** Only Vyre's own modules reach the box through this Mac's paired-device identity: an added module is refused before anything is forwarded. */
  const firstPartyOnly = (/** @type {any} */ meta, /** @type {string} */ tool) => {
    if (String((meta && meta.caller) || "").startsWith("module:") && !(meta && meta.firstParty)) throw Object.assign(new Error(`${tool} reaches the box as this Mac; only Vyre's own modules may use it`), { code: "denied" });
  };

  ctx.tool("link.call", {
    effect: "write", callers: [...PERSON_SURFACES, "module"],
    description: "Call a tool on your box from this Mac (threads, agents, files). Answers box_unreachable when the box is away.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] },
    // The box sees this Mac as the owner's device, so a model or an agent must never ride it: only the person's own surfaces and modules call it (reviewer-2 HD-3). A model that needs a box tool
    // asks through its own tools, which the box gates by the model's own caller.
    callers: ["cli", "local", "deck", "capsule", "mobile", "module"],
    run: async ({ tool, input }, meta) => {
      firstPartyOnly(meta, "link.call");
      // A module hop made for a model (meta.origin) is a model's call: it never rides this Mac's paired-device identity to the box.
      if (meta && meta.origin && !isPerson(meta.origin)) throw Object.assign(new Error("link.call is the person's own; a module acting for a model session may not use it"), { code: "denied" });
      const r = await remote(tool, input || {}, meta && meta.caller);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    },
  });

  ctx.tool("link.remote", {
    description: "ctx.remote's carrier: a box tool for a module on this Mac.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] },
    internal: true,
    run: async ({ tool, input }, meta) => { firstPartyOnly(meta, "link.remote"); return { result: await remote(tool, input || {}) }; },
  });

  // A raw POST with a Buffer body, for the one thing link.remote (JSON only) cannot carry: an
  // upload's chunk bytes (core/sync). Not a general proxy: only the box's own upload route, by
  // path, never a tool name, so this can never reach anything link.remote already refuses.
  ctx.tool("link.upload", {
    description: "One chunk of sync.upload's bytes, as a Buffer, to the box's upload route. Internal: core/sync's own carrier for what link.remote (JSON only) cannot send. The path is built here, from a validated upload id, never taken from the caller (e2e's review: a caller-given path resolved through new URL()'s own \"..\" handling would have reached any box tool).",
    input: { type: "object", required: ["upload", "offset", "data"], properties: { upload: { type: "string" }, offset: { type: "integer", minimum: 0 }, data: {} } },
    internal: true,
    run: async ({ upload, offset, data }, meta) => {
      firstPartyOnly(meta, "link.upload");
      // Exactly what sync.upload.start hands back: a UUID. Nothing else is even attempted.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(upload))) {
        throw Object.assign(new Error("upload must be the id sync.upload.start gave"), { code: "bad_input" });
      }
      if (!conn) throw Object.assign(new Error("this Mac is not paired with a box (vyre link pair <address>)"), { code: "no_link" });
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "base64");
      const p = `/v1/sync/upload/${encodeURIComponent(upload)}?offset=${encodeURIComponent(String(offset))}`;
      let r;
      try {
        r = await conn.json("POST", p, buf, { timeout: seam.timeout || 10_000 });
        up();
      } catch (e) {
        const err = /** @type {any} */ (e);
        throw Object.assign(new Error(err.code === "not_box" ? err.message : `the box is not reachable (${err.code || err.message})`), { code: err.code === "not_box" ? "not_box" : "box_unreachable" });
      }
      // Same convention as boxCall/link.call: the box's own error becomes this call's error too.
      if (r.body && r.body.error) throw Object.assign(new Error(r.body.error.message), { code: r.body.error.code });
      return r.body && r.body.data !== undefined ? r.body.data : r.body;
    },
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
  }, { readOnly: true });

  return {
    async stop() {
      stopped = true; beating(false); stopServing(); unfollowAll(); askListen(false);
      if (pairing && pairing.timer) clearTimeout(pairing.timer);
      for (const end of streams) end();
    },
  };
}
