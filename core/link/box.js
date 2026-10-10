// @ts-check
// box — the box's half of the link: pairing requests from a Mac, their approval, and the paired
// Macs.
//
// Pairing needs the owner present at both ends. The Mac asks, and gets a code that is shown only
// to it. Someone at the box types that code back. A Claude process on the box cannot finish a
// pairing, because it never sees the code, and a process on the Mac cannot approve its own
// request, because it is the requesting node. Codes and request secrets are held only in memory,
// as HMACs under a key made when vyred starts, so a restart voids every pending request and the
// store never holds anything a guess could be checked against.
//
// The box also reads its paired Macs, through the same link run the other way. The Mac opens no
// port: it holds a request to link.serve open, and the box answers it with the next question when
// a module asks (link.macs.call). The Mac runs it and answers with link.reply. Nothing a Mac
// answers is written to the store; it goes back to the module that asked and is forgotten.
//
// One write crosses the same way (allow.js WRITE): threads.send, for the person only. The Mac
// then sends that thread's events back with link.events, and the box re-emits them labelled with
// the Mac, so the Deck sees the answer arrive. Only for threads the box sent to in the last 30
// minutes, and only from the Mac it sent to.
//
// The other write is threads.answer (ADR 0021 "v2"). Every Mac forwards its asks (ask.raised,
// ask.answered) while paired, so the box knows which Mac an ask is on. When the person answers one
// here, the box signs an assertion with its own key (assert.js) bound to that Mac, that ask and
// that exact answer, and the Mac checks it against the key it pinned at pairing before it runs.
//
// Session import (ADR 0008 5a) gives a peer a kind: "mac" (the full feature set above) or
// "device" (paired only to send its own sessions). Capability lives on the peer row, not a
// second identity path (e2e's review): link.macs and link.macs.call never see a "device" peer.
// The upload protocol itself is core/sync's, which asks link.peer-of (internal) to turn a
// connection's tailnet node into the peer it is, since sync owns no pairing of its own.

import { deviceIdOf } from "../../lib/caller.js";
import crypto from "node:crypto";
import { friendlyDeviceName, cleanLabel } from "../../lib/devicename.js";
import { createHealth, unknown, shaped, sinceTracker } from "./health.js";
import { ALLOW, WRITE, CALL, FOLLOWED, ASKS } from "./allow.js";
import { originClass } from "../modules/index.js";
import { isPerson } from "../../lib/caller.js";
import { boxKey, signAnswer, signCall } from "./assert.js";
import { companionSide } from "./companion.js";

const TTL = 10 * 60_000;
const MAX_PENDING = 5;
const MAX_WRONG = 5;
/** How long link.serve holds a Mac's request open when there is nothing to ask. */
const HOLD = 60_000;
/** A Mac with no request held and none in this long is offline: link.macs.call does not wait for it. */
const FRESH = 3000;
/** How long the box takes a Mac's events for a thread it sent to (link.events). */
const FOLLOW = 30 * 60_000;
/** At most this many events in one link.events batch. */
const BATCH = 500;
/** The Macs' open asks the box remembers (ask id -> Mac), and for how long at most. */
const MAX_ASKS = 500;
const ASK_AGE = 24 * 3600_000;

const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/** A code the owner can read and type: six digits, shown as 123-456. */
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const cleanCode = c => String(c || "").replace(/\D/g, "");
export const showCode = c => `${c.slice(0, 3)}-${c.slice(3)}`;

/** Callers of the box's own socket: its terminal. Claude's processes are here too, which is why the code matters. */
const SOCKET = new Set(["cli", "local", "deck", "capsule"]);
/** Who may read the box's pairing lists and approve there: its terminal, the Deck and Capsule, and the owner's own devices. A model session is not one. */
const BOX_PEOPLE = Object.freeze(["cli", "local", "deck", "capsule", "mobile", "tailnet", "device"]);
// Only the owner's devices: "tailnet:<login>". A guest ("tailnet-guest:<login>") never matches, and
// an agent's own node ("tailnet:agent:<name>") is not a person's device, so it is refused too.
const tailnetLogin = caller => {
  const c = String(caller);
  return c.startsWith("tailnet:") && !c.startsWith("tailnet:agent:") ? c.slice("tailnet:".length) : null;
};

/**
 * @param {any} ctx the module's context
 * @param {{ now?: () => number, hold?: number, allow?: readonly string[], health?: { check: (which: any) => Promise<any> } }} [opts] test seams:
 *   the clock, how long link.serve holds a request, the tools the box may ask a Mac for, and the
 *   health check. Production passes nothing.
 */
