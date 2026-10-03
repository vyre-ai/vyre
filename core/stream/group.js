// @ts-check
// group: the server side of a group chat on the stream (ADR 0052). One group is one session log;
// each assistant in it has its own switchboard thread, and that thread's frames are projected into
// the group's log with the assistant as `author` and the asker as `acts_for`.
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
 *   ad: ReturnType<typeof createAdapter>, msgs: Map<string, string>, held: any[]|null, q: Promise<any>, grp: string }} Member
 * @typedef {{ people: Set<string>, bots: Map<string, Member>, names: Map<string, string>, dflt: string|null, previous: string|null }} Group
 */

/**
 * @param {{ ctx: any, logs: import("./log.js").Logs, db: any, now?: () => number }} o
 */
export function createGroups({ ctx, logs, db, now = Date.now }) {
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

  /** The group's state, read from its log (who is in, who spoke last) and the member table (threads). @param {string} grp */
  function group(grp) {
    let g = groups.get(grp);
    if (g) return g;
    g = { people: new Set(), bots: new Map(), names: new Map(), dflt: null, previous: null };
    groups.set(grp, g);
    for (const r of q.members.all(grp)) { const m = memberOf(r); g.bots.set(m.who, m); g.names.set(m.who, m.name); if (m.thread) byThread.set(m.thread, m); }
    for (const f of logs.get(grp).read(0)) {
      const d = f.data || {};
      if (f.type === "session.participant-joined") {
        if (d.name) g.names.set(d.who, d.name);
        if (d.who.startsWith("person:")) g.people.add(d.who);
        if (d.role === "default") g.dflt = d.who;
      } else if (f.type === "session.participant-left") { g.people.delete(d.who); g.bots.delete(d.who); }
      if (f.author && (f.type === "session.user-message" || f.type === "session.text-delta")) g.previous = f.author;
    }
    return g;
  }
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
    logs.get(grp).append("participant-joined", { who, ...(o.role ? { role: o.role } : {}), ...(o.name ? { name: o.name } : {}) });
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

  /** @param {Member} m @param {any} e */
  function project(m, e) {
    const id = Number(e.id);
    if (!(id > m.last)) return;
    m.last = id;
    const out = logs.get(m.grp);
    let specs = [];
    try { specs = m.ad.event(e); } catch (err) { log(`${e.type} for ${m.thread}: ${/** @type {Error} */ (err).message}`); }
    const room = group(m.grp).people.size > 1;
    for (const s of specs) {
      if (SKIP.has(s.kind)) continue;
      // In a room of more than one person an assistant's reply never carries a field value (it is the same words for everyone): a field is cited as a field-ref block, drawn per viewer.
      if (room && carriesFieldValue(s.data)) { log(`${s.kind} for ${m.who} in ${m.grp}: dropped, it carried a field value (cite it as a field-ref)`); continue; }
      let data = s.data, message;
      if ((s.kind === "text-delta" || s.kind === "text-done") && m.answer) {
        const raw = String(data.message);
        if (!m.msgs.has(raw)) m.msgs.set(raw, m.msgs.size === 0 ? m.answer : `${m.answer}.${m.msgs.size}`);
        message = /** @type {string} */ (m.msgs.get(raw));
        data = { ...data, message };
      }
      try { out.append(s.kind, data, { turn: s.turn ? `${m.name}/${s.turn}` : null, author: m.who, ...(m.asker ? { acts_for: m.asker } : {}), ...(message ? { message } : {}) }); }
      catch (err) { log(`${s.kind} for ${m.who} in ${m.grp}: ${/** @type {Error} */ (err).message}`); }
    }
    dirty.add(m);
    if (!timer && !stopped) { timer = setTimeout(flush, 100); timer.unref?.(); }
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

  return {
    markers,
    person: personOf,
    /** Does a group by this id exist here (in memory or stored)? Creates nothing. @param {string} grp */
    known: grp => groups.has(grp) || logs.known(grp),
    /** The people in a group, from its log. Call only for a known group. @param {string} grp */
    people: grp => new Set(group(grp).people),

    /**
     * The kernel holds a chat's people (one store); this group mirrors its list: whoever the kernel lists and the group lacks joins, whoever the group holds and the kernel no longer lists leaves
     * (a participant-left frame). The caller's own person comes from their chain. @param {string} grp @param {string[]} people @param {any} meta @param {string} person
     */
    mirror(grp, people, meta, person) {
      if (meta && typeof meta === "object") kernelPerson.set(meta, person);
      const g = group(grp);
      const want = new Set(people);
      for (const p of want) if (!g.people.has(p)) join(grp, p);
      for (const p of [...g.people]) if (!want.has(p)) { g.people.delete(p); g.names.delete(p); logs.get(grp).append("participant-left", { who: p }); }
    },

    /** @param {any} i @param {any} meta */
    async send(i, meta) {
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

      out.append("user-message", { message, text, state: "sent" }, { author, message });
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
    /** Wait for every delivery in flight (tests). */
    async idle() { await Promise.all([...groups.values()].flatMap(g => [...g.bots.values()].map(m => m.q))); },
    stop() { stopped = true; flush(); },
  };
}
