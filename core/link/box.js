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

import crypto from "node:crypto";
import { createHealth, unknown } from "./health.js";
import { ALLOW } from "./allow.js";

const TTL = 10 * 60_000;
const MAX_PENDING = 5;
const MAX_WRONG = 5;
/** How long link.serve holds a Mac's request open when there is nothing to ask. */
const HOLD = 60_000;
/** A Mac with no request held and none in this long is offline: link.macs.call does not wait for it. */
const FRESH = 3000;

const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/** A code the owner can read and type: six digits, shown as 123-456. */
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const cleanCode = c => String(c || "").replace(/\D/g, "");
export const showCode = c => `${c.slice(0, 3)}-${c.slice(3)}`;

/** Callers of the box's own socket: its terminal. Claude's processes are here too, which is why the code matters. */
const SOCKET = new Set(["cli", "local"]);
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
export function boxSide(ctx, { now = Date.now, hold = HOLD, allow = ALLOW, health = createHealth() } = {}) {
  const db = ctx.store.db;
  ctx.store.migrate([
    `CREATE TABLE link_peers (id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT, node TEXT, stable_id TEXT,
       key_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER)`,
  ]);
  const pepper = crypto.randomBytes(32);
  const mac = s => crypto.createHmac("sha256", pepper).update(String(s)).digest();
  /** @type {Map<string, { id: string, name: string, login: string, peer: any, code: Buffer, secret: Buffer, expires: number, key?: string, peerId?: string, denied?: boolean }>} */
  const pending = new Map();
  let wrong = 0;

  const sweep = () => { for (const [id, p] of pending) if (p.expires < now()) pending.delete(id); };
  const peerOf = meta => (meta && meta.peer) || null;

  ctx.tool("link.pair.request", {
    description: "Start pairing a Mac with this box. Called by the Mac's vyred over the tailnet; the code it returns is shown on the Mac only.",
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run: async ({ name }, meta) => {
      const login = tailnetLogin(meta.caller);
      if (!login) throw new Error("pairing starts from the Mac, over the tailnet");
      sweep();
      if (pending.size >= MAX_PENDING) throw new Error("too many pairing requests are waiting; approve or deny them on the box first");
      const id = crypto.randomUUID(), code = newCode(), secret = crypto.randomBytes(32).toString("base64url");
      const peer = peerOf(meta);
      pending.set(id, { id, name: String(name).slice(0, 80), login, peer, code: mac(code), secret: mac(secret), expires: now() + TTL });
      ctx.events.emit("link.pair-requested", { id, name: String(name).slice(0, 80), login, expires: now() + TTL });
      return { id, code: showCode(code), secret, expires: now() + TTL, box: { name: ctx.config.name || null } };
    },
  });

  ctx.tool("link.pending", {
    description: "Pairing requests waiting for approval on this box. The codes are never listed: they are on the Mac's screen.",
    input: { type: "object", properties: {} },
    run: async () => { sweep(); return [...pending.values()].filter(p => !p.key && !p.denied).map(p => ({ id: p.id, name: p.name, login: p.login, node: p.peer ? p.peer.node : null, expires: p.expires })); },
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
      db.prepare("INSERT INTO link_peers (id, name, login, node, stable_id, key_hash, paired_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, p.name, p.login, p.peer ? p.peer.node || null : null, p.peer ? p.peer.stableId || null : null, sha(key), now());
      Object.assign(p, { key, peerId: id, expires: now() + 60_000 });
      ctx.events.emit("link.paired", { peer: id, name: p.name, login: p.login });
      return { peer: id, name: p.name };
    },
  });

  ctx.tool("link.pair.deny", {
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
      return { state: "approved", key: p.key, peer: p.peerId, box: { name: ctx.config.name || null } };
    },
  });

  /** The paired Mac this key belongs to, checked against the calling node when known. */
  const byKey = (key, meta) => {
    const row = /** @type {any} */ (db.prepare("SELECT * FROM link_peers WHERE key_hash = ?").get(sha(String(key || ""))));
    if (!row || !tailnetLogin(meta.caller)) return null;
    const peer = peerOf(meta);
    if (row.stable_id && peer && peer.stableId !== row.stable_id) return null;
    return row;
  };

  ctx.tool("link.hello", {
    description: "A paired Mac checks in. Answers who this box is, or unpaired when the key is not known here.",
    input: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    run: async ({ key }, meta) => {
      const row = byKey(key, meta);
      if (!row) return { paired: false };
      db.prepare("UPDATE link_peers SET last_seen = ? WHERE id = ?").run(now(), row.id);
      return { paired: true, peer: row.id, box: { name: ctx.config.name || null, role: ctx.config.role } };
    },
  });

  ctx.tool("link.peers", {
    description: "The Macs paired with this box.",
    input: { type: "object", properties: {} },
    run: async () => db.prepare("SELECT id, name, login, node, stable_id, paired_at, last_seen FROM link_peers ORDER BY paired_at").all(),
  });

  ctx.tool("link.health", {
    description: "How this box reaches a node right now: direct or relayed, latency, last handshake. By default the calling device; node: a paired Mac's node id. Checked at most once a minute per node.",
    input: { type: "object", properties: { node: { type: "string" } } },
    run: async ({ node }, meta) => {
      const own = peerOf(meta);
      const asked = node ? String(node) : own && own.stableId ? String(own.stableId) : null;
      if (!asked) return unknown("say which node: a paired Mac's node id (vyre link peers)", now());
      // Any caller may ask about itself or a paired Mac. A module may name any node: Glass asks
      // about the viewer the tailnet listener identified, which may be a phone rather than a Mac.
      const mayName = String(meta.caller).startsWith("module:") || (own && own.stableId === asked)
        || db.prepare("SELECT 1 FROM link_peers WHERE stable_id = ?").get(asked);
      if (!mayName) throw new Error("that node is not a paired Mac");
      return health.check({ stableId: asked });
    },
  });

  ctx.tool("link.unpair", {
    description: "Forget a paired Mac. On the box, by id; from the Mac, with its own key.",
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
  /** @type {Map<string, { id: string, mac: string, tool: string, input: any, sent: boolean, done: (r: any) => void }>} */
  const asks = new Map();

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
      if (a) { a.sent = true; return { id: a.id, tool: a.tool, input: a.input }; }
    }
    return null;
  };
  /** A Mac was unpaired: let go of its held request and fail what was waiting on it. */
  const forget = macId => {
    release(macId, null);
    lastServe.delete(macId); queues.delete(macId);
    for (const a of [...asks.values()]) if (a.mac === macId) a.done({ ok: false, error: { code: "unpaired", message: "this Mac was unpaired" } });
  };
  // A Mac counts as there when it holds a request, asked within FRESH, or is working on a question
  // right now (it answers one at a time, so a slow search must not make it look gone).
  const online = macId => waiting.has(macId) || (lastServe.get(macId) ?? -Infinity) >= now() - FRESH
    || [...asks.values()].some(a => a.mac === macId && a.sent);

  ctx.tool("link.serve", {
    description: "A paired Mac waits here for the box's next question. Answers { id, tool, input }, or null when there was none for a while.",
    input: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    run: async ({ key }, meta) => {
      const row = byKey(key, meta);
      if (!row) return { paired: false };
      lastServe.set(row.id, now());
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
    description: "Ask every paired Mac for one of its read tools. Answers [{ mac, name, ok, data?, error? }], one per Mac.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" }, timeout: { type: "number" } }, required: ["tool"] },
    internal: true,
    run: async ({ tool, input = {}, timeout = 5000 }) => {
      if (!allow.includes(tool)) throw Object.assign(new Error(`${tool} is not asked of a Mac through the link`), { code: "denied" });
      const wait = Math.min(15_000, Math.max(100, Number(timeout) || 5000));
      const macs = /** @type {any[]} */ (db.prepare("SELECT id, name FROM link_peers ORDER BY paired_at").all());
      return Promise.all(macs.map(m => new Promise(resolve => {
        const who = { mac: m.id, name: m.name };
        if (!online(m.id)) return resolve({ ...who, ok: false, error: { code: "mac_offline", message: `the Mac "${m.name}" is offline` } });
        const id = crypto.randomUUID();
        const timer = setTimeout(() => a.done({ ok: false, error: { code: "timeout", message: `the Mac "${m.name}" did not answer in time` } }), wait);
        timer.unref();
        const a = { id, mac: m.id, tool, input, sent: false, done: r => {
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
    },
  });

  ctx.tool("link.macs", {
    description: "The paired Macs and whether each is online for the box to read now.",
    input: { type: "object", properties: {} },
    run: async () => /** @type {any[]} */ (db.prepare("SELECT id, name, node FROM link_peers ORDER BY paired_at").all()).map(m => ({
      mac: m.id, name: m.name, node: m.node || null,
      online: waiting.has(m.id) || (lastServe.get(m.id) ?? -Infinity) >= now() - hold - 5000,
      lastServe: lastServe.get(m.id) ?? null })),
  });

  return {
    async stop() {
      pending.clear();
      for (const id of [...waiting.keys()]) release(id, null);
      for (const a of [...asks.values()]) a.done({ ok: false, error: { code: "stopped", message: "the box is stopping" } });
    },
  };
}
