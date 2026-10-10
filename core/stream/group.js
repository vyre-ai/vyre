// @ts-check
// group: the server side of a group chat on the stream (ADR 0052). One group is one session log;
// each assistant in it has its own switchboard thread, and that thread's frames are projected into
// the group's log with the assistant as `author` and the asker as `acts_for`.
//
// With the kernel on (ctx.kernel), the chat is the kernel's (task N): the people and assistants of a chat are the kernel's list, mirrored INTO this
// group (never the other way; a call cannot add one); every message is written through chats.append(token, message) under a token that carries the
// chat from birth (surfaces.open with { chat }): a person's words under that person's own token, an assistant's reply under a token for that
// assistant, opened from the asker's chain. The kernel's append comes BEFORE the stream stores or sends a word, so a reply the kernel refuses is
// shown nowhere (not a delta, not a frame). Without ctx.kernel (a 0.2 daemon) the old paths run, kept apart below (project0, and the kernelOn()
// branches in send).
//
// A reply STREAMS (task O). The first delta opens it through the reply port (openReply, see reply-port.js; the kernel's chats.appendOpen when it lands), which stamps it
// with the chat's membership version; each delta is a frame stamped `data.ver`, and a viewer receives it only if the port says they were in the chat at that version
// (viewerFor().may), so someone who joins mid-reply gets none of it and sees the chat from their join cursor (floor). Nothing is held and nothing is re-run.
//
// Tools (reach person): stream.send, stream.react, stream.pin, stream.keep, stream.mark-read.
//
// A person's message is appended first (author from the caller), then routing.js whoAnswers picks
// who answers, and each answering assistant gets the words through threads.send (threads.start the
// first time) with a uuid made from the message and the assistant, so a delivery is handed over
// once. The delivery is written to an outbox row BEFORE the tool returns and marked done after the
// switchboard took it: a restart re-delivers what was not taken. Each thread's last projected event
// id is stored, and a start catches every thread up from it, so nothing a thread said while this
// module was down is lost (a hard crash may repeat the last 100 ms of one thread; a stop is exact).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "../store/index.js";
import { createAdapter } from "./adapter.js";
import { whoAnswers, mentionedIn } from "./routing.js";
import { validEnc } from "./protocol.js";
import { createReadMarkers } from "./readmarks.js";
import { cutNote } from "./reply-port.js";
import { presenceFor } from "./presence.js";
import { createSendContext } from "./context.js";
import { validZone, zoneFrom } from "../../lib/time/index.js";

const MIGRATIONS = [`
  CREATE TABLE stream_groups_members (
    grp TEXT NOT NULL, who TEXT NOT NULL, thread TEXT, cwd TEXT, name TEXT, asker TEXT, answer TEXT,
    last_event INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (grp, who)
  );
  CREATE TABLE stream_groups_outbox (
    uuid TEXT PRIMARY KEY, grp TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL, asker TEXT NOT NULL,
    answer TEXT NOT NULL, surface TEXT, done INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE stream_groups_marks (
    person TEXT NOT NULL, session TEXT NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY (person, session)
  );`,
// One Chat: a member that is a run started outside the stream (kind 'run') is kept whatever the kernel's list of assistants says: it is the run's slot, not an agent somebody added.
`ALTER TABLE stream_groups_members ADD COLUMN kind TEXT;`,
// A message sent while a turn works is steered into it at its next step by default; `queue` waits for the turn to end (and can be taken back).
`ALTER TABLE stream_groups_outbox ADD COLUMN mode TEXT;`,
// The sending device's IANA time zone, handed to the run with the words.
`ALTER TABLE stream_groups_outbox ADD COLUMN tz TEXT;`,
// Images a message carries (JSON), handed to the assistant's thread with the words.
`ALTER TABLE stream_groups_outbox ADD COLUMN images TEXT;`];

