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

import crypto from "node:crypto";
import { createHealth, unknown } from "./health.js";

const TTL = 10 * 60_000;
const MAX_PENDING = 5;
const MAX_WRONG = 5;

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
 * @param {{ now?: () => number, health?: { check: (which: any) => Promise<any> } }} [opts]
 */
export function boxSide(ctx, { now = Date.now, health = createHealth() } = {}) {
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
  const mayDecide = (p, meta) => {
    if (SOCKET.has(String(meta.caller))) return true;
    if (!tailnetLogin(meta.caller)) return false;
    const peer = peerOf(meta);
    // Without knowing which node is asking, a tailnet caller could be the Mac approving itself.
    return Boolean(peer && peer.stableId && p.peer && p.peer.stableId && peer.stableId !== p.peer.stableId);
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
      if (!mayDecide(p, meta)) throw new Error("approve on the box itself, or from another of your devices; a Mac cannot approve its own pairing");
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
      ctx.events.emit("link.unpaired", { peer: /** @type {any} */ (row).id, name: /** @type {any} */ (row).name });
      return { unpaired: /** @type {any} */ (row).id };
    },
  });

  ctx.tool("link.status", {
    description: "This box's side of the link: its paired Macs and waiting requests.",
    input: { type: "object", properties: {} },
    run: async () => { sweep(); return { role: "box", peers: db.prepare("SELECT COUNT(*) AS n FROM link_peers").get().n, pending: [...pending.values()].filter(p => !p.key && !p.denied).length }; },
  });

  return { async stop() { pending.clear(); } };
}
