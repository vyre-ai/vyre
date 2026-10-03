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
import { migrate } from "../store/index.js";
import { createAdapter } from "./adapter.js";
import { whoAnswers, mentionedIn } from "./routing.js";
import { validEnc } from "./protocol.js";
import { createReadMarkers } from "./readmarks.js";
import { cutNote } from "./reply-port.js";

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
  );`];

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
const shortOf = (/** @type {string} */ id) => id.slice(id.indexOf(":") + 1);
const botId = (/** @type {string} */ id) => id.startsWith("assistant:") || id.startsWith("model:");

/**
 * @typedef {{ who: string, name: string, thread: string|null, cwd: string|null, asker: string|null, answer: string|null, last: number,
 *   ad: ReturnType<typeof createAdapter>, msgs: Map<string, string>, held: any[]|null, q: Promise<any>, grp: string,
 *   tokens?: Map<string, { token: string, exp: number }>, tokenWaiters?: { asker: string|null, res: (t: any) => void }[], pq?: Promise<any>, buf?: Map<string, any>, refused?: Set<string>, turnVer?: number|null }} Member
 * @typedef {{ people: Set<string>, bots: Map<string, Member>, names: Map<string, string>, dflt: string|null, previous: string|null, spans: Map<string, { from: number, to: number|null }[]> }} Group
 */

/**
 * @param {{ ctx: any, logs: import("./log.js").Logs, db: any, now?: () => number, replyPort?: import("./reply-port.js").ReplyPort }} o
 */
export function createGroups({ ctx, logs, db, now = Date.now, replyPort }) {
  migrate(db, "stream-groups", MIGRATIONS);
  const markers = createReadMarkers();
  for (const r of db.prepare("SELECT person, session, upto FROM stream_groups_marks").all()) markers.set(String(r.person), String(r.session), Number(r.upto));
  /** @type {Map<string, Group>} */ const groups = new Map();
  /** @type {Map<string, Member>} */ const byThread = new Map();
  /** @type {Set<Member>} */ const dirty = new Set();
  /** @type {any} */ let timer = null;
  let stopped = false;
  const log = (/** @type {string} */ m) => { try { ctx.log(`stream: ${m}`); } catch {} };
  const holdWho = () => process.env.VYRE_STREAM_TEST_HOLD || ""; // tests only: a delivery to this member waits for the next start

  const q = {
    members: db.prepare("SELECT * FROM stream_groups_members WHERE grp = ?"),
    allMembers: db.prepare("SELECT * FROM stream_groups_members"),
    upsert: db.prepare(`INSERT INTO stream_groups_members (grp, who, thread, cwd, name, asker, answer, last_event) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(grp, who) DO UPDATE SET thread = excluded.thread, cwd = excluded.cwd, name = excluded.name, asker = excluded.asker, answer = excluded.answer`),
    last: db.prepare("UPDATE stream_groups_members SET last_event = ? WHERE grp = ? AND who = ?"),
    outAdd: db.prepare("INSERT OR IGNORE INTO stream_groups_outbox (uuid, grp, who, text, asker, answer, surface) VALUES (?,?,?,?,?,?,?)"),
    outDone: db.prepare("UPDATE stream_groups_outbox SET done = 1 WHERE uuid = ?"),
    outOpen: db.prepare("SELECT * FROM stream_groups_outbox WHERE done = 0 ORDER BY rowid"),
    mark: db.prepare("INSERT INTO stream_groups_marks (person, session, upto) VALUES (?,?,?) ON CONFLICT(person, session) DO UPDATE SET upto = excluded.upto"),
  };

  /** @param {any} r @returns {Member} */
  const memberOf = r => ({ grp: String(r.grp), who: String(r.who), name: String(r.name || shortOf(String(r.who))), thread: r.thread ? String(r.thread) : null, cwd: r.cwd ? String(r.cwd) : null,
    asker: r.asker ? String(r.asker) : null, answer: r.answer ? String(r.answer) : null, last: Number(r.last_event || 0), ad: createAdapter(), msgs: new Map(), held: null, q: Promise.resolve(), });
  const save = (/** @type {Member} */ m) => q.upsert.run(m.grp, m.who, m.thread, m.cwd, m.name, m.asker, m.answer, m.last);

  // ---- the kernel's chat (ctx.kernel on): tokens with the chat in them, and chats.append ------------------

  /** Is this daemon running with the kernel? Then every chat is the kernel's and the 0.2 paths are closed. */
  const kernelOn = () => Boolean(ctx.kernel && ctx.kernel.chats && typeof ctx.kernel.chats.append === "function" && typeof ctx.kernel.for === "function");
  const TOKEN_MS = 24 * 3600_000;
  /** What a call's own chain gave mirror(): the person's chain (exactly one person) and who it is. @type {WeakMap<object, { chain: any, person: string }>} */
  const kcalls = new WeakMap();
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
  /** A token for the member's turn: the one for the person it is answering, now, or when that person next acts (a restart forgets tokens). @param {Member} m */
  const tokenOf = m => {
    const t = m.asker ? (m.tokens || new Map()).get(m.asker) : null;
    return t && t.exp - 5000 > now() ? Promise.resolve(t) : new Promise(res => { (m.tokenWaiters ||= []).push({ asker: m.asker, res }); });
  };
  /** @param {Member} m @param {string} asker @param {{ token: string, exp: number }} t */
  function giveToken(m, asker, t) {
    (m.tokens ||= new Map()).set(asker, t);
    const w = m.tokenWaiters || [];
    m.tokenWaiters = w.filter(x => x.asker !== asker);
    for (const x of w) if (x.asker === asker) x.res(t);
  }

  /** The kernel's list into this group, never the other way: whoever the kernel lists and the group lacks joins, whoever the group holds and the kernel no longer lists leaves. @param {string} grp @param {{ people: string[], assistants?: string[] }} chat */
  function adopt(grp, chat) {
    const g = group(grp);
    const wantPeople = new Set(chat.people.map(p => `person:${p}`));
    const wantBots = new Set((chat.assistants || []).map(a => `assistant:${a}`));
    for (const p of wantPeople) if (!g.people.has(p)) join(grp, p);
    for (const b of wantBots) if (!g.bots.has(b)) join(grp, b);
    for (const p of [...g.people]) if (!wantPeople.has(p)) { g.people.delete(p); g.names.delete(p); closeSpan(g, p, logs.get(grp).append("participant-left", { who: p }).cur); }
    for (const [b, m] of [...g.bots]) if (!wantBots.has(b)) { g.bots.delete(b); g.names.delete(b); if (m.thread) byThread.delete(m.thread); m.tokens = new Map(); closeSpan(g, b, logs.get(grp).append("participant-left", { who: b }).cur); }
    if (g.dflt && !g.bots.has(g.dflt)) g.dflt = null;
    return g;
  }

  /**
   * The stand-in reply port (see reply-port.js for the swap point). Open reads the kernel's list with the asker's own session (so the stamp, the group log's head, is the
   * kernel's truth now; a refusal here is the reply's refusal), writes nothing while streaming (the frames are the stream's), and hands the whole text to chats.append at close.
   * A participant was in the chat at a cursor when a joined frame is at or before it and no left frame is.
   * @type {import("./reply-port.js").ReplyPort}
   */
  const mirrorPort = {
    sync: async (grp, token) => {
      const k = ctx.kernel;
      const chain = await k.chain({ token });
      const chat = await k.chats.read(chain, grp);
      adopt(grp, { people: [...chat.people], assistants: [...(chat.assistants || [])] });
    },
    stamp: grp => logs.get(grp).head,
    open: async ({ grp, token }) => {
      await mirrorPort.sync?.(grp, token);
      return { ver: logs.get(grp).head, write: () => {}, close: final => append(token, { text: final.text, ...(final.blocks && final.blocks.length ? { blocks: final.blocks } : {}) }).then(() => {}) };
    },
    mayReceive: (grp, person, ver, cur) => { const g = group(grp); return inAt(g, person, ver) && inAt(g, person, cur); },
  };
  const port = replyPort || mirrorPort;
  /** How often a streaming reply asks the port to refresh its view of the chat (the stand-in reads the kernel's list; a kernel port has nothing to do). */
  const SYNC_MS = 500;

  /** The group's state, read from its log (who is in, who spoke last) and the member table (threads). @param {string} grp */
  function group(grp) {
    let g = groups.get(grp);
    if (g) return g;
    g = { people: new Set(), bots: new Map(), names: new Map(), dflt: null, previous: null, spans: new Map() };
    groups.set(grp, g);
    for (const r of q.members.all(grp)) { const m = memberOf(r); g.bots.set(m.who, m); g.names.set(m.who, m.name); if (m.thread) byThread.set(m.thread, m); }
    for (const f of logs.get(grp).read(0)) {
      const d = f.data || {};
      if (f.type === "session.participant-joined") {
        if (d.name) g.names.set(d.who, d.name);
        if (d.who.startsWith("person:")) g.people.add(d.who);
        if (d.role === "default") g.dflt = d.who;
        openSpan(g, d.who, f.cur);
      } else if (f.type === "session.participant-left") { g.people.delete(d.who); g.bots.delete(d.who); closeSpan(g, d.who, f.cur); }
      if (f.author && (f.type === "session.user-message" || f.type === "session.text-delta")) g.previous = f.author;
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
  const sessionOf = (/** @type {any} */ i) => { const s = String(i.session || ""); if (!ID.test(s)) throw fail("bad_input", "session must be a group id"); return s; };

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
      write(m, s, data, message);
    }
  }

  // ---- kernel on: a reply is written once the kernel took it -----------------------------------------

  /**
   * Everything an assistant does goes through the member's queue, in order. Its words stream: the first non-reasoning delta opens the reply through the port (one
   * open per message, under the assistant's token for the asker), which stamps it with the chat's membership version; each delta is written as it comes with
   * that stamp (`data.ver`), and text-done closes it. Reasoning before the reply waits for it to open. A refusal (the assistant was removed, the asker left, the chat
   * is gone) at open shows nothing; one later cuts the reply where it is (text-cut). Nothing is held until the message is whole.
   * @param {Member} m @param {any[]} specs
   */
  function projectKernel(m, specs) {
    m.pq = (m.pq || Promise.resolve()).then(async () => {
      for (const s of specs) {
        if (SKIP.has(s.kind)) continue;
        if (s.kind === "text-delta" || s.kind === "text-done") await reply(m, s); else activity(m, s);
      }
    }).catch(err => { log(`projecting ${m.who} in ${m.grp}: ${/** @type {Error} */ (err).message}`); });
  }

  /** Not a message: tools, asks, files, status. Written in order behind the replies before them, stamped with the turn's membership version so someone who joined mid-turn does not get them. @param {Member} m @param {any} s */
  function activity(m, s) {
    // The turn is over for words that never became a reply (reasoning only): they are released as they were.
    if (s.kind === "status" && s.data && s.data.state !== "working") {
      for (const [id, b] of [...(m.buf || [])]) if (!b.h) { for (const it of b.items) write(m, it, { ...it.data, ver: b.ver }, id); m.buf.delete(id); }
      m.turnVer = null;
    }
    if (carriesFieldValue(s.data) && group(m.grp).people.size > 1) { log(`${s.kind} for ${m.who} in ${m.grp}: dropped, it carried a field value (cite it as a field-ref)`); return; }
    if (s.kind === "status") { write(m, s, s.data); return; }
    if (m.turnVer == null) m.turnVer = port.stamp(m.grp);
    write(m, s, { ...s.data, ver: m.turnVer });
  }

  /**
   * Open the reply: the port stamps it, the reasoning that waited is written with the stamp. False when the kernel refused (nothing was shown). @param {Member} m @param {any} b @param {string} message
   */
  async function begin(m, b, message) {
    const t = await tokenOf(m);
    try { b.h = await port.open({ grp: m.grp, token: t.token, message }); }
    catch (err) {
      /** @type {Set<string>} */ (m.refused).add(message); /** @type {Map<string, any>} */ (m.buf).delete(message);
      log(`${m.who} in ${m.grp}: the kernel refused the reply (${/** @type {any} */ (err).code || "error"}); nothing was shown`);
      return false;
    }
    b.token = t.token; b.lastSync = now();
    if (m.turnVer == null || m.turnVer > b.h.ver) m.turnVer = b.h.ver;
    for (const it of b.items) write(m, it, { ...it.data, ver: b.h.ver }, message);
    b.items = [];
    return true;
  }

  /** The kernel took its word back while the reply streamed: it stops where it is, the people who had it see it cut. @param {Member} m @param {any} b @param {string} message @param {any} s @param {any} err */
  function withdraw(m, b, message, s, err) {
    /** @type {Set<string>} */ (m.refused).add(message); /** @type {Map<string, any>} */ (m.buf).delete(message);
    log(`${m.who} in ${m.grp}: the kernel refused the rest of the reply (${/** @type {any} */ (err).code || "error"}); it was cut`);
    write(m, { kind: "text-cut", turn: s.turn }, { ...cutNote(message), ver: b.h.ver }, message);
  }

  /** @param {Member} m @param {any} s a text-delta or text-done */
  async function reply(m, s) {
    const m0 = m.buf || (m.buf = new Map()), refused = m.refused || (m.refused = new Set());
    const message = m.answer ? answerId(m, String(s.data.message)) : String(s.data.message);
    if (refused.has(message)) return;
    let b = m0.get(message);
    if (!b) { b = { items: [], reply: "", h: null, ver: port.stamp(m.grp), token: "", lastSync: 0 }; m0.set(message, b); }
    if (s.kind === "text-delta") {
      if (s.data.reasoning) {
        if (b.h) write(m, s, { ...s.data, message, ver: b.h.ver }, message); else b.items.push({ ...s, data: { ...s.data, message } }); // thinking waits for the reply to open
        return;
      }
      if (!b.h && !(await begin(m, b, message))) return;
      // A kernel port follows the room itself; the stand-in reads the kernel's list now and then, so a person who left stops receiving.
      if (port.sync && now() - b.lastSync >= SYNC_MS) { b.lastSync = now(); try { await port.sync(m.grp, b.token); if (!group(m.grp).bots.has(m.who)) throw Object.assign(new Error("the assistant is no longer in the chat"), { code: "denied" }); } catch (err) { if (["not_found", "denied", "forbidden"].includes(/** @type {any} */ (err).code)) { withdraw(m, b, message, s, err); return; } } }
      const text = String(s.data.text);
      try { await b.h.write(text); } catch (err) { withdraw(m, b, message, s, err); return; }
      b.reply += text;
      write(m, s, { ...s.data, message, ver: b.h.ver }, message);
      return;
    }
    let blocks = Array.isArray(s.data.blocks) ? s.data.blocks : [];
    if (!b.h && !b.reply && blocks.length === 0) { b.items.push({ ...s, data: { ...s.data, message } }); return; } // reasoning so far: held until the turn ends
    // A room of more than one person (the kernel's own list, mirrored here): the reply never carries a field value, it cites it as a field-ref, drawn per viewer.
    if (group(m.grp).people.size > 1 && blocks.some((/** @type {any} */ x) => x && x.block === "field" && x.placeholder !== true)) {
      log(`text-done for ${m.who} in ${m.grp}: a field value was dropped (cite it as a field-ref)`);
      blocks = blocks.filter((/** @type {any} */ x) => !(x && x.block === "field" && x.placeholder !== true));
    }
    if (!b.h && !(await begin(m, b, message))) return;
    const done = { ...s.data, message, ...(blocks.length ? { blocks } : {}), ver: b.h.ver };
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

  // ---- delivery -----------------------------------------------------------------------------------

  /** @param {any} row */
  async function deliver(row) {
    const g = group(String(row.grp));
    const m = g.bots.get(String(row.who));
    if (!m) { q.outDone.run(row.uuid); return; }
    if (holdWho() === m.who) return; // tests only
    m.asker = String(row.asker); m.answer = String(row.answer); m.msgs = new Map();
    save(m);
    const surface = row.surface ? String(row.surface) : "deck";
    if (!m.thread) {
      if (!m.cwd) throw fail("bad_input", `${m.who} has no folder to work in: name its cwd when it joins`);
      const r = await ctx.call("threads.start", { cwd: m.cwd, prompt: String(row.text), surface });
      if (r.error) throw fail(r.error.code || "failed", r.error.message);
      m.thread = String(r.data.id);
      save(m);
      await catchUp(m);
    } else {
      byThread.set(m.thread, m);
      const r = await ctx.call("threads.send", { thread: m.thread, text: String(row.text), surface, uuid: String(row.uuid) });
      if (r.error) throw fail(r.error.code || "failed", r.error.message);
    }
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

  /** @param {any} i @param {any} meta */
  async function sendOnce(i, meta) {
    {
      const grp = sessionOf(i);
      const author = personOf(meta, i);
      mustBeIn(grp, author);
      // A private message (enc, an opaque ciphertext made on the person's device): stored and relayed as it is, never parsed, routed to
      // no assistant, mentioned to nobody. The home does not hold its words.
      if (i.enc !== undefined) {
        if (i.text !== undefined && String(i.text) !== "") throw fail("bad_input", "a private message carries enc and no text");
        if (!validEnc(i.enc)) throw fail("bad_input", "enc is { alg, kid, ct }, three strings");
        const message = typeof i.message === "string" && ID.test(i.message) ? i.message : crypto.randomUUID();
        const out = logs.get(grp);
        join(grp, author, { name: typeof i.name === "string" ? i.name : undefined });
        const had = out.read(0).find(f => f.type === "session.user-message" && f.data.message === message);
        if (!had && kernelOn()) await append((await personSession(meta, grp, author)).token, { enc: { alg: i.enc.alg, kid: i.enc.kid, ct: i.enc.ct } }, "private");
        if (!had) { out.append("user-message", { message, enc: { alg: i.enc.alg, kid: i.enc.kid, ct: i.enc.ct }, state: "sent" }, { author, message }); group(grp).previous = author; }
        return { session: grp, message, private: true, routed: [], answers: [], ...(had ? { duplicate: true } : {}) };
      }
      const text = String(i.text ?? "").trim();
      if (!text) throw fail("bad_input", "text is empty");
      if (text.length > 20000) throw fail("bad_input", "text is too long");
      const message = typeof i.message === "string" && ID.test(i.message) ? i.message : crypto.randomUUID();
      const out = logs.get(grp);
      const g = group(grp);
      // A repeat of a message this group already holds: nothing is appended again; any delivery not yet taken is retried.
      const had = out.read(0).find(f => f.type === "session.user-message" && f.data.message === message);
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
        const fo = out.read(0).find(f => f.type === "session.fanout" && f.data.message === message);
        const answers = rows.map(r => ({ who: String(r.who), message: String(r.answer) }));
        return { session: grp, message, duplicate: true, ...(fo ? { group: fo.data.group, answers: fo.data.members } : { answers }) };
      }
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
        if (m && !m.thread && !m.cwd && !cwd) throw fail("bad_input", `${id} has no folder to work in: pass cwd`);
      }

      // Kernel on: the kernel takes the words first (a person's own token, with the chat in it), and a session token for each assistant that will answer
      // (its replies are appended under it). A refusal here is the send's refusal: nothing is stored.
      /** @type {string|undefined} */ let kid;
      if (kernelOn()) {
        const mine = await personSession(meta, grp, author);
        const bots = [];
        for (const id of to) { const m = g.bots.get(id); const k = kcalls.get(meta); if (m && k) bots.push([m, await sessionFor(k.chain, grp, author, shortOf(id))]); }
        kid = String((await append(mine.token, { text })).id);
        for (const [m, t] of bots) giveToken(/** @type {Member} */ (m), author, /** @type {any} */ (t));
      }
      out.append("user-message", { message, text, state: "sent", ...(kid ? { kid } : {}) }, { author, message });
      if (mentions.length) out.append("mention", { message, who: mentions }, { author, message });
      g.previous = author;
      const answers = to.map(who => ({ who, message: `${message}.${g.names.get(who) || shortOf(who)}` }));
      let groupId;
      if (answers.length >= 2) { groupId = typeof i.group === "string" && ID.test(i.group) ? i.group : `g.${message}`; out.append("fanout", { group: groupId, message, members: answers }, { author, message }); }
      const surface = typeof i.surface === "string" ? i.surface : "deck";
      const rows = answers.map(a => {
        const row = { uuid: uuidOf(`${message}|${a.who}`), grp, who: a.who, text, asker: author, answer: a.message, surface };
        const m = g.bots.get(a.who); if (m && !m.cwd && cwd) { m.cwd = cwd; save(m); }
        q.outAdd.run(row.uuid, grp, row.who, row.text, row.asker, row.answer, row.surface);
        return row;
      });
      for (const r of rows) void schedule(r);
      return { session: grp, message, routed: to, answers, ...(groupId ? { group: groupId } : {}) };
    }
  }

  return {
    markers,
    person: personOf,
    /** Does a group by this id exist here (in memory or stored)? Creates nothing. @param {string} grp */
    known: grp => groups.has(grp) || logs.known(grp),
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
      for (const m of g.bots.values()) if (m.asker === person && ((m.tokens || new Map()).get(person) || { exp: 0 }).exp - 5000 <= now()) {
        try { giveToken(m, person, await sessionFor(chain, grp, person, shortOf(m.who))); } catch (err) { log(`session for ${m.who} in ${grp}: ${/** @type {any} */ (err).code || "error"}`); }
      }
    },

    /**
     * Who may receive and from where, for a viewer of a group chat (kernel on): `may(frame)` asks the reply port (never decides here), `floor` is the cursor of the
     * viewer's own join (they see the chat from then). @param {string} grp @param {string} person
     */
    viewerFor(grp, person) {
      const g = group(grp);
      const l = g.spans.get(person) || [];
      const floor = l.length ? l[l.length - 1].from : 0;
      return { may: (/** @type {any} */ f) => { const v = f && f.data && f.data.ver; return !Number.isInteger(v) || port.mayReceive(grp, person, v, Number(f.cur)); }, floor };
    },

    /** One send at a time per message id: a retry that arrives while the first is still being written to the kernel waits and then finds it done. @param {any} i @param {any} meta */
    async send(i, meta) {
      const grp = sessionOf(i);
      const key = typeof i.message === "string" && ID.test(i.message) ? `${grp}|${i.message}` : null;
      if (!key) return sendOnce(i, meta);
      const before = inflight.get(key) || Promise.resolve();
      const run = before.catch(() => {}).then(() => sendOnce(i, meta));
      inflight.set(key, run);
      try { return await run; } finally { if (inflight.get(key) === run) inflight.delete(key); }
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

    /** Keep one answer of a fan-out. @param {any} i @param {any} meta */
    keep(i, meta) {
      const grp = sessionOf(i);
      const out = logs.get(grp);
      const fo = out.read(0).find(f => f.type === "session.fanout" && f.data.group === i.group);
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
}