const EVENTS = /^(thread\.|ask\.)/;
/** Frames a group takes from an assistant's thread: its words, tools, asks and files (not the person's message, which the group has, and not the thread's own state). */
const SKIP = new Set(["user-message", "status", "term-command", "term-chunk"]);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });
/** A uuid from a string, the same every time. @param {string} s */
function uuidOf(s) {
  const b = crypto.createHash("sha1").update(`vyre-stream-group\n${s}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Does a frame's data hold a `field` block that carries a value (not a placeholder)? @param {any} d */
function carriesFieldValue(d) {
  if (!d || typeof d !== "object") return false;
  const one = (/** @type {any} */ b) => b && typeof b === "object" && b.block === "field" && b.placeholder !== true;
  return one(d) || one(d.result) || one(d.block) || (Array.isArray(d.blocks) && d.blocks.some(one));
}
const RESUME_NOTE = "couldn't resume, ask again";
const shortOf = (/** @type {string} */ id) => id.slice(id.indexOf(":") + 1);
const botId = (/** @type {string} */ id) => id.startsWith("assistant:") || id.startsWith("model:");

/**
 * @typedef {{ who: string, name: string, kind?: string|null, doing?: boolean, step?: { id: string, kinds: Map<string, number>, tools: number, failed: number } | null, stepNo?: number, thread: string|null, cwd: string|null, asker: string|null, answer: string|null, last: number,
 *   ad: ReturnType<typeof createAdapter>, msgs: Map<string, string>, held: any[]|null, q: Promise<any>, grp: string,
 *   tokens?: Map<string, { token: string, exp: number }>, tokenWaiters?: { asker: string|null, res: (t: any) => void, timer?: any }[], dead?: boolean, running?: boolean, queuedTurns?: Map<number, { asker: string, answer: string, grp: string, message: string, text: string }>, pq?: Promise<any>, buf?: Map<string, any>, refused?: Set<string>, turnAt?: number|null }} Member
 * @typedef {{ people: Set<string>, bots: Map<string, Member>, names: Map<string, string>, dflt: string|null, previous: string|null, spans: Map<string, { from: number, to: number|null }[]> }} Group
 */

/** @typedef {{ forThread(thread: string): { appendOpen(m?: any): Promise<any>, append(m: any): Promise<any>, beginTurn?(): Promise<any> }, reopenPending(o: { timeoutMs?: number, onGiveUp?: (thread: string, why: string) => any }): Promise<{ resumed: string[], gaveUp: string[] }> }} KernelThreads */

/**
 * @param {{ ctx: any, logs: import("./log.js").Logs, db: any, now?: () => number, replyPort?: import("./reply-port.js").ReplyPort, standIn?: boolean, timers?: { set: (fn: () => void, ms: number) => any, clear: (t: any) => void },
 *   ks?: KernelThreads }} o
 *   ks: the kernel-session seam (lib/kernel-session.js, handed to the stream by the daemon as ctx.kernelThreads, or injected by a test): the assistant's kernel session is opened by vyred from the person's own send,
 *   and the stream only asks for calls on a thread's session (`forThread(thread)`), never a token. With it the stream opens no session of its own for an assistant; without it (a test with no daemon) the older path runs.
 */
export function createGroups({ ctx, logs, db, now = Date.now, replyPort, standIn = false, timers, ks: ksOpt }) {
  const setT = (timers && timers.set) || ((/** @type {() => void} */ fn, /** @type {number} */ ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearT = (timers && timers.clear) || ((/** @type {any} */ t) => clearTimeout(t));
  /** How long a reply waits for an assistant session after a restart (stream.resumeWaitSeconds, 60 by default). */
  const RESUME_MS = Math.max(1, Number(((ctx.config && ctx.config.stream) || {}).resumeWaitSeconds ?? 60)) * 1000;
  migrate(db, "stream-groups", MIGRATIONS);
  const markers = createReadMarkers();
  for (const r of db.prepare("SELECT person, session, upto FROM stream_groups_marks").all()) markers.set(String(r.person), String(r.session), Number(r.upto));
  /** @type {Map<string, Group>} */ const groups = new Map();
  /** @type {Map<string, Member>} */ const byThread = new Map();
  /** @type {Set<Member>} */ const dirty = new Set();
  /** @type {any} */ let timer = null;
  let stopped = false;
  const log = (/** @type {string} */ m) => { try { ctx.log(`stream: ${m}`); } catch {} };
  /** The kernel-session seam: handed by the daemon, injected by a test, or none. */
  const ks = /** @type {KernelThreads | null} */ (ksOpt || ctx.kernelThreads || null);
  /** @type {Promise<any> | null} the restart's reopening of the open turns, while it runs */ let reopening = null;
  const holdWho = () => process.env.VYRE_STREAM_TEST_HOLD || ""; // tests only: a delivery to this member waits for the next start

  const q = {
    members: db.prepare("SELECT * FROM stream_groups_members WHERE grp = ?"),
    allMembers: db.prepare("SELECT * FROM stream_groups_members"),
    upsert: db.prepare(`INSERT INTO stream_groups_members (grp, who, thread, cwd, name, asker, answer, last_event, kind) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(grp, who) DO UPDATE SET thread = excluded.thread, cwd = excluded.cwd, name = excluded.name, asker = excluded.asker, answer = excluded.answer, kind = excluded.kind`),
    last: db.prepare("UPDATE stream_groups_members SET last_event = ? WHERE grp = ? AND who = ?"),
    outAdd: db.prepare("INSERT OR IGNORE INTO stream_groups_outbox (uuid, grp, who, text, asker, answer, surface, mode, tz, images) VALUES (?,?,?,?,?,?,?,?,?,?)"),
    outDone: db.prepare("UPDATE stream_groups_outbox SET done = 1 WHERE uuid = ?"),
    outOpen: db.prepare("SELECT * FROM stream_groups_outbox WHERE done = 0 ORDER BY rowid"),
    mark: db.prepare("INSERT INTO stream_groups_marks (person, session, upto) VALUES (?,?,?) ON CONFLICT(person, session) DO UPDATE SET upto = excluded.upto"),
  };

  /** @param {any} r @returns {Member} */
  const memberOf = r => ({ grp: String(r.grp), who: String(r.who), name: String(r.name || shortOf(String(r.who))), thread: r.thread ? String(r.thread) : null, cwd: r.cwd ? String(r.cwd) : null,
    asker: r.asker ? String(r.asker) : null, answer: r.answer ? String(r.answer) : null, kind: r.kind ? String(r.kind) : null, last: Number(r.last_event || 0), ad: createAdapter(), msgs: new Map(), held: null, q: Promise.resolve(), });
  const save = (/** @type {Member} */ m) => q.upsert.run(m.grp, m.who, m.thread, m.cwd, m.name, m.asker, m.answer, m.last, m.kind || null);

  // ---- the kernel's chat (ctx.kernel on): tokens with the chat in them, and chats.append ------------------

  /** Is this daemon running with the kernel? Then every chat is the kernel's and the 0.2 paths are closed. */
  const kernelOn = () => Boolean(ctx.kernel && ctx.kernel.chats && typeof ctx.kernel.chats.append === "function" && typeof ctx.kernel.for === "function");
  /** The daemon path: the assistant's kernel session is vyred's, reached through the seam (`ks`). */
  const viaKs = () => ks !== null && kernelOn();
  const TOKEN_MS = 24 * 3600_000;
  /** What a call's own chain gave mirror(): the person's chain (exactly one person) and who it is. @type {WeakMap<object, { chain: any, person: string }>} */
  const kcalls = new WeakMap();
  const sendContext = createSendContext({ kernel: ctx.kernel, call: ctx.call });
  /** @type {Map<string, { token: string, exp: number }>} one open session per (chat, person, assistant) */ const sessions = new Map();
  /**
   * A session token with the chat in it, opened by the kernel for the person acting (the chain of a call that carried their own token). `agent` makes it an
   * assistant's session for that person. The kernel checks the person is in the chat; the chat cannot be changed in the token afterwards.
   * @param {any} chain @param {string} grp @param {string} person @param {string} [agent]
   */
  async function sessionFor(chain, grp, person, agent) {
    const key = `${grp}|${person}|${agent || ""}`;
    const had = sessions.get(key);
    if (had && had.exp - 60_000 > now()) return had;
    const surfaces = ctx.kernel.for(ctx.kernel.space).surfaces;
    const o = await surfaces.open(chain, { chat: grp, ...(agent ? { agent } : {}), ttl_ms: TOKEN_MS });
    const t = { token: String(o.token), exp: Number(o.expires) };
    sessions.set(key, t);
    return t;
  }
  /** The only way a word lands in a chat: the destination is the token's chat. @param {string} token @param {any} body @param {string} [kind] */
  const append = (token, body, kind = "text") => ctx.kernel.chats.append(token, { kind, body });
  /**
   * A token for the member's turn: the one for the person it is answering, now, or when that person next acts (a restart forgets tokens). The wait has a
   * deadline (RESUME_MS): when it passes the answer is null and the caller drops the reply and says so in the room.
   * @param {Member} m
   */
  const tokenOf = m => {
    const t = m.asker ? (m.tokens || new Map()).get(m.asker) : null;
    return t && t.exp - 5000 > now() ? Promise.resolve(t) : new Promise(res => {
      /** @type {{ asker: string|null, res: (t: any) => void, timer?: any }} */ const w = { asker: m.asker, res };
      w.timer = setT(() => { m.tokenWaiters = (m.tokenWaiters || []).filter(x => x !== w); res(null); }, RESUME_MS);
      (m.tokenWaiters ||= []).push(w);
    });
  };
  /** @param {Member} m @param {string} asker @param {{ token: string, exp: number }} t */
  function giveToken(m, asker, t) {
    (m.tokens ||= new Map()).set(asker, t);
    const w = m.tokenWaiters || [];
    m.tokenWaiters = w.filter(x => x.asker !== asker);
    for (const x of w) if (x.asker === asker) { if (x.timer) clearT(x.timer); x.res(t); }
  }

  /** The kernel's list into this group, never the other way: whoever the kernel lists and the group lacks joins, whoever the group holds and the kernel no longer lists leaves. @param {string} grp @param {{ people: string[], assistants?: string[] }} chat */
  function adopt(grp, chat) {
    const g = group(grp);
    const wantPeople = new Set(chat.people.map(p => `person:${p}`));
    const wantBots = new Set((chat.assistants || []).map(a => `assistant:${a}`));
    for (const p of wantPeople) if (!g.people.has(p)) join(grp, p);
    for (const b of wantBots) if (!g.bots.has(b)) join(grp, b);
    for (const p of [...g.people]) if (!wantPeople.has(p)) { g.people.delete(p); g.names.delete(p); closeSpan(g, p, logs.get(grp).append("participant-left", { who: p }).cur); }
    for (const [b, m] of [...g.bots]) if (!wantBots.has(b) && m.kind !== "run") { g.bots.delete(b); g.names.delete(b); if (m.thread) byThread.delete(m.thread); m.tokens = new Map(); closeSpan(g, b, logs.get(grp).append("participant-left", { who: b }).cur); }
    if (g.dflt && !g.bots.has(g.dflt)) g.dflt = null;
    return g;
  }

  /** The kernel's list, read with the asker's own session, into this group (the stream's mirror: its roster, its join frames, a viewer's floor). A refusal is the reply's refusal. @param {string} grp @param {string} token */
  async function syncList(grp, token) {
    const k = ctx.kernel;
    const chat = await k.chats.read(await k.chain({ token }), grp);
    adopt(grp, { people: [...chat.people], assistants: [...(chat.assistants || [])] });
  }

  /**
   * The kernel's own reply port: chats.appendOpen (stamps the reply with the room's membership version, checks the token and the person at every write) and
   * chats.mayReceive (sync: was the viewer in the room at that version and is in it now). The only place the stream asks the kernel about delivery.
   * @type {import("./reply-port.js").ReplyPort}
   */
  const kernelPort = {
    open: async ({ token }) => {
      const h = await ctx.kernel.chats.appendOpen(token, { kind: "text" });
      return { id: String(h.id), ver: Number(h.ver), write: d => h.write(d), close: f => h.close(f).then(() => {}) };
    },
    mayReceive: (_grp, _person, r, chain) => { try { return ctx.kernel.chats.mayReceive(chain, r.kid) === true; } catch { return false; } },
  };

  /**
   * The stand-in port, for a kernel that has no appendOpen (see reply-port.js): the stamp is the group log's cursor, the list is the kernel's as read when the reply
   * opens and now and then while it streams (`follow`), and the whole text goes to chats.append when it closes. A participant was in the chat at a cursor when a
   * joined frame is at or before it and no left frame is.
   * @type {import("./reply-port.js").ReplyPort}
   */
  const mirrorPort = {
    follow: true,
    open: async ({ grp, token }) => ({ id: `r-${crypto.randomUUID()}`, ver: logs.get(grp).head, write: () => {}, close: final => append(token, { text: final.text, ...(final.blocks && final.blocks.length ? { blocks: final.blocks } : {}) }).then(() => {}) }),
    mayReceive: (grp, person, r) => { const g = group(grp); return inAt(g, person, r.ver) && inAt(g, person, r.cur); },
  };
  /** A kernel that holds chats but cannot stream or gate a reply: refuse, never fall back to the mirror (the mirror is for a daemon with no kernel at all). */
  const unavailablePort = {
    follow: false,
    open: async () => { throw Object.assign(new Error("this kernel's chats cannot stream or gate a reply (appendOpen and mayReceive are missing)"), { code: "unavailable" }); },
    mayReceive: () => false,
  };
  /**
   * The seam's reply port (the daemon path): the reply is opened through `ks.forThread(thread).appendOpen`, so the stream never holds the thread's token. Delivery is asked of the
   * kernel the same way as the kernel port's. A thread with no session is `no_session`.
   * @type {import("./reply-port.js").ReplyPort}
   */
  const ksPort = {
    open: async ({ thread, asker }) => {
      if (!ks || !thread) throw Object.assign(new Error("this reply has no session of its own"), { code: "no_session" });
      // the reply is written under the session of the person whose turn it is, never the thread's newest (a later asker's turn may have opened already): the seam finds that person's own
      const h = await ks.forThread(thread).appendOpen({ kind: "text", ...(asker ? { asker } : {}) });
      return { id: String(h.id), ver: Number(h.ver), write: d => h.write(d), close: f => h.close(f).then(() => {}) };
    },
    mayReceive: (_grp, _person, r, chain) => { try { return ctx.kernel.chats.mayReceive(chain, r.kid) === true; } catch { return false; } },
  };
  const kernelChats = ctx.kernel && ctx.kernel.chats;
  const port = replyPort || (ks && kernelChats && typeof kernelChats.mayReceive === "function" ? ksPort : null) || (standIn || !kernelChats ? mirrorPort : (typeof kernelChats.appendOpen === "function" && typeof kernelChats.mayReceive === "function" ? kernelPort : unavailablePort));
  /** How often a reply on the stand-in port reads the kernel's list again while it streams (a kernel port follows the room itself). */
  const SYNC_MS = 500;
  /** The group log's cursor now: what a tool frame or a held thought is stamped with (`data.at`), asked of the group's own list. @param {string} grp */
  const cursor = grp => logs.get(grp).head;

  /** The group's state, read from its log (who is in, who spoke last) and the member table (threads). @param {string} grp */
  function group(grp) {
    let g = groups.get(grp);
    if (g) return g;
    g = { people: new Set(), bots: new Map(), names: new Map(), dflt: null, previous: null, spans: new Map() };
    groups.set(grp, g);
    for (const r of q.members.all(grp)) { const m = memberOf(r); g.bots.set(m.who, m); g.names.set(m.who, m.name); if (m.thread) byThread.set(m.thread, m); }
    for (const f of logs.get(grp).read(0)) {
      const d = f.data || {};
      if (f.type === "chat.participant-joined") {
        if (d.name) g.names.set(d.who, d.name);
        if (d.who.startsWith("person:")) g.people.add(d.who);
        if (d.role === "default") g.dflt = d.who;
        openSpan(g, d.who, f.cur);
      } else if (f.type === "chat.participant-left") { g.people.delete(d.who); g.bots.delete(d.who); closeSpan(g, d.who, f.cur); }
      if (f.author && (f.type === "chat.user-message" || f.type === "chat.text-delta")) g.previous = f.author;
    }
    return g;
  }
  /** The cursors a participant was in the chat for: from their joined frame to their left frame (open while they are in). @param {Group} g @param {string} who @param {number} cur */
  function openSpan(g, who, cur) {
    const l = g.spans.get(who) || [];
    if (!l.length || l[l.length - 1].to !== null) l.push({ from: cur, to: null });
    g.spans.set(who, l);
  }
  /** @param {Group} g @param {string} who @param {number} cur */
  function closeSpan(g, who, cur) { const l = g.spans.get(who); if (l && l.length && l[l.length - 1].to === null) l[l.length - 1].to = cur; }
  /** Was this participant in the chat at cursor `c` of the group's log? @param {Group} g @param {string} who @param {number} c */
  const inAt = (g, who, c) => (g.spans.get(who) || []).some(x => x.from <= c && (x.to === null || c < x.to));
  /** @param {Group} g */
  const participants = g => [...g.people, ...g.bots.keys()].map(id => ({ id, ...(g.names.get(id) ? { name: g.names.get(id) } : {}) }));

  /** Add someone to the group once: a participant-joined frame, and for an assistant its row. @param {string} grp @param {string} who @param {{ name?: string, cwd?: string, role?: string }} [o] */
  function join(grp, who, o = {}) {
    const g = group(grp);
    if (g.people.has(who) || g.bots.has(who)) {
      const m = g.bots.get(who);
      if (m && o.cwd && !m.cwd) { m.cwd = o.cwd; save(m); }
      return;
    }
    const name = o.name || shortOf(who);
    g.names.set(who, name);
    if (who.startsWith("person:")) g.people.add(who);
    else {
      const m = memberOf({ grp, who, name, cwd: o.cwd || null });
      g.bots.set(who, m); save(m);
    }
    if (o.role === "default") g.dflt = who;
    const jf = logs.get(grp).append("participant-joined", { who, ...(o.role ? { role: o.role } : {}), ...(o.name ? { name: o.name } : {}) });
    openSpan(g, who, jf.cur);
  }

  /** The person a kernel-on call is from, set by mirror() from the caller's own chain (a call's meta object is the key). @type {WeakMap<object, string>} */
  const kernelPerson = new WeakMap();
  /** @param {any} meta @param {any} i the person a call is from: the kernel's chain when it spoke, else the verified peer, else a named one (local surfaces), else the owner */
  function personOf(meta, i) {
    const kp = meta && typeof meta === "object" ? kernelPerson.get(meta) : undefined;
    if (kp) return kp;
    const peer = meta && meta.peer;
    const raw = peer && (peer.login || peer.stableId || peer.node);
    if (raw) return `person:${String(raw).replace(/\s+/g, "-").slice(0, 120)}`;
    if (typeof i.as === "string" && /^person:[^\s]{1,120}$/.test(i.as)) return i.as;
    return "person:owner";
  }
  /** Only a person already in a group may speak in it, react, pin, keep or move a marker (a new group has no people yet: its first speaker founds it). @param {string} grp @param {string} who */
  const mustBeIn = (grp, who) => {
    if (!(groups.has(grp) || logs.known(grp))) return;
    const g = group(grp);
    if (g.people.size > 0 && !g.people.has(who)) throw fail("not_found", "no such session");
  };
  const sessionOf = (/** @type {any} */ i) => { const s = String(i.chat || ""); if (!ID.test(s)) throw fail("bad_input", "chat must be a chat id"); return s; };

  /**
   * What a reply quotes: the message it answers, read from this chat's own log (never from the caller), as { message, author, text }. A person's message gives its text; an assistant's gives what it said, whole
   * messages joined. The text is the first lines, cut to 140 characters. A private message (enc) cannot be quoted, and one the log no longer holds is refused: nothing is made up. @param {string} grp @param {string} id
   */
  function quoteOf(grp, id) {
    const fr = logs.get(grp).read(0);
    const mine = fr.filter(f => f.data && f.data.message === id && (f.type === "chat.user-message" || f.type === "chat.text-delta" || f.type === "chat.text-done"));
    if (!mine.length) throw fail("not_found", "that message is not in this chat");
    const first = mine.find(f => f.author) || mine[0];
    const um = mine.filter(f => f.type === "chat.user-message").pop();
    if (um && um.data.enc !== undefined) throw fail("bad_input", "a private message cannot be quoted");
    const text = um ? String(um.data.text || "") : mine.filter(f => f.type === "chat.text-delta" && !f.data.reasoning).map(f => String(f.data.text || "")).join("");
    const flat = text.replace(/\s+/g, " ").trim();
    return { message: id, author: String(first.author || ""), text: flat.length > 140 ? `${flat.slice(0, 139)}…` : flat };
  }

  // ---- run steps: the tool calls between two of an assistant's messages, one collapsible block --------------------------------------------------------------------------------------------

  const PLURAL = { shell: ["ran a command", "ran {n} commands"], read: ["read a file", "read {n} files"], edit: ["edited a file", "edited {n} files"], search: ["searched once", "searched {n} times"], web: ["opened a page", "opened {n} pages"], todo: ["updated the plan", "updated the plan {n} times"], agent: ["asked a helper", "asked {n} helpers"], mcp: ["used a connected tool", "used connected tools {n} times"], other: ["did a step", "did {n} steps"] };
  /** "Read 3 files, ran 2 commands": plain counts of what a step did, never invented. @param {Record<string, number>} kinds */
  function stepSummary(kinds) {
    const parts = Object.entries(kinds).map(([k, n]) => { const t = /** @type {any} */ (PLURAL)[k] || PLURAL.other; return n === 1 ? t[0] : t[1].replace("{n}", String(n)); });
    const text = parts.join(", ");
    return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 200) || "Worked";
  }
  /** The member's open step, made at its first tool call. @param {Member} m */
  function stepOf(m) {
    if (!m.step) { m.stepNo = (m.stepNo || 0) + 1; m.step = { id: `${m.who}#${m.stepNo}-${Date.now().toString(36)}`, kinds: new Map(), tools: 0, failed: 0 }; }
    return m.step;
  }
  /** The step ends (the assistant begins a message, or the turn ends): one `step-summary` frame, so a screen can fold the step's tool frames into it. @param {Member} m */
  function closeStep(m) {
    const st = m.step; m.step = null;
    if (!st || !st.tools) return;
    try { logs.get(m.grp).append("step-summary", { step: st.id, count: st.tools, kinds: Object.fromEntries(st.kinds), summary: stepSummary(Object.fromEntries(st.kinds)), ok: st.failed === 0 }, { turn: null, author: m.who, ...(m.asker ? { acts_for: m.asker } : {}) }); }
    catch (err) { log(`step summary for ${m.who} in ${m.grp}: ${/** @type {Error} */ (err).message}`); }
  }

  // ---- live presence: who is typing, and what an assistant is doing (ephemeral frames, never logged or replayed) ----------------------------------------------------------------------

  /** @type {Map<string, ReturnType<typeof presenceFor>>} */ const presences = new Map();
  const presenceOf = (/** @type {string} */ grp) => { let p = presences.get(grp); if (!p) { p = presenceFor(logs.get(grp), now, 1000); presences.set(grp, p); } return p; };
  /** What a member is doing now, in a few words ("Read src/intake.ts"): one line per author, at most once a second. @param {Member} m @param {string} what */
  function doing(m, what) { try { m.doing = true; presenceOf(m.grp).set(m.who, "doing", String(what || "").replace(/\s+/g, " ").slice(0, 120) || undefined); } catch { /* a notice, never a stop */ } }
  /** The member is not doing anything now: the line clears at once. @param {Member} m */
  function idle(m) { if (!m.doing) return; m.doing = false; try { presenceOf(m.grp).clear(m.who); logs.get(m.grp).emit("presence", { who: m.who, state: "idle" }, { author: m.who }); } catch { /* a notice, never a stop */ } }

  // ---- projection: a thread's events into the group's log ---------------------------------------

  /**
   * A thread's event into the group's log. 0.2 (no kernel): written straight away (project0). Kernel on: every word of a reply goes through
   * chats.append first (projectKernel), one at a time per assistant so the order holds, and a refused reply is never shown.
   * @param {Member} m @param {any} e
   */
  function project(m, e) {
    const id = Number(e.id);
    if (!(id > m.last)) return;
    m.last = id;
    let specs = [];
    try { specs = m.ad.event(e); } catch (err) { log(`${e.type} for ${m.thread}: ${/** @type {Error} */ (err).message}`); }
    const p = e.payload || {};
    if (e.type === "thread.sent" && p.via === "turn" && p.queued != null && m.queuedTurns && m.queuedTurns.has(Number(p.queued))) specs = [{ kind: "turn-start", queued: Number(p.queued), data: {} }, ...specs];
    if (kernelOn()) projectKernel(m, specs); else project0(m, specs);
    dirty.add(m);
    if (!timer && !stopped) { timer = setTimeout(flush, 100); timer.unref?.(); }
  }

  /** The id a reply's words go under in the group: the asker's answer id, `<answer>.<n>` for later messages of the same turn. @param {Member} m @param {string} raw */
  function answerId(m, raw) {
    if (!m.msgs.has(raw)) m.msgs.set(raw, m.msgs.size === 0 ? /** @type {string} */ (m.answer) : `${m.answer}.${m.msgs.size}`);
    return /** @type {string} */ (m.msgs.get(raw));
  }

  /** One frame into the group's log with the assistant as author. @param {Member} m @param {any} s @param {any} data @param {string} [message] */
  function write(m, s, data, message) {
    try { logs.get(m.grp).append(s.kind, data, { turn: s.turn ? `${m.name}/${s.turn}` : null, author: m.who, ...(m.asker ? { acts_for: m.asker } : {}), ...(message ? { message } : {}) }); }
    catch (err) { log(`${s.kind} for ${m.who} in ${m.grp}: ${/** @type {Error} */ (err).message}`); }
  }

  // ---- 0.2, no kernel: kept apart ------------------------------------------------------------------

  /** The specs of a thread event written straight into the group's log. @param {Member} m @param {any[]} specs */
  function project0(m, specs) {
    const room = group(m.grp).people.size > 1;
    for (const s of specs) {
      if (SKIP.has(s.kind)) continue;
      // In a room of more than one person an assistant's reply never carries a field value (it is the same words for everyone): a field is cited as a field-ref block, drawn per viewer.
      if (room && carriesFieldValue(s.data)) { log(`${s.kind} for ${m.who} in ${m.grp}: dropped, it carried a field value (cite it as a field-ref)`); continue; }
      let data = s.data, message;
      if ((s.kind === "text-delta" || s.kind === "text-done") && m.answer) { message = answerId(m, String(data.message)); data = { ...data, message }; }
      write(m, s, room ? withNote(m.grp, data) : data, message);
    }
  }

  // ---- kernel on: a reply is written once the kernel took it -----------------------------------------

  /** The key of a turn's own handle, for what is not a message (tools, asks, files, status with content). */
  const ACT = "~turn";
  /** What a block shown in a room says under itself (the line the app draws quietly under a terminal, a diff or files). */
  const ROOM_NOTE = "visible to everyone in this chat";
  const NOTED = new Set(["terminal", "diff", "files"]);
  /** A terminal, diff or files block shown in a room of more than one person (the kernel's own count, mirrored) carries the note; in a chat of one it never does. @param {string} grp @param {any} b */
  const noted = (grp, b) => (b && typeof b === "object" && NOTED.has(b.block) && group(grp).people.size > 1 ? { ...b, ...(typeof b.note === "string" && b.note ? { detail: b.note } : {}), note: ROOM_NOTE } : b); // a files block's own note (what it found) moves to `detail`
  /** @param {string} grp @param {any} d a frame's data: the room note on the blocks it carries */
  function withNote(grp, d) {
    if (!d || typeof d !== "object") return d;
    let out = d;
    if (d.result) out = { ...out, result: noted(grp, d.result) };
    if (Array.isArray(d.blocks)) out = { ...out, blocks: d.blocks.map((/** @type {any} */ x) => noted(grp, x)) };
    return out;
  }

  /**
   * Everything an assistant does goes through the member's queue, in order, and ALL of it through the reply handle (the kernel's appendOpen; no side path): its
   * words stream (the first non-reasoning delta opens the reply, which the port stamps with the chat's membership version; each delta is written to the handle and
   * then shown with that stamp, `data.rid` and `data.ver`, text-done closes it); reasoning, tool progress, tool and terminal blocks, asks and files are written to
   * the open reply's handle, or to a handle of the turn's own that opens at the first of them and closes when the turn ends. Reasoning before a reply waits for it to
   * open (a turn of reasoning only writes nothing). The one frame shown without a handle is the plain failed status of a reply dropped for want of a session. A refusal at open shows nothing; one later cuts the reply where it is
   * (text-cut). Nothing is held until the message is whole.
   * @param {Member} m @param {any[]} specs
   */
  function projectKernel(m, specs) {
    m.pq = (m.pq || Promise.resolve()).then(async () => {
      for (const s of specs) {
        // A status is not shown in the group (SKIP) but it ends the turn: the turn's own handle closes and thinking that never became a reply is dropped.
        if (s.kind === "status") {
          const st = s.data && s.data.state;
          if (st === "working") m.running = true;
          else if (st) { await endTurn(m); if (st !== "starting") m.running = false; } // a turn ends when the thread leaves working (for waiting, done, failed, stopped); "starting" is not its end
          continue;
        }
        // A queued message's turn begins (the Switchboard's thread.sent via "turn"): from here the replies belong to ITS asker and answer id, and the waiting message shows as taken up.
        if (s.kind === "turn-start") { startQueued(m, s.queued); continue; }
        if (SKIP.has(s.kind)) continue;
        if (s.kind === "text-delta" || s.kind === "text-done") await reply(m, s); else await activity(m, s);
      }
    }).catch(err => { log(`projecting ${m.who} in ${m.grp}: ${/** @type {Error} */ (err).message}`); });
  }

  /**
   * A message the Switchboard queued behind another person's turn has reached its turn: the replies from here on are its asker's, under its answer id, and the message frame
   * goes from "queued" to "picked-up". The running turn was never touched while this one waited. @param {Member} m @param {number} queued
   */
  function startQueued(m, queued) {
    const w = m.queuedTurns && m.queuedTurns.get(queued); if (!w) return;
    m.queuedTurns.delete(queued);
    m.asker = w.asker; m.answer = w.answer; m.msgs = new Map(); m.dead = false; m.running = true; save(m);
    shown(w.grp, w.message, "picked-up", w.text, w.asker, queued);
  }
  /** The state of a person's message, as the viewers fold it (the latest user-message frame of a message wins). @param {string} grp @param {string} message @param {string} state @param {string} text @param {string} author @param {number} [queuedId] */
  function shown(grp, message, state, text, author, queuedId) {
    try { logs.get(grp).append("user-message", { message, text, state, ...(queuedId != null ? { queued_id: queuedId } : {}) }, { author, message }); } catch (err) { log(`message state in ${grp}: ${/** @type {Error} */ (err).message}`); }
  }

  /**
   * The turn is over (the thread's status left "working"): the turn's own handle is closed, and thinking that never became a reply is DROPPED, not shown: a turn of
   * reasoning only writes nothing to the room (no frame, no handle, no kernel message).
   * @param {Member} m
   */
  async function endTurn(m) {
    closeStep(m);
    idle(m);
    const buf = m.buf; if (!buf) return;
    for (const [id, b] of [...buf]) {
      if (id === ACT) { buf.delete(ACT); if (m.refused) m.refused.delete(ACT); if (b.h) { try { await b.h.close({ text: "" }); } catch {} } continue; }
      if (!b.h && !b.reply) buf.delete(id);
    }
  }

  /** Not a message: tools, asks, files. Written through the handle of the reply that streams, else the turn's own. @param {Member} m @param {any} s */
  async function activity(m, s) {
    if (s.kind === "tool-started") doing(m, s.data && (s.data.summary || s.data.tool));
    if (s.kind === "tool-started" || s.kind === "tool-progress" || s.kind === "tool-finished") {
      const st = stepOf(m);
      if (s.kind === "tool-started") { st.tools++; const k = String((s.data && s.data.kind) || "other"); st.kinds.set(k, (st.kinds.get(k) || 0) + 1); }
      if (s.kind === "tool-finished" && s.data && s.data.ok === false) st.failed++;
      s = { ...s, data: { ...s.data, step: st.id } };
    }
    if (carriesFieldValue(s.data) && group(m.grp).people.size > 1) { log(`${s.kind} for ${m.who} in ${m.grp}: dropped, it carried a field value (cite it as a field-ref)`); return; }
    const m0 = m.buf || (m.buf = new Map()); m.refused ||= new Set();
    /** @type {any} */ let b = null; let message = ACT;
    for (const [id, x] of m0) if (x.h && id !== ACT) { b = x; message = id; }
    if (!b) {
      b = m0.get(ACT);
      if (!b) { b = { items: [], reply: "", h: null, at: cursor(m.grp), token: "", lastSync: 0 }; m0.set(ACT, b); }
      if (!b.h && !(await begin(m, b, ACT))) return;
    }
    await put(m, b, s, withNote(m.grp, s.data), message === ACT ? undefined : message);
  }

  /** What every frame of an open reply carries (`rid`, not `kid`: that is a person's message): the kernel's id for it and the membership version it was opened at. @param {any} b */
  const stampOf = b => ({ rid: b.h.id, ver: b.h.ver });

  /**
   * One frame of a reply: its content goes to the handle first (the kernel's liveness and person check at every write), then it is shown with the handle's stamp. In a room
   * of more than one person a frame that carries a field value is dropped here, for every kind. False when the kernel took its word back (the reply is cut).
   * @param {Member} m @param {any} b @param {any} s @param {any} data @param {string} [message]
   */
  async function put(m, b, s, data, message) {
    if (group(m.grp).people.size > 1 && carriesFieldValue(data)) { log(`${s.kind} for ${m.who} in ${m.grp}: dropped, it carried a field value (cite it as a field-ref)`); return true; }
    const delta = s.kind === "text-delta" && typeof data.text === "string" ? data.text : JSON.stringify(data);
    try { await b.h.write(delta); } catch (err) { withdraw(m, b, message ?? ACT, s, err); return false; }
    write(m, s, { ...data, ...stampOf(b) }, message);
    return true;
  }

  /**
   * Open the reply: the port stamps it, the reasoning that waited is written through it with the stamp. False when the kernel refused, or the wait for the assistant's
   * session ran out (nothing was shown, and the room is told once). @param {Member} m @param {any} b @param {string} message
   */
  async function begin(m, b, message) {
    const refuse = () => { /** @type {Set<string>} */ (m.refused).add(message); /** @type {Map<string, any>} */ (m.buf).delete(message); };
    if (m.dead) { refuse(); return false; }
    if (viaKs()) return beginViaKs(m, b, message, refuse);
    const t = await tokenOf(m);
    if (!t) {
      // No session came in time (a restart forgot it and the asker did not act): the wait ends, the pending reply is dropped and the room is told, in words with no content.
      m.dead = true; refuse();
      log(`${m.who} in ${m.grp}: no session within ${RESUME_MS / 1000}s; the reply was dropped`);
      write(m, { kind: "status", turn: null }, { state: "failed", note: RESUME_NOTE });
      return false;
    }
    try { await syncList(m.grp, t.token); b.h = await port.open({ grp: m.grp, token: t.token, message }); }
    catch (err) {
      refuse();
      log(`${m.who} in ${m.grp}: the kernel refused the reply (${/** @type {any} */ (err).code || "error"}); nothing was shown`);
      return false;
    }
    b.token = t.token; b.lastSync = now();
    return flushHeld(m, b, message);
  }

  /** The reasoning that waited for the reply to open is written through its handle now. @param {Member} m @param {any} b @param {string} message */
  async function flushHeld(m, b, message) {
    const shown = message === ACT ? undefined : message;
    const items = b.items; b.items = [];
    for (const it of items) if (!(await put(m, b, it, it.data, shown))) return false;
    return true;
  }


  /** The daemon path of begin: the turn is begun, then the reply opens through the seam. No token, no list read of our own, no wait of our own for a session: a restart's reopening is the kernel session's (reopenPending). */
  async function beginViaKs(m, b, message, /** @type {() => void} */ refuse) {
    // A restart is still reopening the open turns: this reply waits for that, and then goes on or is dropped with the others.
    if (reopening) { try { await reopening; } catch { /* the outcome is each turn's own */ } }
    if (m.dead) { refuse(); return false; }
    try { b.h = await port.open({ grp: m.grp, token: "", thread: m.thread || "", message, ...(m.asker ? { asker: m.asker } : {}) }); }
    catch (err) {
      refuse();
      if (/** @type {any} */ (err).code === "no_session") {
        // The session did not come back (reopenPending gave it up, or never had it): the pending reply is dropped and the room is told, with no content.
        m.dead = true; giveUpNote(m);
        return false;
      }
      log(`${m.who} in ${m.grp}: the kernel refused the reply (${/** @type {any} */ (err).code || "error"}); nothing was shown`);
      return false;
    }
    b.lastSync = now();
    return flushHeld(m, b, message);
  }

  /** The room is told, in words with no content, that a pending reply could not be resumed. @param {Member} m */
  function giveUpNote(m) {
    log(`${m.who} in ${m.grp}: no session came back; the reply was dropped`);
    write(m, { kind: "status", turn: null }, { state: "failed", note: RESUME_NOTE });
  }

  /** The kernel took its word back while the reply streamed: it stops where it is, the people who had it see it cut. @param {Member} m @param {any} b @param {string} message @param {any} s @param {any} err */
  function withdraw(m, b, message, s, err) {
    /** @type {Set<string>} */ (m.refused).add(message); /** @type {Map<string, any>} */ (m.buf).delete(message);
    log(`${m.who} in ${m.grp}: the kernel refused the rest of the reply (${/** @type {any} */ (err).code || "error"}); it was cut`);
    write(m, { kind: "text-cut", turn: s.turn }, { ...(message === ACT ? { note: cutNote("").note } : cutNote(message)), ...stampOf(b) }, message === ACT ? undefined : message);
  }

  /** @param {Member} m @param {any} s a text-delta or text-done */
  async function reply(m, s) {
    const m0 = m.buf || (m.buf = new Map()), refused = m.refused || (m.refused = new Set());
    const message = m.answer ? answerId(m, String(s.data.message)) : String(s.data.message);
    if (refused.has(message)) return;
    let b = m0.get(message);
    if (!b) { b = { items: [], reply: "", h: null, at: cursor(m.grp), token: "", lastSync: 0 }; m0.set(message, b); }
    if (s.kind === "text-delta") {
      if (s.data.reasoning) {
        if (b.h) await put(m, b, s, { ...s.data, message }, message); else b.items.push({ ...s, data: { ...s.data, message } }); // thinking waits for the reply to open
        return;
      }
      closeStep(m);
      if (!b.h && !(await begin(m, b, message))) return;
      // A kernel port follows the room itself; the stand-in reads the kernel's list now and then, so a person who left stops receiving.
      if (port.follow && now() - b.lastSync >= SYNC_MS) { b.lastSync = now(); try { await syncList(m.grp, b.token); if (!group(m.grp).bots.has(m.who)) throw Object.assign(new Error("the assistant is no longer in the chat"), { code: "denied" }); } catch (err) { if (["not_found", "denied", "forbidden"].includes(/** @type {any} */ (err).code)) { withdraw(m, b, message, s, err); return; } } }
      const text = String(s.data.text);
      if (!(await put(m, b, s, { ...s.data, message }, message))) return;
      b.reply += text;
      return;
    }
    let blocks = Array.isArray(s.data.blocks) ? s.data.blocks : [];
    if (!b.h && !b.reply && blocks.length === 0) { b.items.push({ ...s, data: { ...s.data, message } }); return; } // reasoning so far: held until the turn ends
    // A room of more than one person (the kernel's own list, mirrored here): the reply never carries a field value, it cites it as a field-ref, drawn per viewer.
    if (group(m.grp).people.size > 1 && blocks.some((/** @type {any} */ x) => x && x.block === "field" && x.placeholder !== true)) {
      log(`text-done for ${m.who} in ${m.grp}: a field value was dropped (cite it as a field-ref)`);
      blocks = blocks.filter((/** @type {any} */ x) => !(x && x.block === "field" && x.placeholder !== true));
    }
    blocks = blocks.map((/** @type {any} */ x) => noted(m.grp, x));
    if (!b.h && !(await begin(m, b, message))) return;
    const done = { ...s.data, message, ...(blocks.length ? { blocks } : {}), ...stampOf(b) };
    if (!blocks.length) delete done.blocks;
    try { await b.h.close({ text: b.reply, ...(blocks.length ? { blocks } : {}) }); } catch (err) { withdraw(m, b, message, s, err); return; }
    write(m, s, done, message);
    m0.delete(message);
  }

  /** The log first, then the cursor: a crash can repeat a moment of a thread's words, never lose them. */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const ms = [...dirty]; dirty.clear();
    for (const g of new Set(ms.map(m => m.grp))) { try { logs.get(g).flush(); } catch {} }
    for (const m of ms) { try { q.last.run(m.last, m.grp, m.who); } catch {} }
  }

  /** Read what a thread did that the group has not seen, project it, then the events held meanwhile. @param {Member} m */
  async function catchUp(m) {
    if (!m.thread) return;
    byThread.set(m.thread, m);
    m.held = [];
    try {
      const r = await ctx.call("threads.get", { thread: m.thread, limit: 1000 });
      const events = r && r.data && Array.isArray(r.data.events) ? r.data.events : [];
      for (const ev of events) if (EVENTS.test(ev.type)) project(m, { ...ev, thread: m.thread });
    } catch (err) { log(`catch up ${m.thread}: ${/** @type {Error} */ (err).message}`); }
    const held = m.held; m.held = null;
    for (const e of held) project(m, e);
  }

  /** @param {any} e a switchboard event */
  function onEvent(e) {
    if (!e || !e.thread || !EVENTS.test(e.type)) return;
    const m = byThread.get(e.thread);
    if (!m) return;
    if (m.held) m.held.push(e); else project(m, e);
  }

  /** A chat's own working folder, where a run with no folder of its own works: `<home>/chats/<chat id>/work`. @param {string} grp */
  const chatFolder = grp => { const root = ctx.paths && ctx.paths.root; if (!root) throw fail("bad_input", "this chat has no folder to work in: name its cwd"); const d = path.join(String(root), "chats", grp, "work"); fs.mkdirSync(d, { recursive: true }); return d; };

  // ---- runs started outside the stream (One Chat) -----------------------------------------------------

  /**
   * Read a run's history into the group and then follow it: the person's words and the run's replies, in order, as the chat's own transcript. The replies go through the kernel like any (the reply
   * handle of the run's own session); the person's words are written as they were said. `asker` is who the replies act for.
   * @param {Member} m @param {string} asker
   */
  async function seedRun(m, asker) {
    byThread.set(String(m.thread), m);
    m.held = [];
    /** @type {any[]} */ let events = [];
    try { const r = await ctx.call("threads.get", { thread: m.thread, limit: 1000 }); events = r && r.data && Array.isArray(r.data.events) ? r.data.events : []; }
    catch (err) { log(`seed ${m.thread}: ${/** @type {Error} */ (err).message}`); }
    m.asker = asker; m.answer = `h.${String(m.thread).slice(0, 8)}`; m.msgs = new Map();
    for (const ev of events) {
      if (!EVENTS.test(ev.type)) continue;
      const id = Number(ev.id);
      if (!(id > m.last)) continue;
      m.last = id;
      /** @type {any[]} */ let specs = [];
      try { specs = m.ad.event({ ...ev, thread: m.thread }); } catch (err) { log(`${ev.type} for ${m.thread}: ${/** @type {Error} */ (err).message}`); }
      for (const sp of specs) {
        if (sp.kind === "user-message") {
          await (m.pq || Promise.resolve());
          try { logs.get(m.grp).append("user-message", { ...sp.data, state: "sent", history: true }, { author: asker, message: String(sp.data.message) }); } catch { /* a word that cannot be shown is left out */ }
        } else if (!SKIP.has(sp.kind) || sp.kind === "status") projectKernel(m, [sp]);
      }
    }
    await (m.pq || Promise.resolve());
    const held = m.held; m.held = null;
    for (const e of held) project(m, e);
    m.asker = null; m.answer = null; m.msgs = new Map();
    dirty.add(m);
    if (!timer && !stopped) { timer = setTimeout(flush, 100); timer.unref?.(); }
  }

  /**
   * One Chat: a chat whose run was started outside the stream (the CLI, a terminal, a Flow, the assistant) continues here. Its runs become the chat's members (an agent's run is that agent's slot, a
   * run with no agent is a model slot `model:<provider>/<model>#<id>`), answering on their own threads, so a message sent in the chat goes to the run that is already there and the transcript is one.
   * Done once per run, at a send. @param {string} grp @param {string} asker the person speaking (`person:per_x`)
   */
  async function adoptRuns(grp, asker) {
    if (!kernelOn()) return;
    const r = await ctx.call("threads.of-chat", { chat: grp }).catch(() => null);
    const runs = r && r.data && Array.isArray(r.data.runs) ? r.data.runs : [];
    const g = group(grp);
    for (const run of runs) {
      const thread = String(run.thread);
      if ([...g.bots.values()].some(x => x.thread === thread) || byThread.has(thread)) continue;
      const who = run.agent ? `assistant:${run.agent}` : String(run.slot || `model:${run.provider || "claude"}/${run.model || "default"}#${parseInt(thread.slice(0, 5), 16) % 1000000}`);
      let m = g.bots.get(who);
      if (m && m.thread) continue; // that slot already answers on another thread of its own
      if (!m) { join(grp, who, { name: run.name ? String(run.name) : undefined }); m = g.bots.get(who); }
      if (!m) continue;
      m.thread = thread; m.kind = "run"; save(m);
      await seedRun(m, asker);
    }
    if (!g.dflt) { const only = [...g.bots.keys()]; if (only.length === 1) g.dflt = only[0]; }
  }

  // ---- delivery -----------------------------------------------------------------------------------

  /** The kernel's person id from an actor string (`person:per_x` to `per_x`); the Switchboard refuses any other form. @param {string} a */
  const askerId = a => a.replace(/^person:/, "");
  /** The message id of a row: its answer id minus the assistant's suffix. @param {any} row */
  const messageOf = row => String(row.answer).slice(0, String(row.answer).lastIndexOf("."));
  /** One handing over of a row to its assistant's thread (threads.start or threads.send). @param {Member} m @param {any} row @param {string} asker */
  async function sendTurn(m, row, asker) {
    // The turn begins at the kernel when its session opens (lib/kernel-session.js open, called for the asker by the Switchboard on this very send): the stream does not begin it a second time.
    const surface = row.surface ? String(row.surface) : "deck";
    // On the seam the Switchboard opens this turn's kernel session for the asker in this chat, from these two inputs (it honours them from module:stream alone); the kernel checks the asker is in the chat.
    const turn = viaKs() ? { chat: String(row.grp), asker: askerId(asker) } : {};
    // A delivery after a restart runs in no call (a timer, the start): a module hop with no origin is refused for a tool a person's surface reaches, so the row's own surface (the class of the
    // call that wrote it) is the origin. The kernel still checks the asker is in the chat; this only says the words came from a person's surface.
    const run = (/** @type {() => Promise<any>} */ f) => (ctx.events && typeof ctx.events.withOrigin === "function" && !ctx.events.origin() ? ctx.events.withOrigin(surface, f) : f());
    if (!m.thread) {
      if (!m.cwd) throw fail("bad_input", `${m.who} has no folder to work in: name its cwd when it joins`);
      const r = await run(() => ctx.call("threads.start", { cwd: m.cwd, prompt: String(row.text), surface, ...(m.who.startsWith("model:") ? { slot: m.who } : {}), ...turn }));
      if (r.error) throw fail(r.error.code || "failed", r.error.message);
      m.thread = String(r.data.id);
      save(m);
      await catchUp(m);
    } else {
      byThread.set(m.thread, m);
      const send = () => run(() => ctx.call("threads.send", { thread: m.thread, text: String(row.text), surface, uuid: String(row.uuid), ...(row.mode ? { mode: String(row.mode) } : {}), ...(row.tz ? { tz: String(row.tz) } : {}), ...(row.images ? { images: JSON.parse(String(row.images)) } : {}), ...turn }));
      let r = await send();
      if (r.error) throw fail(r.error.code || "failed", r.error.message);
      // A run started elsewhere (the CLI, a terminal) is held by the surface that started it: a person speaking in the chat takes the keyboard, once, as the stream's own runs always have it.
      if (r.data && r.data.sent === false && r.data.holder && !r.data.queued && r.data.queued_id == null) {
        const l = await run(() => ctx.call("threads.lease", { thread: m.thread, surface }));
        if (l.error) throw fail(l.error.code || "failed", l.error.message);
        r = await send();
        if (r.error) throw fail(r.error.code || "failed", r.error.message);
      }
      return r.data;
    }
    return undefined;
  }
  /** @param {any} row */
  async function deliver(row) {
    const g = group(String(row.grp));
    const m = g.bots.get(String(row.who));
    if (!m) { q.outDone.run(row.uuid); return; }
    if (holdWho() === m.who) return; // tests only
    // The asker is the kernel's person id (per_...), the one form the Switchboard takes: the author recorded by the gate is `person:per_x`, converted here at the boundary.
    const asker = String(row.asker);
    // A stopped stream sends nothing more: the row stays in the outbox for the next start.
    if (stopped) return;
    // The stream does not hold, retry or queue: the Switchboard queues another person's message behind a running turn and answers `queued` with a queued_id. The running turn's attribution is
    // not touched for a message that may queue; it is set when the Switchboard says the message went in at once, or when the queued turn begins (thread.sent via "turn").
    const mayQueue = viaKs() && m.running && m.asker && m.asker !== asker;
    const prev = { asker: m.asker, answer: m.answer, msgs: m.msgs, dead: m.dead, running: m.running };
    const take = () => { m.asker = asker; m.answer = String(row.answer); m.msgs = new Map(); m.dead = false; m.running = true; save(m); };
    if (!mayQueue) take();
    let r;
    try { r = await sendTurn(m, row, asker); }
    catch (err) { if (!mayQueue) { Object.assign(m, prev); save(m); } throw err; }
    if (r && r.queued_id != null && (r.queued === true || typeof r.queued === "number")) {
      // Waiting for the current reply: the queued message is shown so, by the id the Switchboard gave, and its turn starts under its own asker.
      if (!mayQueue) { Object.assign(m, prev); save(m); }
      (m.queuedTurns ||= new Map()).set(Number(r.queued_id), { asker, answer: String(row.answer), grp: String(row.grp), message: messageOf(row), text: String(row.text) });
      shown(String(row.grp), messageOf(row), "queued", String(row.text), asker, Number(r.queued_id));
    } else if (mayQueue) take();
    q.outDone.run(row.uuid);
  }
  /** One delivery at a time per assistant, in the order asked. @param {any} row */
  function schedule(row) {
    const m = group(String(row.grp)).bots.get(String(row.who));
    if (!m) return Promise.resolve();
    const p = m.q.then(() => deliver(row)).catch(err => { log(`deliver to ${row.who} in ${row.grp}: ${/** @type {Error} */ (err).message} (kept in the outbox)`); });
    m.q = p;
    return p;
  }

  // ---- the tools ------------------------------------------------------------------------------------

  /** @param {any} spec string or { id, name, cwd, role } */
  const asJoin = spec => (typeof spec === "string" ? { id: spec } : spec && typeof spec === "object" ? spec : {});
  const validId = (/** @type {unknown} */ id) => typeof id === "string" && /^(person|assistant|model):[^\s]{1,120}$/.test(id);

  /** @type {Map<string, Promise<any>>} */ const inflight = new Map();
  /** The person's own session for this chat, from the chain of the call they made (mirror() recorded it). With no such chain the kernel's chat was not checked: refused. @param {any} meta @param {string} grp @param {string} person */
  async function personSession(meta, grp, person) {
    const k = meta && typeof meta === "object" ? kcalls.get(meta) : undefined;
    if (!k || k.person !== person) throw fail("person_session_required", "this chat is the kernel's: a call needs the person's own session");
    return sessionFor(k.chain, grp, person);
  }

  /** @param {any} i @param {any} meta @param {string} [hidden] words the server adds to what the assistants are given (never to what the chat shows), made from this chat's own log: only secondOpinion passes any */
  async function sendOnce(i, meta, hidden = "") {
    {
      const grp = sessionOf(i);
      const author = personOf(meta, i);
      // SS-2: with the kernel on, the asker of every turn is the kernel-verified author of the message (the chain the call was made under, recorded by the gate), never `as`, `asker` or anything else the caller wrote.
      if (kernelOn() && !(meta && typeof meta === "object" && kernelPerson.has(meta))) throw fail("person_session_required", "this chat is the kernel's: a call needs the person's own session");
      mustBeIn(grp, author);
      // A private message (enc, an opaque ciphertext made on the person's device): stored and relayed as it is, never parsed, routed to
      // no assistant, mentioned to nobody. The home does not hold its words.
      if (i.enc !== undefined) {
        if (i.text !== undefined && String(i.text) !== "") throw fail("bad_input", "a private message carries enc and no text");
        if (!validEnc(i.enc)) throw fail("bad_input", "enc is { alg, kid, ct }, three strings");
        const message = typeof i.message === "string" && ID.test(i.message) ? i.message : crypto.randomUUID();
        const out = logs.get(grp);
        join(grp, author, { name: typeof i.name === "string" ? i.name : undefined });
        const had = out.read(0).find(f => f.type === "chat.user-message" && f.data.message === message);
        if (!had && kernelOn()) await append((await personSession(meta, grp, author)).token, { enc: { alg: i.enc.alg, kid: i.enc.kid, ct: i.enc.ct } }, "private");
        if (!had) { out.append("user-message", { message, enc: { alg: i.enc.alg, kid: i.enc.kid, ct: i.enc.ct }, state: "sent" }, { author, message }); group(grp).previous = author; }
        return { session: grp, message, private: true, routed: [], answers: [], ...(had ? { duplicate: true } : {}) };
      }
      const text = String(i.text ?? "").trim();
      if (!text) throw fail("bad_input", "text is empty");
      if (text.length > 20000) throw fail("bad_input", "text is too long");
      const tz = typeof i.tz === "string" && validZone(i.tz) ? i.tz : (zoneFrom(meta && meta.zone, "") || null); // the device's own zone: what it said, else the header the daemon validated
      const message = typeof i.message === "string" && ID.test(i.message) ? i.message : crypto.randomUUID();
      const out = logs.get(grp);
      const g = group(grp);
      // A repeat of a message this group already holds: nothing is appended again; any delivery not yet taken is retried.
      const had = out.read(0).find(f => f.type === "chat.user-message" && f.data.message === message);
      const cwd = typeof i.cwd === "string" ? i.cwd : undefined;
      join(grp, author, { name: typeof i.name === "string" ? i.name : undefined });
      // Kernel on: `default` only chooses among the assistants the kernel lists (routing, not membership).
      if (kernelOn() && typeof i.default === "string" && group(grp).bots.has(i.default)) group(grp).dflt = i.default;
      // Kernel on: people and assistants are the kernel's list (a person in the chat changes it, acting directly); a send adds nobody.
      if (kernelOn() && ((Array.isArray(i.people) && i.people.length) || (Array.isArray(i.assistants) && i.assistants.length))) throw fail("bad_input", "people and assistants of a chat are added with the kernel's chat change, by a person in it");
      for (const spec of [...(i.people || []), ...(i.assistants || [])]) {
        const j = asJoin(spec);
        if (!validId(j.id)) throw fail("bad_input", "a participant is person:<id>, assistant:<id> or model:<id>");
        join(grp, j.id, { name: j.name, cwd: j.cwd || cwd, role: j.id === i.default ? "default" : j.role });
      }
      if (had) {
        const rows = q.outOpen.all().filter(r => r.grp === grp);
        for (const r of rows) void schedule(r);
        const fo = out.read(0).find(f => f.type === "chat.fanout" && f.data.message === message);
        const answers = rows.map(r => ({ who: String(r.who), message: String(r.answer) }));
        return { session: grp, message, duplicate: true, ...(fo ? { group: fo.data.group, answers: fo.data.members } : { answers }) };
      }
      await adoptRuns(grp, author);
      // One Chat: a chat of one person with nobody in it who answers yet (a new chat) gets the default model slot, and this send starts its run in the chat. A chat of several people never does: an assistant
      // does not jump into a conversation between people.
      if (kernelOn() && g.bots.size === 0 && g.people.size === 1 && !(Array.isArray(i.to) && i.to.length)) {
        const who = `model:claude/default#${100000 + (crypto.randomBytes(3).readUIntBE(0, 3) % 899999)}`;
        join(grp, who, { role: "default", cwd: chatFolder(grp) });
        const slot = g.bots.get(who);
        if (slot) { slot.kind = "run"; save(slot); g.dflt = who; }
      }
      // a quoted reply (WhatsApp-style, same timeline): the quote is read from this chat's log; the model is told what it answers
      const quote = typeof i.reply_to === "string" && /^[^\s]{1,300}$/.test(i.reply_to) ? quoteOf(grp, i.reply_to) : null;
      if (i.reply_to !== undefined && !quote) throw fail("bad_input", "reply_to is a message id");
      const parts = participants(g);
      const mentions = mentionedIn({ participants: parts, text, mentions: i.mentions });
      /** @type {string[]} */ let to;
      if (Array.isArray(i.to) && i.to.length) {
        to = [];
        for (const t of i.to) {
          const id = mentionedIn({ participants: parts, mentions: [String(t)] })[0];
          if (!id || !botId(id)) throw fail("bad_input", `${t} is not an assistant in this group`);
          if (!to.includes(id)) to.push(id);
        }
      } else to = whoAnswers({ participants: parts, defaultAssistant: g.dflt, text, mentions: i.mentions, author, previous: g.previous });
      if (to.length > 8) throw fail("bad_input", "at most 8 assistants answer one message");
      for (const id of to) {
        const m = g.bots.get(id);
        if (m && !m.thread && !m.cwd && !cwd && kernelOn()) { m.cwd = chatFolder(grp); save(m); } // a run with no folder of its own works in the chat's
        else if (m && !m.thread && !m.cwd && !cwd) throw fail("bad_input", `${id} has no folder to work in: pass cwd`);
      }

      // What the message carries beside the words, for the assistants only (a record named exactly, the files attached): read under the sender's own chain, and a bad list refuses the send before anything is stored.
      const carried = await sendContext({ chain: (kcalls.get(meta) || {}).chain, grp, text, pasted: i.pasted, attachments: i.attachments, members: await Promise.all(to.map(async id => { const m = g.bots.get(id); return { who: id, cwd: m ? m.cwd || (m.thread ? await ctx.call("threads.get", { thread: m.thread, limit: 1 }).then(r => (r.data && r.data.thread && r.data.thread.cwd) || null, () => null) : null) : null, session: Boolean(m && m.thread) }; })) });
      // Kernel on: the kernel takes the words first (a person's own token, with the chat in it), and a session token for each assistant that will answer
      // (its replies are appended under it). A refusal here is the send's refusal: nothing is stored.
      /** @type {string|undefined} */ let kid;
      if (kernelOn()) {
        const mine = await personSession(meta, grp, author);
        const bots = [];
        // The assistants' sessions are vyred's (the seam), opened from this send; the stream opens none for them on the daemon path.
        if (!viaKs()) for (const id of to) { const m = g.bots.get(id); const k = kcalls.get(meta); if (m && k) bots.push([m, await sessionFor(k.chain, grp, author, shortOf(id))]); }
        kid = String((await append(mine.token, { text })).id);
        for (const [m, t] of bots) giveToken(/** @type {Member} */ (m), author, /** @type {any} */ (t));
      }
      out.append("user-message", { message, text, state: "sent", ...(carried.saved.length ? { attachments: carried.saved } : {}), ...(kid ? { kid } : {}), ...(quote ? { reply_to: quote.message, quote } : {}), ...(tz ? { tz } : {}) }, { author, message });
      if (mentions.length) out.append("mention", { message, who: mentions }, { author, message });
      g.previous = author;
      const answers = to.map(who => ({ who, message: `${message}.${g.names.get(who) || shortOf(who)}` }));
      let groupId;
      if (answers.length >= 2) { groupId = typeof i.group === "string" && ID.test(i.group) ? i.group : `g.${message}`; out.append("fanout", { group: groupId, message, members: answers }, { author, message }); }
      const surface = typeof i.surface === "string" ? i.surface : "deck";
      const mode = i.mode === "queue" || i.mode === "steer" ? i.mode : null;
      const rows = answers.map(a => {
        const row = { uuid: uuidOf(`${message}|${a.who}`), grp, who: a.who, text: (quote ? `Replying to ${g.names.get(quote.author) || shortOf(quote.author) || "an earlier message"}: "${quote.text}"\n\n${text}` : text) + (hidden ? `\n\n${hidden}` : "") + (carried.noteOf(a.who) ? `\n\n${carried.noteOf(a.who)}` : ""), asker: author, answer: a.message, surface, mode, tz, images: carried.imagesOf(a.who).length ? JSON.stringify(carried.imagesOf(a.who)) : null };
        const m = g.bots.get(a.who); if (m && !m.cwd && cwd) { m.cwd = cwd; save(m); }
        q.outAdd.run(row.uuid, grp, row.who, row.text, row.asker, row.answer, row.surface, row.mode, row.tz, row.images);
        return row;
      });
      for (const r of rows) void schedule(r);
      return { session: grp, message, routed: to, answers, ...(groupId ? { group: groupId } : {}) };
    }
  }

  /** @type {any} */ const api = {
    port,
    markers,
    person: personOf,
    /** Does a group by this id exist here (in memory or stored)? Creates nothing. @param {string} grp */
    known: grp => groups.has(grp) || logs.known(grp),
    /** Does any assistant of this chat's group answer on a thread of its own yet? (A chat whose one run was started outside the stream has none: its transcript is that run's own log.) @param {string} grp */
    bound: grp => (groups.has(grp) || logs.known(grp)) && [...group(grp).bots.values()].some(m => Boolean(m.thread)),
    /** The chat a thread answers in and who it is there ("assistant:juno"), or null when the thread is in no chat. @param {string} thread */
    ofThread: thread => { const m = byThread.get(thread); return m && m.grp ? { grp: m.grp, who: m.who } : null; },
    /** The people in a group, from its log. Call only for a known group. @param {string} grp */
    people: grp => new Set(group(grp).people),

    /**
     * The kernel holds a chat's people and assistants (one store); this group mirrors that list, never the other way: whoever the kernel lists and the group
     * lacks joins, whoever the group holds and the kernel no longer lists leaves (a participant-left frame). A call can add nobody. The caller's own person
     * and chain come from the kernel's chain for their token; an assistant that acts for this person gets a session token for it (so its replies can be
     * appended), also after a restart. @param {string} grp @param {{ people: string[], assistants?: string[] }} chat @param {any} meta @param {string} person @param {any} chain
     */
    async mirror(grp, chat, meta, person, chain) {
      if (meta && typeof meta === "object") { kernelPerson.set(meta, person); kcalls.set(meta, { chain, person }); }
      const g = adopt(grp, chat);
      // An assistant that is working for this person has no session token after a restart: open one now, so the replies waiting for it can be written.
      if (!viaKs()) for (const m of g.bots.values()) if (m.asker === person && ((m.tokens || new Map()).get(person) || { exp: 0 }).exp - 5000 <= now()) {
        try { giveToken(m, person, await sessionFor(chain, grp, person, shortOf(m.who))); } catch (err) { log(`session for ${m.who} in ${grp}: ${/** @type {any} */ (err).code || "error"}`); }
      }
    },

    /**
     * Who may receive and from where, for a viewer of a group chat (kernel on): `may(frame)` asks the reply port (never decides here), `floor` is the cursor of the
     * viewer's own join (they see the chat from then). @param {string} grp @param {string} person @param {any} chain the viewer's own kernel chain (the kernel's answer is for the person asking)
     */
    viewerFor(grp, person, chain) {
      const g = group(grp);
      const l = g.spans.get(person) || [];
      const floor = l.length ? l[l.length - 1].from : 0;
      return {
        floor,
        may: (/** @type {any} */ f) => {
          const d = f && f.data;
          if (!d) return true;
          if (typeof d.rid === "string") return port.mayReceive(grp, person, { kid: d.rid, ver: Number(d.ver), cur: Number(f.cur) }, chain);
          if (Number.isInteger(d.at)) return inAt(g, person, d.at) && inAt(g, person, Number(f.cur)); // a tool, an ask, a held thought: the stream's own list at the cursor it was stamped
          return true;
        },
      };
    },

    /** One send at a time per message id: a retry that arrives while the first is still being written to the kernel waits and then finds it done. @param {any} i @param {any} meta */
    async send(i, meta, hidden = "") {
      const grp = sessionOf(i);
      const key = typeof i.message === "string" && ID.test(i.message) ? `${grp}|${i.message}` : null;
      if (!key) return sendOnce(i, meta, hidden);
      const before = inflight.get(key) || Promise.resolve();
      const run = before.catch(() => {}).then(() => sendOnce(i, meta, hidden));
      inflight.set(key, run);
      try { return await run; } finally { if (inflight.get(key) === run) inflight.delete(key); }
    },

    /**
     * The returning view: what happened in a chat since the caller's read marker, in plain facts (no model summary): who said what (the last ten messages, each cut to 140 characters), the run steps
     * that were taken (their summaries), the questions still open, and who joined or left. Read from the chat's own log; nothing is invented. @param {any} i @param {any} meta
     */
    catchup(i, meta) {
      const grp = sessionOf(i);
      const person = personOf(meta, i);
      mustBeIn(grp, person);
      const log0 = logs.get(grp);
      const upto = markers.get(person, grp);
      const frames = log0.read(0);
      const fresh = frames.filter(f => f.cur > upto);
      const flat = (/** @type {string} */ t) => { const x = t.replace(/\s+/g, " ").trim(); return x.length > 140 ? `${x.slice(0, 139)}…` : x; };
      /** @type {Map<string, { message: string, author: string, raw: string, cur: number }>} */ const said = new Map();
      for (const f of fresh) {
        if (f.type === "chat.user-message" && f.data && f.data.enc === undefined && f.author !== person) said.set(String(f.data.message), { message: String(f.data.message), author: String(f.author || ""), raw: String(f.data.text || ""), cur: f.cur });
        else if (f.type === "chat.text-delta" && f.data && !f.data.reasoning && f.author) { const cur = said.get(String(f.data.message)); if (cur) cur.raw += String(f.data.text || ""); else said.set(String(f.data.message), { message: String(f.data.message), author: String(f.author), raw: String(f.data.text || ""), cur: f.cur }); }
      }
      const open = new Set(); for (const f of fresh) { if (f.type === "chat.ask" && f.data && f.data.ask_id) open.add(String(f.data.ask_id)); if (f.type === "chat.ask-answered" && f.data) open.delete(String(f.data.ask_id)); }
      const steps = fresh.filter(f => f.type === "chat.step-summary").map(f => ({ step: String(f.data.step), author: String(f.author || ""), summary: String(f.data.summary), ok: f.data.ok === true, count: Number(f.data.count) }));
      const joined = fresh.filter(f => f.type === "chat.participant-joined" && f.data && f.data.who !== person).map(f => String(f.data.who));
      const left = fresh.filter(f => f.type === "chat.participant-left" && f.data).map(f => String(f.data.who));
      const messages = [...said.values()].slice(-10).map(x => ({ message: x.message, author: x.author, text: flat(x.raw) }));
      return { chat: grp, since: upto, head: log0.head, unread: said.size, messages, steps: steps.slice(-10), steps_total: steps.length, open_asks: open.size, joined: [...new Set(joined)], left: [...new Set(left)] };
    },

    /** The caller is typing in the chat (on: false: not any more). Ephemeral: one frame per person every 3 seconds, never logged. @param {any} i @param {any} meta */
    typing(i, meta) {
      const grp = sessionOf(i);
      const author = personOf(meta, i);
      mustBeIn(grp, author);
      const p = presenceOf(grp);
      if (i.on === false) { p.clear(author); logs.get(grp).emit("presence", { who: author, state: "idle" }, { author }); return { session: grp }; }
      p.set(author, "typing");
      return { session: grp };
    },

    /** @param {any} i @param {any} meta */
    react(i, meta) {
      const grp = sessionOf(i);
      if (typeof i.message !== "string" || !ID.test(i.message)) throw fail("bad_input", "message is required");
      const emoji = String(i.emoji || "");
      if (!emoji || emoji.length > 32) throw fail("bad_input", "emoji is required (up to 32 characters)");
      const author = personOf(meta, i);
      mustBeIn(grp, author);
      join(grp, author);
      const f = logs.get(grp).append("reaction", { message: i.message, emoji, on: i.on !== false }, { author, message: i.message });
      return { session: grp, cur: f.cur };
    },

    /** @param {any} i @param {any} meta */
    pin(i, meta) {
      const grp = sessionOf(i);
      if (typeof i.message !== "string" || !ID.test(i.message)) throw fail("bad_input", "message is required");
      const author = personOf(meta, i);
      mustBeIn(grp, author);
      join(grp, author);
      const f = logs.get(grp).append("pin", { message: i.message, on: i.on !== false }, { author, message: i.message });
      return { session: grp, cur: f.cur };
    },

    /**
     * "Ask another model" on an answer (SPEC-0.3.0 12.10): the person asks one other assistant or model of THIS chat for its own answer to the same question. The chat shows one short line from the person
     * (a reply to the answer, to that one assistant), and the assistant is given, besides, the question, the answer and the last turns, all read from this chat's own log (never from the caller), so it
     * answers with the same context. It uses the chat's ordinary send, so the Gate, the kernel's membership and the accounting are the ones every message has.
     * @param {any} i { chat, message, to } @param {any} meta
     */
    async secondOpinion(i, meta) {
      const grp = sessionOf(i);
      const message = String(i.message || ""), to = String(i.to || "");
      if (!ID.test(message) || !to) throw fail("bad_input", "name the answer (message) and the assistant to ask (to)");
      const g = group(grp);
      const fr = logs.get(grp).read(0);
      const mine = fr.filter(f => f.data && f.data.message === message && (f.type === "chat.text-delta" || f.type === "chat.text-done"));
      if (!mine.length) throw fail("not_found", "that answer is not in this chat");
      const authorOf = String((mine.find(f => f.author) || mine[0]).author || "");
      if (!botId(authorOf)) throw fail("bad_input", "a second opinion is asked on an assistant's answer");
      // One tap: a model the chat does not have yet ("codex", "grok/grok-4", or a model:<provider>/<model>#n slot) joins as part of this same act, as the chat's own run slot, the way a new chat's default
      // model does. Only a person's own call gets here (the kernel gate above), and an assistant the chat already lists is used as it is.
      let want = to;
      if (!mentionedIn({ participants: participants(g), mentions: [to] })[0]) {
        const m = /^(?:model:)?([a-z][a-z0-9-]{0,40})(?:\/([A-Za-z0-9][A-Za-z0-9._:/-]{0,80}?))?(?:#[0-9]{1,6})?$/.exec(to);
        if (m && ["claude", "codex", "grok", "openrouter", "openai-compatible"].includes(m[1]) && !to.startsWith("person:") && !to.startsWith("assistant:")) {
          want = /^model:.+#[0-9]{1,6}$/.test(to) ? to : `model:${m[1]}/${m[2] || "default"}#${100000 + (crypto.randomBytes(3).readUIntBE(0, 3) % 899999)}`;
          const there0 = g.bots.get(authorOf);
          join(grp, want, { cwd: (there0 && there0.cwd) || (kernelOn() ? chatFolder(grp) : undefined) });
          const slot = g.bots.get(want);
          if (slot) { slot.kind = "run"; save(slot); }
        }
      }
      const target = mentionedIn({ participants: participants(g), mentions: [want] })[0];
      if (!target || !botId(target)) throw fail("bad_input", `${to} is not an assistant in this chat: add it to the chat first`);
      if (target === authorOf) throw fail("bad_input", "ask a different assistant or model than the one that answered");
      const answer = mine.filter(f => f.type === "chat.text-delta" && !f.data.reasoning).map(f => String(f.data.text || "")).join("").trim();
      if (!answer) throw fail("bad_input", "that answer has no text yet");
      const first = mine[0];
      // The question: the person's message just before the answer began. The turns before it: up to six exchanges, newest last, each cut, the whole capped.
      const says = fr.filter(f => f.cur < first.cur && f.type === "chat.user-message" && f.data.enc === undefined && typeof f.data.text === "string");
      const q = says[says.length - 1];
      if (!q) throw fail("not_found", "the question this answered is not in this chat");
      const name = (/** @type {string} */ id) => g.names.get(id) || shortOf(id) || id;
      const cut = (/** @type {string} */ t, /** @type {number} */ n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
      const earlier = says.slice(-7, -1).map(f => `${name(String(f.author || "person"))}: ${cut(String(f.data.text).replace(/\s+/g, " ").trim(), 600)}`);
      const hidden = [
        `Context for your second opinion. ${name(authorOf)} was asked this and answered. Give your own answer to the question from scratch; say plainly where you differ from theirs and why. Do not just agree.`,
        earlier.length ? `Earlier in this chat:\n${earlier.join("\n")}` : "",
        `The question (${name(String(q.author || "person"))}):\n${cut(String(q.data.text), 4000)}`,
        `${name(authorOf)}'s answer:\n${cut(answer, 6000)}`,
      ].filter(Boolean).join("\n\n");
      const visible = `What does ${name(target)} make of ${name(authorOf)}'s answer?`;
      // the other assistant works where the one that answered works, so it sees the same files
      const there = g.bots.get(authorOf);
      return api.send({ chat: grp, text: visible, reply_to: message, to: [target], ...(there && there.cwd ? { cwd: there.cwd } : {}), ...(typeof i.surface === "string" ? { surface: i.surface } : {}) }, meta, hidden);
    },

    /** Keep one answer of a fan-out. @param {any} i @param {any} meta */
    keep(i, meta) {
      const grp = sessionOf(i);
      const out = logs.get(grp);
      const fo = out.read(0).find(f => f.type === "chat.fanout" && f.data.group === i.group);
      if (!fo) throw fail("not_found", "no fan-out with that group id");
      if (!fo.data.members.some((/** @type {any} */ x) => x.message === i.keep)) throw fail("bad_input", "keep is one of the group's answers");
      const author = personOf(meta, i);
      mustBeIn(grp, author);
      join(grp, author);
      const f = out.append("fanout-keep", { group: i.group, keep: i.keep }, { author, message: i.keep });
      return { session: grp, cur: f.cur, keep: i.keep };
    },

    /** The person's own marker, forward only, told to that person's other open connections. @param {any} i @param {any} meta */
    markRead(i, meta) {
      const grp = sessionOf(i);
      const person = personOf(meta, i);
      mustBeIn(grp, person);
      const upto = Number(i.upto);
      if (!Number.isInteger(upto) || upto < 0) throw fail("bad_input", "upto is a cursor");
      const f = markers.set(person, grp, upto);
      if (f) q.mark.run(person, grp, upto);
      return { session: grp, upto: markers.get(person, grp), moved: !!f };
    },

    /** One of a person's connections hears that person's read markers. @param {string} person @param {(f: any) => void} fn */
    hear: (person, fn) => markers.subscribe(person, fn),
    onEvent,

    /** Pick up where a stop left off: every assistant's thread catches up, then undelivered messages go. */
    async start() {
      for (const r of q.allMembers.all()) { const g = group(String(r.grp)); void g; }
      const ms = [...groups.values()].flatMap(g => [...g.bots.values()]).filter(m => m.thread);
      // Reopen the kernel session of every turn that was open when the daemon stopped (the seam's reopenPending). One that cannot be reopened within stream.resumeWaitSeconds is
      // given up: its pending reply is dropped and the room is told it could not resume.
      if (viaKs()) {
        const giveUp = (/** @type {string} */ thread) => { const m = byThread.get(thread); if (m && !m.dead) { m.dead = true; m.buf = new Map(); giveUpNote(m); m.running = false; m.queuedTurns = undefined; } };
        reopening = /** @type {KernelThreads} */ (ks).reopenPending({ timeoutMs: RESUME_MS, onGiveUp: giveUp }).catch(err => { log(`reopening turns: ${/** @type {Error} */ (err).message}`); }).finally(() => { reopening = null; });
      }
      await Promise.all(ms.map(catchUp));
      for (const row of q.outOpen.all()) void schedule(row);
    },
    /** An assistant's member row, so a test can stand in for its adapter (tests only). @param {string} grp @param {string} who */
    member: (grp, who) => group(grp).bots.get(who) || null,
    /** Wait for every delivery in flight (tests). */
    async idle() {
      for (let n = 0; n < 3; n++) await Promise.all([...groups.values()].flatMap(g => [...g.bots.values()].flatMap(m => [m.q, m.pq || Promise.resolve()])));
    },
    stop() { stopped = true; flush(); },
  };
  return api;
}