export function boxSide(ctx, { now = Date.now, hold = HOLD, allow = ALLOW, health = createHealth({ ctx }) } = {}) {
  const db = ctx.store.db;
  ctx.store.migrate([
    `CREATE TABLE link_peers (id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT, node TEXT, stable_id TEXT,
       key_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER)`,
    // Capabilities live on the peer row, not a second identity path (e2e, session-import review):
    // "mac" is the full link feature set (reads, file delivery, ask-answering); "device" is a peer
    // paired only to import its own sessions (sync.upload.*), never forwarded a read or a write.
    `ALTER TABLE link_peers ADD COLUMN kind TEXT NOT NULL DEFAULT 'mac'`,
    // A companion (core/link/companion.js): a local core vouched for by the desktop app device that is its parent.
    `ALTER TABLE link_peers ADD COLUMN parent TEXT`,
    `ALTER TABLE link_peers ADD COLUMN core_pub TEXT`,
  ]);
  const pepper = crypto.randomBytes(32);
  const mac = s => crypto.createHmac("sha256", pepper).update(String(s)).digest();
  /** @type {Map<string, { id: string, name: string, login: string, peer: any, code: Buffer, secret: Buffer, created: number, expires: number, key?: string, peerId?: string, denied?: boolean }>} */
  const pending = new Map();
  let wrong = 0;
  // The key the box signs its answers to a Mac's asks with: made on first need, kept at 0600 in
  // this home. Its public half goes to a Mac when it pairs, and in link.hello for one paired before.
  /** @type {ReturnType<typeof boxKey> | null} */
  let signing = null;
  const assertKey = () => (signing ||= boxKey(ctx.paths.root));

  const sweep = () => { for (const [id, p] of pending) if (p.expires < now()) pending.delete(id); };
  const peerOf = meta => (meta && meta.peer) || null;

  ctx.tool("link.pair.request", {
    effect: "write", callers: BOX_PEOPLE,
    description: "Start pairing a device with this box. Called by the device's vyred over the tailnet; the code it returns is shown on the device only. kind: \"mac\" (the default, the full link feature set) or \"device\" (a peer paired only to import its own sessions).",
    input: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["mac", "device"] } }, required: ["name"] },
    run: async ({ name, kind }, meta) => {
      const login = tailnetLogin(meta.caller);
      if (!login) throw new Error("pairing starts from the device, over the tailnet");
      sweep();
      if (pending.size >= MAX_PENDING) throw new Error("too many pairing requests are waiting; approve or deny them on the box first");
      const id = crypto.randomUUID(), code = newCode(), secret = crypto.randomBytes(32).toString("base64url");
      const peer = peerOf(meta), created = now();
      const k = kind === "device" ? "device" : "mac";
      name = friendlyDeviceName(name, { kind: k, owner: (ctx.config.onboard || {}).person });
      pending.set(id, { id, name: String(name).slice(0, 80), login, peer, kind: k, code: mac(code), secret: mac(secret), created, expires: created + TTL });
      ctx.events.emit("link.pair-requested", { id, name: String(name).slice(0, 80), login, kind: k, expires: created + TTL });
      return { id, code: showCode(code), secret, expires: created + TTL, box: { name: ctx.config.name || null } };
    },
  });

  ctx.tool("link.pending", {
    effect: "read", callers: [...BOX_PEOPLE, "module"], // waiting counts pairing requests from an event
    description: "Pairing requests waiting for approval on this box. The codes are never listed: they are on the Mac's screen.",
    input: { type: "object", properties: {} },
    run: async () => { sweep(); return [...pending.values()].filter(p => !p.key && !p.denied).map(p => ({ id: p.id, name: p.name, login: p.login, node: p.peer ? p.peer.node : null, kind: p.kind || "mac", created: p.created, expires: p.expires })); },
  });

  /** May this caller approve or deny request p? The box's terminal, or another of the owner's devices. */
  /**
   * May this caller decide request p? The box's terminal, another of the owner's devices, or the
   * asking Mac itself when this very call carried a fresh passkey assertion: a person touched the
   * owner's passkey on that device just now, which a model on the Mac cannot do. A presence
   * session (a proof made earlier) is not enough for the Mac's own request. `fresh` is false for
   * deny, which needs no proof.
   */
  const mayDecide = (p, meta, fresh = false) => {
    if (SOCKET.has(String(meta.caller))) return true;
    if (!tailnetLogin(meta.caller)) return false;
    const peer = peerOf(meta);
    // Without knowing which node is asking, a tailnet caller could be the Mac approving itself.
    if (!(peer && peer.stableId && p.peer && p.peer.stableId)) return false;
    if (peer.stableId !== p.peer.stableId) return true;
    return fresh && Boolean(meta.presence && meta.presence.method === "passkey");
  };

  ctx.tool("link.pair.approve", {
    effect: "write", callers: BOX_PEOPLE,
    description: "Approve a Mac's pairing with the code shown on the Mac, e.g. `vyre link approve 123-456` on the box.",
    input: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    // Approving is on the floor's presence list: the owner proves they are there (a passkey from
    // the Deck), whoever the caller is, since a model on the Mac can read the code and ssh here.
    // The prompt names the Mac asking, never the code. Looking it up is not a guess: it never
    // counts toward the wrong-code limit.
    presence: { summary: ({ code }) => {
      const want = mac(cleanCode(code));
      const p = [...pending.values()].find(x => !x.key && !x.denied && x.expires >= now() && crypto.timingSafeEqual(x.code, want));
      return p ? `Pair the Mac "${p.name}"${p.peer && p.peer.node ? ` (${p.peer.node})` : ""} with this box` : "Pair a new Mac with this box";
    } },
    run: async ({ code }, meta) => {
      sweep();
      const want = mac(cleanCode(code));
      const p = [...pending.values()].find(x => !x.key && !x.denied && crypto.timingSafeEqual(x.code, want));
      if (!p) {
        // Guessing is capped across every request: after five wrong codes, all of them are void.
        if (++wrong >= MAX_WRONG) { pending.clear(); wrong = 0; throw new Error("too many wrong codes; every pairing request was cancelled, start again from the Mac"); }
        throw new Error("no pairing request has that code (it may have expired)");
      }
      if (!mayDecide(p, meta, true)) throw new Error("approve with your passkey (Touch ID on this Mac, or on your phone); a Mac cannot approve its own pairing without one");
      wrong = 0;
      const key = crypto.randomBytes(32).toString("base64url"), id = crypto.randomUUID();
      db.prepare("INSERT INTO link_peers (id, name, login, node, stable_id, key_hash, paired_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, p.name, p.login, p.peer ? p.peer.node || null : null, p.peer ? p.peer.stableId || null : null, sha(key), now(), p.kind || "mac");
      Object.assign(p, { key, peerId: id, expires: now() + 60_000 });
      ctx.events.emit("link.paired", { peer: id, name: p.name, login: p.login, kind: p.kind || "mac" });
      return { peer: id, name: p.name, kind: p.kind || "mac" };
    },
  });

  ctx.tool("link.pair.deny", {
    effect: "write",
    description: "Refuse a pairing request.",
    input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async ({ id }, meta) => {
      const p = pending.get(id);
      if (!p) throw new Error("no such pairing request");
      if (!mayDecide(p, meta)) throw new Error("deny on the box itself, or from another of your devices");
      p.denied = true;
      return { denied: id };
    },
  });

  ctx.tool("link.pair.poll", {
    effect: "write", callers: BOX_PEOPLE,
    description: "The Mac asks whether its pairing was approved; the link key is handed over once.",
    input: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" } }, required: ["id", "secret"] },
    run: async ({ id, secret }, meta) => {
      const p = pending.get(id);
      if (!p || !tailnetLogin(meta.caller) || !crypto.timingSafeEqual(p.secret, mac(secret))) return { state: "gone" };
      // The key goes only to the node that asked, when the listener says which node that is.
      const peer = peerOf(meta);
      if (p.peer && p.peer.stableId && (!peer || peer.stableId !== p.peer.stableId)) return { state: "gone" };
      if (p.expires < now()) { pending.delete(id); return { state: "expired" }; }
      if (p.denied) { pending.delete(id); return { state: "denied" }; }
      if (!p.key) return { state: "pending", expires: p.expires };
      pending.delete(id);
      // The Mac pins the box's signing key with the pairing, and learns its own node as the box sees it.
      return { state: "approved", key: p.key, peer: p.peerId, box: { name: ctx.config.name || null, assertKey: assertKey().publicKey },
        you: p.peer && p.peer.stableId ? { stableId: p.peer.stableId } : null };
    },
  });

  /** The paired Mac this key belongs to, checked against the calling node when known. */
  const byKey = (key, meta) => {
    const row = /** @type {any} */ (db.prepare("SELECT * FROM link_peers WHERE key_hash = ? AND kind != 'companion'").get(sha(String(key || ""))));
    if (!row || !tailnetLogin(meta.caller)) return null;
    const peer = peerOf(meta);
    if (row.stable_id && peer && peer.stableId !== row.stable_id) return null;
    return row;
  };

  ctx.tool("link.hello", {
    effect: "write", callers: BOX_PEOPLE,
    description: "A paired Mac checks in. Answers who this box is, or unpaired when the key is not known here.",
    input: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    run: async ({ key }, meta) => {
      const row = byKey(key, meta);
      if (!row) return { paired: false };
      db.prepare("UPDATE link_peers SET last_seen = ? WHERE id = ?").run(now(), row.id);
      // assertKey and you: a Mac paired before answers crossed takes them once, over this pinned channel.
      return { paired: true, peer: row.id, box: { name: ctx.config.name || null, role: ctx.config.role, assertKey: assertKey().publicKey },
        you: row.stable_id ? { stableId: row.stable_id } : null };
    },
  });

  ctx.tool("link.peers", {
    effect: "read", callers: [...BOX_PEOPLE, "module"],
    description: "Every device paired with this box, Macs and import-only devices alike, with its kind.",
    input: { type: "object", properties: {} },
    run: async () => db.prepare("SELECT id, name, login, node, stable_id, paired_at, last_seen, kind FROM link_peers ORDER BY paired_at").all(),
  });

  /** Who may ask link.health: a module, the person at the box, or the owner over the tailnet. */
  const healthCaller = caller => {
    if (caller.startsWith("module:") || SOCKET.has(caller)) return true;
    const login = tailnetLogin(caller);
    if (!login || login.startsWith("agent:") || /\s/.test(login)) return false;
    const owner = ctx.config.network && ctx.config.network.owner;
    return !owner || login === owner;
  };

  const reachSince = sinceTracker(now);

  ctx.tool("link.health", {
    effect: "read",
    description: "How this box reaches the device that asks: reach (direct or relay), why, fix, since, and the tailnet path and latency.",
    input: { type: "object", properties: { node: { type: "string", description: "a paired Mac's node id; the calling device by default" } } },
    run: async ({ node }, meta) => {
      // Modules and the owner only (lead's decision, 27 Sep 2026). A guest from another tailnet
      // or an agent's own node learns nothing about how this box's links run, and neither does a
      // tailnet login that is not the owner the names module serves.
      const caller = String(meta.caller);
      // A paired device over the relay channel is on the relay by definition. The start of that
      // path is the channel's own when the bridge says (meta.since), else the first time it asked.
      if (deviceIdOf(caller) !== null) {
        const at = Number.isFinite(meta.since) ? meta.since : reachSince.at(caller, "relay");
        return { path: "unknown", relay: null, latencyMs: null, lastHandshake: null, online: true, checkedAt: now(), cached: false,
          reach: "relay", why: "Connected through Vyre's relay.", since: at };
      }
      if (!healthCaller(caller)) throw new Error("link.health answers the box's owner and its modules only");
      const own = peerOf(meta);
      const asked = node ? String(node) : own && own.stableId ? String(own.stableId) : null;
      if (!asked) return shaped(unknown("say which node: a paired Mac's node id (vyre link peers)", now()), reachSince, "none");
      // Any caller may ask about itself or a paired Mac. A module may name any node: Glass asks
      // about the viewer the tailnet listener identified, which may be a phone rather than a Mac.
      const mayName = String(meta.caller).startsWith("module:") || (own && own.stableId === asked)
        || db.prepare("SELECT 1 FROM link_peers WHERE stable_id = ?").get(asked);
      if (!mayName) throw new Error("that node is not a paired Mac");
      const h = shaped(await health.check({ stableId: asked }), reachSince, asked);
      // The caller came in over the tailnet listener, so for itself the answer is direct even when
      // the box's own ping of it fails (a phone asleep between requests); the detail is still
      // whatever the link said.
      if (tailnetLogin(caller) && own && own.stableId === asked && h.reach === "none") {
        const { fix, ...rest } = h;
        return { ...rest, reach: "direct", why: "Connected to your server.", since: reachSince.at(asked, "direct") };
      }
      return h;
    },
  });

  ctx.tool("link.rename", {
    effect: "write",
    description: "Rename a paired Mac or device: the person's own label, kept on the box and shown wherever the device appears (the Deck, session rows, Drive, Now). A new name replaces what the device called itself.",
    input: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
    run: async ({ id, name }) => {
      const label = cleanLabel(name);
      if (!label || label.length > 64) throw new Error("a name is 1 to 64 printable characters");
      const r = db.prepare("UPDATE link_peers SET name = ? WHERE id = ?").run(label, String(id));
      if (!r.changes) throw new Error("no such paired Mac");
      ctx.events.emit("device.renamed", { kind: "mac", id: String(id), name: label });
      return { id: String(id), name: label };
    },
  });

  ctx.tool("link.unpair", {
    effect: "write",
    description: "Forget a paired Mac or device. On the box, by id; from the device, with its own key. If it ever synced sessions, core/sync deletes everything it sent when it hears link.unpaired.",
    input: { type: "object", properties: { id: { type: "string" }, key: { type: "string" } } },
    run: async ({ id, key }, meta) => {
      let row = null;
      if (key) row = byKey(key, meta);
      else if (id && (SOCKET.has(String(meta.caller)) || tailnetLogin(meta.caller))) row = db.prepare("SELECT * FROM link_peers WHERE id = ?").get(id);
      if (!row) throw new Error("no such paired Mac");
      db.prepare("DELETE FROM link_peers WHERE id = ?").run(/** @type {any} */ (row).id);
      forget(/** @type {any} */ (row).id);
      ctx.events.emit("link.unpaired", { peer: /** @type {any} */ (row).id, name: /** @type {any} */ (row).name });
      return { unpaired: /** @type {any} */ (row).id };
    },
  });

  ctx.tool("link.status", {
    effect: "read",
    description: "This box's side of the link: its paired Macs and waiting requests.",
    input: { type: "object", properties: {} },
    run: async () => { sweep(); return { role: "box", peers: db.prepare("SELECT COUNT(*) AS n FROM link_peers").get().n, pending: [...pending.values()].filter(p => !p.key && !p.denied).length }; },
  });

  // The reverse channel. Per paired Mac: the request it holds open (at most one), when it last
  // asked, and the questions queued for it. Every question waits by id for its answer. All of it
  // lives in memory only, and holds nothing but the one answer in flight.
  /** @type {Map<string, { resolve: (q: any) => void, timer: any }>} */
  const waiting = new Map();
  /** @type {Map<string, number>} */
  const lastServe = new Map();
  /** @type {Map<string, string[]>} */
  const queues = new Map();
  /** @type {Map<string, { id: string, mac: string, tool: string, input: any, as?: string, assertion?: any, sent: boolean, done: (r: any) => void }>} */
  const asks = new Map();
  /** The Macs' open asks, from their ask.raised: ask id -> { mac, thread, at }. Memory only. @type {Map<string, { mac: string, thread: string, at: number }>} */
  const macAsks = new Map();
  /** Threads the box sent to on a Mac, for link.events: thread -> (mac id -> when). Memory only. @type {Map<string, Map<string, number>>} */
  const forwarded = new Map();
  const sweepForwarded = () => {
    const old = now() - FOLLOW;
    for (const [thread, macs] of forwarded) {
      for (const [m, at] of macs) if (at < old) macs.delete(m);
      if (!macs.size) forwarded.delete(thread);
    }
  };

  /** Answer the Mac's held request, if it has one. */
  const release = (macId, q) => {
    const w = waiting.get(macId);
    if (!w) return false;
    waiting.delete(macId); clearTimeout(w.timer); w.resolve(q);
    return true;
  };
  /** The next question for a Mac, marked as sent, or null. */
  const next = macId => {
    const queue = queues.get(macId) || [];
    while (queue.length) {
      const a = asks.get(/** @type {string} */ (queue.shift()));
      if (a) { a.sent = true; return { id: a.id, tool: a.tool, input: a.input, ...(a.as ? { as: a.as } : {}), ...(a.assertion ? { assertion: a.assertion } : {}) }; }
    }
    return null;
  };
  /** A Mac was unpaired: let go of its held request and fail what was waiting on it. */
  const forget = macId => {
    release(macId, null);
    lastServe.delete(macId); queues.delete(macId);
    for (const [thread, macs] of forwarded) { macs.delete(macId); if (!macs.size) forwarded.delete(thread); }
    for (const [ask, m] of macAsks) if (m.mac === macId) macAsks.delete(ask);
    for (const a of [...asks.values()]) if (a.mac === macId) a.done({ ok: false, error: { code: "unpaired", message: "this Mac was unpaired" } });
  };
  // A Mac counts as there when it holds a request, asked within FRESH, or is working on a question
  // right now (it answers one at a time, so a slow search must not make it look gone).
  const online = macId => waiting.has(macId) || (lastServe.get(macId) ?? -Infinity) >= now() - FRESH
    || [...asks.values()].some(a => a.mac === macId && a.sent);

  ctx.tool("link.serve", {
    effect: "write", callers: BOX_PEOPLE,
    description: "A paired Mac waits here for the box's next question. Answers { id, tool, input }, or null when there was none for a while.",
    input: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    run: async ({ key }, meta) => {
      const row = byKey(key, meta);
      if (!row) return { paired: false };
      // A Mac that was away and asks again is back: a Flow waiting for a Chrome to come online wakes on this.
      const wasOnline = online(row.id);
      lastServe.set(row.id, now());
      if (!wasOnline) ctx.events.emit("link.mac-online", { peer: row.id, name: row.name });
      // One held request per Mac: a newer one means the older is gone or abandoned.
      release(row.id, null);
      const q = next(row.id);
      if (q) return q;
      return new Promise(resolve => {
        const timer = setTimeout(() => { if (waiting.get(row.id)?.resolve === resolve) waiting.delete(row.id); resolve(null); }, hold);
        timer.unref();
        waiting.set(row.id, { resolve, timer });
      });
    },
  });

  ctx.tool("link.reply", {
    effect: "write", callers: BOX_PEOPLE,
    description: "A paired Mac answers one of the box's questions: result is { data } or { error }.",
    input: { type: "object", properties: { key: { type: "string" }, id: { type: "string" }, result: { type: "object" } }, required: ["key", "id", "result"] },
    run: async ({ key, id, result }, meta) => {
      const row = byKey(key, meta);
      if (!row) return { paired: false };
      const a = asks.get(id);
      // Only the Mac that was asked can answer, and an answer that came too late is dropped.
      if (!a || a.mac !== row.id || !a.sent) return { ok: false };
      const e = result && result.error;
      a.done(e ? { ok: false, error: { code: String(e.code || "failed").slice(0, 40), message: String(e.message || "the Mac could not answer").slice(0, 500) } }
        : { ok: true, data: result ? result.data : undefined });
      return { ok: true };
    },
  });

  ctx.tool("link.macs.call", {
    description: "Ask every paired Mac (or one: mac, its id or name) for one of its read tools, or, as the person, threads.send or threads.answer (by: the box's caller, device, person session and presence method, for the answer's assertion). Answers [{ mac, name, ok, data?, error? }], one per Mac asked.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" }, timeout: { type: "number" }, mac: { type: "string" }, as: { type: "string" },
      by: { type: "object", properties: { caller: { type: "string" }, device: { type: "string" }, person: { type: "string" }, presence: { type: "string" } } } }, required: ["tool"] },
    internal: true,
    run: async ({ tool, input = {}, timeout, mac: only, as, by }, meta = {}) => {
      // A read list widened by a test seam to take a write sends it as a read, without `as`: how
      // the Mac's own refusal is reached. Production's list never holds a write.
      const write = WRITE.includes(tool) && !allow.includes(tool);
      // A write is the person's only: the switchboard says so for the person's own callers.
      // The caller named in `by` is the switchboard's claim. What decides is who the call really came from past its module hop (`meta.origin`): a model, an agent or a timer that went through a module
      // is never the person, whatever `as` and `by` say (platform-3, HD-3's twin).
      if (write && !isPerson(originClass(meta))) throw Object.assign(new Error(`${tool} is sent to a Mac only for the person, not for a model or a module acting alone`), { code: "denied" });
      if (write && as !== "person") throw Object.assign(new Error(`${tool} is sent to a Mac only for the person`), { code: "denied" });
      const callOp = CALL.includes(tool);
      if (!write && !callOp && !allow.includes(tool)) throw Object.assign(new Error(`${tool} is not asked of a Mac through the link; run it on the Mac itself`), { code: "denied" });
      // A learned website operation: a read is asked as it is; an outward one only from the connectors module, which has the kernel's approval for exactly that call, and it is signed below.
      if (callOp && input && input.approved === true && !(meta && meta.caller === "module:connectors")) throw Object.assign(new Error(`${tool} runs an outward operation on a Mac only for the connectors module, with the person's approval`), { code: "denied" });
      // A learned operation that submits goes as chrome.op.send, always with the person's approval; chrome.op.call never carries one.
      if (tool === "chrome.op.send" && !(input && input.approved === true)) throw Object.assign(new Error("an operation that submits runs only with the person's approval; ask the person to approve it first"), { code: "denied" });
      if (tool === "chrome.op.call" && input && input.approved === true) throw Object.assign(new Error("this call runs a read only; an operation that submits is sent with the person's approval (chrome.op names the learned ones)"), { code: "denied" });
      // Vyre Computer asks a Mac to look, act or find files only through its own module; the Mac checks the person's allowlist again.
      if (tool === "computer.call" && !(meta && meta.caller === "module:computer")) throw Object.assign(new Error("a Mac is asked to work only by Vyre Computer; use computer.use to work on a computer"), { code: "denied" });
      // A send that resumes a stopped session headless takes longer than a read.
      const wait = Math.min(15_000, Math.max(100, Number(timeout) || (write ? 15_000 : 5000)));
      // "device" peers hold no link.serve loop for these tools (sync.upload.* is all they run) —
      // they never appear in a read or a write forwarded this way (e2e, session-import review).
      let macs = /** @type {any[]} */ (db.prepare("SELECT id, name, stable_id FROM link_peers WHERE kind = 'mac' ORDER BY paired_at").all());
      if (only) macs = macs.filter(m => m.id === only || m.name === only);
      // An answer goes to the one Mac the ask is on: the one whose ask.raised the box heard, or the
      // one `mac` names (after a box restart). Never to every Mac.
      const answer = tool === "threads.answer";
      const known = answer && input && typeof input.ask === "string" ? macAsks.get(input.ask) : undefined;
      if (answer) macs = only ? macs : known ? macs.filter(m => m.id === known.mac) : [];
      const thread = write && input && typeof input.thread === "string" ? input.thread : null;
      const answers = await Promise.all(macs.map(m => new Promise(resolve => {
        const who = { mac: m.id, name: m.name };
        if (!online(m.id)) return resolve({ ...who, ok: false, error: { code: "mac_offline", message: `the Mac "${m.name}" is offline` } });
        // The Mac may send this thread's events back from now on (link.events).
        if (thread) {
          sweepForwarded();
          if (!forwarded.has(thread)) forwarded.set(thread, new Map());
          /** @type {Map<string, number>} */ (forwarded.get(thread)).set(m.id, now());
        }
        const id = crypto.randomUUID();
        const timer = setTimeout(() => a.done({ ok: false, error: { code: "timeout", message: `the Mac "${m.name}" did not answer in time` } }), wait);
        timer.unref();
        // The person's answer, signed for this Mac alone: its node, the ask, the exact input.
        let assertion;
        if (callOp && tool === "chrome.op.send" && input && input.approved === true) {
          if (!m.stable_id) { clearTimeout(timer); return resolve({ ...who, ok: false, error: { code: "denied", message: `the Mac "${m.name}" paired without its node known; pair it again to run an outward operation there` } }); }
          assertion = signCall(assertKey().privateKey, { mac: m.stable_id, call: { site: String(input.site), name: String(input.name), inputs: input.inputs }, caller: String((meta && meta.caller) || "unknown"), now: now() });
        }
        if (answer) {
          if (!m.stable_id) { clearTimeout(timer); return resolve({ ...who, ok: false, error: { code: "denied", message: `the Mac "${m.name}" paired without its node known; pair it again to answer its asks here` } }); }
          assertion = signAnswer(assertKey().privateKey, { mac: m.stable_id, ask: String(input.ask), thread: known && known.mac === m.id ? known.thread : null, input,
            caller: String((by && by.caller) || "unknown"), device: by && by.device ? String(by.device) : null,
            person: by && by.person ? String(by.person) : null, presence: by && by.presence ? String(by.presence) : null, now: now() });
        }
        const a = { id, mac: m.id, tool, input, ...(write ? { as: "person" } : {}), ...(assertion ? { assertion } : {}), sent: false, done: r => {
          if (!asks.delete(id)) return;
          clearTimeout(timer);
          const queue = queues.get(m.id);
          if (queue && queue.includes(id)) queue.splice(queue.indexOf(id), 1);
          resolve({ ...who, ...r });
        } };
        asks.set(id, a);
        if (!queues.has(m.id)) queues.set(m.id, []);
        /** @type {string[]} */ (queues.get(m.id)).push(id);
        // A Mac holding a request gets the question now; otherwise it is waiting in the queue for its next serve.
        if (waiting.has(m.id)) release(m.id, next(m.id));
      })));
      // A Mac that refused the send (it has no such thread) sends nothing back for it.
      if (thread) {
        const macsOf = forwarded.get(thread);
        for (const a of answers) if (macsOf && !a.ok && a.error && a.error.code !== "timeout") macsOf.delete(a.mac);
        if (macsOf && !macsOf.size) forwarded.delete(thread);
      }
      return answers;
    },
  });

  /** Remember which Mac an open ask is on, and forget it when it ends. Bounded by count and age. */
  const noteAsk = (type, ask, macId, thread) => {
    if (type !== "ask.raised") { macAsks.delete(ask); return; }
    const old = now() - ASK_AGE;
    for (const [k, v] of macAsks) if (v.at < old) macAsks.delete(k);
    while (macAsks.size >= MAX_ASKS) macAsks.delete(/** @type {string} */ (macAsks.keys().next().value));
    macAsks.set(ask, { mac: macId, thread, at: now() });
  };

  ctx.tool("link.events", {
    effect: "write", callers: BOX_PEOPLE,
    description: "A paired Mac sends the events of a thread the box sent to, and of every ask it raises: { key, events: [{ type, thread, project, at, payload }] }. The box re-emits each, labelled with the Mac.",
    input: { type: "object", properties: { key: { type: "string" }, events: { type: "array", items: { type: "object" } } }, required: ["key", "events"] },
    run: async ({ key, events }, meta) => {
      const row = byKey(key, meta);
      if (!row) return { paired: false };
      sweepForwarded();
      let taken = 0;
      for (const e of events.slice(0, BATCH)) {
        const thread = e && typeof e.thread === "string" ? e.thread : null;
        // A thread's events: only the listed types, only for a thread the box sent to lately, only
        // from that Mac. An ask's: from any of the Mac's threads, so the person sees every ask.
        const ask = ASKS.includes(e.type);
        if (!thread || !(ask || (FOLLOWED.includes(e.type) && forwarded.get(thread)?.has(row.id)))) continue;
        const payload = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {};
        if (ask && typeof payload.ask !== "string") continue;
        // The project slug is the Mac's, not the box's: it is not filed under a box project.
        try { ctx.events.emit(e.type, { ...payload, source: "mac", machine: row.name, node: row.stable_id || null }, { thread, project: null }); taken++; }
        catch { continue; } // one that looks like a secret, or is not an event, is dropped alone
        if (ask) noteAsk(e.type, payload.ask, row.id, thread);
      }
      return { ok: true, taken };
    },
  });

  ctx.tool("link.macs", {
    effect: "read", callers: [...BOX_PEOPLE, "module"],
    description: "The paired Macs and whether each is online for the box to read now.",
    input: { type: "object", properties: {} },
    // stableId: the Mac's node id, for a module that needs to
    // find it among the box's own peers (files.deliver, ADR 0021's "Mac and box as one").
    // node is the paired name shown to surfaces; stableId is never shown, only matched against.
    // "device" peers are not Macs (no live reads, no file delivery): left out here, same as macs.call.
    run: async () => /** @type {any[]} */ (db.prepare("SELECT id, name, node, stable_id FROM link_peers WHERE kind = 'mac' ORDER BY paired_at").all()).map(m => ({
      mac: m.id, name: m.name, node: m.node || null, stableId: m.stable_id || null,
      online: waiting.has(m.id) || (lastServe.get(m.id) ?? -Infinity) >= now() - hold - 5000,
      lastServe: lastServe.get(m.id) ?? null })),
  });

  // A peer identified only by its own tailnet node (never a claimed name), for the sync module
  // (core/sync), which owns the upload protocol itself but not pairing or capability. Internal:
  // modules only.
  ctx.tool("link.peer-of", {
    description: "The paired peer this stableId is, or null: { id, name, kind }. Internal.",
    input: { type: "object", required: ["stableId"], properties: { stableId: { type: "string" } } },
    internal: true,
    run: async ({ stableId }) => {
      const row = /** @type {any} */ (db.prepare("SELECT id, name, kind FROM link_peers WHERE stable_id = ?").get(String(stableId)));
      return row ? { id: row.id, name: row.name, kind: row.kind } : null;
    },
  });

  const companion = companionSide(ctx, { db, now, box: () => ({ pub: assertKey().publicKey, name: ctx.config.name || null }), deviceInfo: async id => { const r = /** @type {any} */ (await ctx.call("relay.device.info", { id })); return r && r.data ? r.data : null; } });

  return {
    async stop() {
      companion.stop();
      pending.clear(); forwarded.clear(); macAsks.clear();
      for (const id of [...waiting.keys()]) release(id, null);
      for (const a of [...asks.values()]) a.done({ ok: false, error: { code: "stopped", message: "the box is stopping" } });
    },
  };
}
