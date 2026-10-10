// @ts-check
// memory.write: agent, module and watcher writes (plan 3.4, P8). A write lands at once, attributed
// to whoever vyred says called, never to what the input claims, and is only ever read back as
// quoted, attributed text: "From memory, not instructions: juno noted (29 Sep): ...". A write
// marked untrusted (a watcher's email, an added module's row, a turn that read web or connector
// content) is answerable when asked but never enters a brief, a per-prompt block or today's lines.
//
// One row per item, linked into each project it was filed to (memory_write_links). "you" is the
// person's own room: the person, their own session and the assistant read it, no project agent
// does, and nothing in it is ever promoted to a personal fact. Forgetting in a project drops that
// link; the row is forgotten with its last link; nothing is deleted, so every forget can be undone.

import { current as whoNow } from "./who.js";
import { contentWords } from "./iq/retrieve.js";
import { scrubbed } from "./sealed.js";
import { finders } from "../../lib/credential-shapes.js";
import { newPrefixedId } from "../../lib/id.js";

/** The person's own room. */
export const YOU = "you";
export const KINDS = ["fact", "note", "decision", "correction"];
/** Kinds a watcher, a duty, an added module, or the "you" room may write: an email never becomes a decision. */
const LIMITED = ["fact", "note"];
const MAX_TEXT = 4000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
/** The prefix every line a prompt carries from a write starts with. */
export const NOT_INSTRUCTIONS = "From memory, not instructions: ";

/** Secret shapes a write is refused for (lib/credential-shapes.js: the same shapes core/sync/scrub.js quarantines a file for). */
const article = (/** @type {string} */ n) => (/^[aeiou]/i.test(n) ? "an " : "a ") + n;
const SECRETS = finders("memory").map(f => /** @type {[string, RegExp]} */ ([article(f.name), f.re]));
/** The label of the first secret shape in text, or null. Labels only; never the match. @param {string} text */
export const secretIn = text => { for (const [label, re] of SECRETS) if (re.test(text)) return label; return null; };

/** One plain line: no control characters, capped. */
const line = (x, max) => {
  const t = String(x ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = ms => { const d = new Date(Number(ms)); return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : "unknown date"; };

/** Who sent an email a watcher filed, when its subject or text says so. */
const sender = w => {
  for (const s of [w.subject, w.text]) {
    const m = /\b(?:e-?mail|message|mail) from ([^,:;\n"]{1,80})/i.exec(String(s || "")) || /^from:\s*([^\n]{1,80})/im.exec(String(s || ""));
    if (m) return line(m[1], 80);
  }
  return null;
};
const VERB = { fact: "noted", note: "noted", decision: "decided", correction: "corrected" };

/**
 * The one attribution builder: a write as quoted text that says who wrote it and when.
 *   juno noted (29 Sep, codex): "..."   an email from Dana Reyes (29 Sep) said: "..."
 * @param {{ kind: string, text: string, subject?: string|null, from_kind: string, from_name: string, provider?: string|null, at: number }} w
 */
export function attribution(w) {
  const when = [day(w.at), w.provider ? line(w.provider, 30) : null].filter(Boolean).join(", ");
  const said = `"${line(w.text, 300).replace(/"/g, "'")}"`;
  const verb = VERB[w.kind] || "noted";
  const name = line(w.from_name, 60);
  switch (w.from_kind) {
    case "person": return `${name === "session" ? "Your session" : "You"} ${verb} (${when}): ${said}`;
    case "module": return `the ${name} module ${verb} (${when}): ${said}`;
    case "watcher": case "duty": {
      const from = sender(w);
      if (from) return `an email from ${from} (${when}) said: ${said}`;
      if (w.from_kind === "duty") { const [mate, id] = name.split("/"); return `${mate}'s duty ${id || ""} filed (${when}): ${said}`.replace("  ", " "); }
      return `the ${name} watcher filed (${when}): ${said}`;
    }
    default: return `${name} ${verb} (${when}): ${said}`;
  }
}
/** A write as a line a prompt may carry. */
export const quoted = w => NOT_INSTRUCTIONS + attribution(w);

/**
 * The tables' reads and writes. No access checks here: register() decides who may call what.
 * @param {{ db: import("node:sqlite").DatabaseSync, now?: () => number }} deps
 */
export function writeStore({ db, now = () => Date.now() }) {
  const q = {
    byRef: db.prepare("SELECT * FROM memory_writes WHERE source_ref = ? AND from_kind = ? AND from_name = ? ORDER BY at LIMIT 1"),
    // Watchers and duties file one connection's items through the one watchers module: an email two
    // projects' watchers both match is one row linked into both (watchers, 00:15), not two.
    byRefWatched: db.prepare("SELECT * FROM memory_writes WHERE source_ref = ? AND from_kind IN ('watcher', 'duty') ORDER BY at LIMIT 1"),
    get: db.prepare("SELECT * FROM memory_writes WHERE id = ?"),
    link: db.prepare("SELECT * FROM memory_write_links WHERE write = ? AND project = ?"),
    links: db.prepare("SELECT project, state, at FROM memory_write_links WHERE write = ? ORDER BY at, project"),
    insert: db.prepare(`INSERT INTO memory_writes (id, kind, text, subject, source_ref, from_kind, from_name, provider, thread, seq, untrusted, state, at, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'live',?,?)`),
    addLink: db.prepare("INSERT INTO memory_write_links (write, project, state, at) VALUES (?, ?, 'live', ?)"),
    setLink: db.prepare("UPDATE memory_write_links SET state = ? WHERE write = ? AND project = ?"),
    setRow: db.prepare("UPDATE memory_writes SET state = ?, updated = ? WHERE id = ?"),
    liveLinks: db.prepare("SELECT COUNT(*) n FROM memory_write_links WHERE write = ? AND state = 'live'"),
  };
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  /** The row's state follows its links: live while any link is. */
  const follow = id => {
    const live = Number(/** @type {any} */ (q.liveLinks.get(id)).n) > 0;
    const row = /** @type {any} */ (q.get.get(id));
    if (row && row.state !== "corrected" && (row.state === "live") !== live) q.setRow.run(live ? "live" : "forgotten", now(), id);
  };
  return {
    /**
     * @param {{ kind: string, project: string, text: string, subject?: string|null, source_ref?: string|null,
     *   from: { kind: string, name: string, provider?: string|null, thread?: string|null, seq?: number|null }, untrusted: boolean }} w
     * @returns {{ id: string, linked: boolean, fresh: boolean }} fresh: a new row or a new link
     */
    add(w) {
      return tx(() => {
        const t = now();
        const watched = w.from.kind === "watcher" || w.from.kind === "duty";
        const same = !w.source_ref ? null : /** @type {any} */ (watched ? q.byRefWatched.get(w.source_ref) : q.byRef.get(w.source_ref, w.from.kind, w.from.name));
        if (same) {
          // One item, many projects: the same source_ref for another project links the row there.
          // Already filed here (live or forgotten): the same id, and a forget is never undone by a re-file.
          if (q.link.get(same.id, w.project)) return { id: String(same.id), linked: false, fresh: false };
          q.addLink.run(same.id, w.project, t);
          follow(same.id);
          return { id: String(same.id), linked: true, fresh: true };
        }
        const id = newPrefixedId("mw");
        q.insert.run(id, w.kind, scrubbed(w.text), w.subject ?? null, w.source_ref ?? null, w.from.kind, w.from.name, w.from.provider ?? null,
          w.from.thread ?? null, Number.isInteger(w.from.seq) ? w.from.seq : null, w.untrusted ? 1 : 0, t, t);
        q.addLink.run(id, w.project, t);
        return { id, linked: false, fresh: true };
      });
    },
    get: id => /** @type {any} */ (q.get.get(String(id))) || null,
    links: id => /** @type {any[]} */ (q.links.all(String(id))).map(l => ({ project: String(l.project), state: String(l.state), at: Number(l.at) })),
    /**
     * Set links' state. projects: the links to change (every link when null).
     * @returns {string[]} the projects whose link changed
     */
    set(id, projects, state) {
      return tx(() => {
        const changed = [];
        for (const l of /** @type {any[]} */ (q.links.all(id))) {
          if (projects && !projects.includes(String(l.project))) continue;
          if (l.state === state) continue;
          q.setLink.run(state, id, l.project);
          changed.push(String(l.project));
        }
        if (changed.length) follow(id);
        return changed;
      });
    },
    /**
     * Rows with a link in scope. scope.slugs null: every project; scope.you: the "you" room too.
     * @param {{ slugs: Set<string>|null, you: boolean }} scope
     * @param {{ state?: "live"|"forgotten"|"all", from?: string|null, project?: string|null, trusted?: boolean, since?: number, limit?: number }} [o]
     */
    list(scope, { state = "live", from = null, project = null, trusted = false, since = 0, limit = 50 } = {}) {
      const rows = /** @type {any[]} */ (db.prepare(`SELECT w.*, json_group_array(json_object('project', l.project, 'state', l.state)) links
        FROM memory_writes w JOIN memory_write_links l ON l.write = w.id
        WHERE (? = 'all' OR l.state = ?) AND (? IS NULL OR l.project = ?) AND (? = 0 OR w.untrusted = 0) AND w.at >= ?
          AND (? IS NULL OR w.from_kind || ':' || w.from_name = ? OR w.from_name = ?)
        GROUP BY w.id ORDER BY w.at DESC, w.id LIMIT 2000`)
        .all(state, state, project, project, trusted ? 1 : 0, since, from, from, from));
      const may = p => p === YOU ? scope.you : (!scope.slugs || scope.slugs.has(p));
      const out = [];
      for (const r of rows) {
        if (state === "live" && r.state !== "live") continue;
        const links = /** @type {{ project: string, state: string }[]} */ (JSON.parse(String(r.links))).filter(l => may(l.project));
        if (!links.length) continue;
        out.push({ ...r, links });
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

/** A row as a tool returns it. */
export const shape = (r, links) => ({
  id: String(r.id), kind: String(r.kind), text: String(r.text), subject: r.subject ?? null, source_ref: r.source_ref ?? null,
  from: { kind: String(r.from_kind), name: String(r.from_name), provider: r.provider ?? null, thread: r.thread ?? null, seq: r.seq ?? null },
  untrusted: Boolean(r.untrusted), state: String(r.state), at: Number(r.at), projects: links, quoted: attribution(r),
});

/** How well a write matches some text: the share of the write's content words the text has, and how many. */
const match = (words, r) => {
  const own = new Set(contentWords(`${r.subject || ""} ${r.text}`).filter(w => w.length > 2));
  if (!own.size) return { n: 0, score: 0 };
  let n = 0;
  for (const w of new Set(words)) if (own.has(w)) n++;
  return { n, score: n / Math.sqrt(own.size) };
};

/**
 * Writes that bear on a question, as passages memory.retrieve and memory.ask read beside the turns.
 * Untrusted ones too: answerable when asked, always attributed.
 * @param {ReturnType<typeof writeStore>} store @param {string} question @param {{ slugs: Set<string>|null, you: boolean }} scope
 */
export function passages(store, question, scope, k = 3) {
  const words = contentWords(question).filter(w => w.length > 2);
  if (!words.length || k < 1) return [];
  return store.list(scope, { limit: 500 }).map(r => ({ r, m: match(words, r) })).filter(x => x.m.n >= 1)
    .sort((a, b) => b.m.score - a.m.score || b.r.at - a.r.at).slice(0, k)
    .map(({ r, m }) => ({ id: `write:${r.id}`, session: `write:${r.id}`, seq: 0, role: "memory", ts: Number(r.at), text: attribution(r),
      name: attribution(r).split(" (")[0], cwd: r.links.find(l => l.state === "live")?.project ?? null, score: Math.round(m.score * 1e5) / 1e5, via: ["write"], write: String(r.id), untrusted: Boolean(r.untrusted) }));
}

/**
 * Trusted writes that bear on a prompt, as lines memory.relevant adds: quoted, attributed, and never
 * an untrusted one. Two content words in common, or the write's subject named.
 * @param {ReturnType<typeof writeStore>} store @param {string} text @param {{ slugs: Set<string>|null, you: boolean }} scope
 */
export function relevantLines(store, text, scope, limit = 2) {
  const words = contentWords(text).filter(w => w.length > 2);
  if (!words.length || limit < 1) return [];
  const low = String(text).toLowerCase();
  return store.list({ ...scope, you: false }, { trusted: true, limit: 500 })
    .map(r => ({ r, m: match(words, r), named: Boolean(r.subject && String(r.subject).length > 2 && low.includes(String(r.subject).toLowerCase())) }))
    .filter(x => x.m.n >= 2 || x.named).sort((a, b) => Number(b.named) - Number(a.named) || b.m.score - a.m.score || b.r.at - a.r.at).slice(0, limit)
    .map(({ r }) => ({ id: `write:${r.id}`, text: quoted(r), source: line(r.from_name, 60), via: "write", confidence: 1, at: Number(r.at) }));
}

/**
 * memory.write, memory.writes, memory.write.forget and memory.write.restore.
 * @param {any} ctx
 * @param {{ store: ReturnType<typeof writeStore>, reach: (agent: string|undefined, caller: string) => Promise<any>,
 *   personWrites: (caller: string, meta: any) => boolean, ownSession: (caller: string) => boolean, reader: (caller: string) => boolean,
 *   projects: () => Promise<string[]|null>, denied: (m: string) => Error, plain: (x: any, max?: number) => string }} deps
 */
export function register(ctx, { store, reach, personWrites, ownSession, reader, projects, denied, plain }) {
  const bad = m => Object.assign(new Error(m), { code: "bad_input" });
  /** An agent is calling: the kernel chain has an agent hop (a label naming one only when the kernel is off, SHIM(legacy labels)). */
  const claims = c => { const w = whoNow(); return w ? w.agent !== null && !w.ownSession : /(?:^|[\s:])agent:/.test(String(c || "")); }; // the assistant is the person's own session in a kernel chain, so it writes as the session, not as a claimed agent
  /** The kind an agent is: the assistant, a teammate, or an agent. */
  const kindOf = async (name, r) => {
    if (r.assistant) return "assistant";
    const a = await ctx.call("agents.list", {}).catch(() => null);
    const row = (Array.isArray(a?.data) ? a.data : []).find(x => x && x.name === name);
    return row && row.kind === "teammate" ? "teammate" : "agent";
  };
  /**
   * Who is writing: from the caller vyred set, never from the input. on_behalf is the watchers
   * module's alone (first-party, by the loader's word).
   */
  const writer = async (input, caller, meta) => {
    const c = String(caller || "");
    const watchers = c === "module:watchers" && meta.firstParty === true;
    if (input.on_behalf != null && !watchers) throw denied("on_behalf is for Vyre's own watchers runtime only");
    if (claims(c)) {
      const r = await reach(undefined, c);
      return { kind: await kindOf(r.agent, r), name: String(r.agent), r, you: Boolean(r.assistant), limited: false, forced: false };
    }
    if (c.startsWith("module:")) {
      const name = c.slice(7);
      const r = await reach(undefined, c);
      if (watchers && input.on_behalf != null) {
        const o = String(input.on_behalf);
        const w = /^watcher:([A-Za-z0-9_.-]{1,80})$/.exec(o), d = /^duty:([A-Za-z0-9_.-]{1,80})\/([A-Za-z0-9_.-]{1,80})$/.exec(o);
        if (!w && !d) throw bad("on_behalf is watcher:<name> or duty:<teammate>/<id>");
        return { kind: w ? "watcher" : "duty", name: w ? w[1] : `${d[1]}/${d[2]}`, r, you: true, limited: true, forced: true };
      }
      const shipped = meta.firstParty === true;
      return { kind: "module", name, r, you: false, limited: !shipped, forced: !shipped };
    }
    // A Flow step or a module acting for the approver is neither the person nor an agent: its writes are limited and attributed to it (MA-6).
    { const w = whoNow(); if (w && w.acting) return { kind: "module", name: w.acting.id, r: await reach(undefined, c), you: false, limited: true, forced: true }; }
    if (personWrites(c, meta)) return { kind: "person", name: "you", r: { all: true }, you: true, limited: false, forced: false };
    if (ownSession(c)) return { kind: "person", name: "session", r: { all: true }, you: true, limited: false, forced: false };
    if ((whoNow() ? Boolean(whoNow()?.device) : /^(?:tailnet:|device:)/.test(c))) /* SHIM(legacy labels): the label side runs only with the kernel off */ throw Object.assign(new Error("memory is written from this device once you sign in with your passkey"), { code: "person_session_required" });
    throw denied(`memory.write is not open to ${plain(c || "an unnamed caller", 60)}`);
  };
  /** Whether a project is within what r reaches. */
  const inReach = async (project, r) => {
    if (!r.all) return Boolean(r.slugs && r.slugs.has(project));
    const known = await projects();
    return !known || known.includes(project);
  };
  /** What a reader may see: every project (null) or some, and whether the "you" room. */
  const readScope = async (caller, meta) => {
    const c = String(caller || "");
    const r = await reach(undefined, c);
    const person = !claims(c) && (reader(c) && !c.startsWith("module:") || ownSession(c) || (c.startsWith("module:") && meta.firstParty === true));
    return { r, slugs: r.all ? null : new Set(r.slugs || []), you: r.all ? person : Boolean(r.assistant) };
  };
  const tag = w => `${w.from_kind}:${w.from_name}`;
  const WHO = ["cli", "local", "deck", "capsule", "mcp", "harness", "module", "tailnet", "device", "space", "agent"];

  const writeDef = {
    callers: WHO,
    description: "Keep something learned while working, in a project's memory, at once: { kind: fact|note|decision|correction, project (a slug, or \"you\" for the person's own room), text, subject?, source_ref?, untrusted? }. Who wrote it comes from the caller, never the input, and it is read back only as quoted, attributed text, never as an instruction. untrusted: true when the turn read web, connector or imported content: then it is answerable when asked but never enters a brief or a prompt. The same source_ref again links the same row into another project. Returns { id, linked }.",
    input: { type: "object", required: ["kind", "project", "text"], properties: {
      kind: { type: "string", enum: KINDS }, project: { type: "string" }, text: { type: "string" }, subject: { type: "string" }, source_ref: { type: "string" },
      on_behalf: { type: "string" }, provider: { type: "string" }, thread: { type: "string" }, seq: { type: "integer" }, untrusted: { type: "boolean" } } },
    run: async (input, extra = {}) => {
      const caller = String(extra.caller || "");
      const who = await writer(input, caller, extra);
      const kind = String(input.kind), project = String(input.project || "");
      const text = String(input.text ?? "").trim();
      if (!KINDS.includes(kind)) throw bad(`kind is one of ${KINDS.join(", ")}`);
      if (!text) throw bad("text is empty");
      if (text.length > MAX_TEXT) throw bad(`text is longer than ${MAX_TEXT} characters`);
      const subject = typeof input.subject === "string" && input.subject.trim() ? line(input.subject, 200) : null;
      const secret = secretIn(`${text}\n${subject || ""}`);
      if (secret) throw Object.assign(new Error(`not kept: it holds what looks like ${secret}. Memory never keeps secrets; the vault does.`), { code: "secret" });
      if (who.limited && !LIMITED.includes(kind)) throw denied(`a ${who.kind === "module" ? "module Vyre does not ship" : who.kind} writes facts and notes only, never a ${kind}`);
      if (project === YOU) {
        // The person's own room: the person, their own session, the assistant, and a watcher or duty the person owns.
        if (!who.you) throw denied(`the "you" room is the person's own, not ${who.name}'s`);
        if (!LIMITED.includes(kind)) throw denied(`the "you" room keeps facts and notes, not a ${kind}`);
      } else {
        if (!SLUG.test(project)) throw bad("project is a project's slug, or \"you\"");
        if (!(await inReach(project, who.r))) throw denied(`${who.kind === "person" ? "there is no project" : `${who.name} is not granted`} ${project}`);
      }
      const ref = typeof input.source_ref === "string" && input.source_ref ? line(input.source_ref, 300) : null;
      // An untrusted source stays untrusted: a watcher, a duty, a module Vyre does not ship, and the "you" room always.
      const untrusted = who.forced || project === YOU || input.untrusted === true;
      const thread = typeof extra.thread === "string" && extra.thread ? extra.thread : typeof input.thread === "string" && input.thread ? line(input.thread, 120) : null;
      const r = store.add({ kind, project, text, subject, source_ref: ref, untrusted,
        from: { kind: who.kind, name: who.name, provider: typeof input.provider === "string" && input.provider ? line(input.provider, 40) : null, thread, seq: Number.isInteger(input.seq) ? input.seq : null } });
      if (r.fresh) ctx.events.emit("memory.written", { id: r.id, project, kind: String(store.get(r.id)?.kind || kind), from: `${who.kind}:${who.name}` });
      return { id: r.id, linked: r.linked };
    },
  };
  ctx.tool("memory.write", writeDef);

  ctx.tool("memory.writes", {
    callers: WHO,
    description: "What agents, modules, watchers and the person wrote to memory, newest first, within your reach. Filter by project, writer or state.",
    input: { type: "object", properties: { project: { type: "string", description: "one project, or you" }, from: { type: "string", description: "one writer, such as juno or watcher:billing-inbox" }, limit: { type: "integer", minimum: 1, maximum: 200 }, state: { type: "string", enum: ["live", "forgotten", "all"], description: "live by default; forgotten or all to find a write to restore" } } },
    run: async (input, extra = {}) => {
      const s = await readScope(extra.caller, extra);
      const project = typeof input.project === "string" && input.project ? input.project : null;
      if (project && !(project === YOU ? s.you : (!s.slugs || s.slugs.has(project)))) throw denied(`${s.r.agent || "this caller"} does not reach ${plain(project, 60)}`);
      // A module Vyre does not ship lists only its own writes: it reaches as the owner, but it is not the person.
      const c = String(extra.caller || "");
      const added = c.startsWith("module:") && extra.firstParty !== true;
      const from = added ? c : typeof input.from === "string" && input.from ? input.from : null;
      const rows = store.list(s, { state: input.state || "live", from, project, limit: input.limit ?? 50 });
      return { writes: rows.map(r => shape(r, r.links)) };
    },
  });

  /**
   * forget and restore: the person, their own session, the assistant, or the write's own author,
   * each only within reach. Everywhere (no project) is the person's own surfaces alone.
   */
  const change = (state) => async (input, extra = {}) => {
    const caller = String(extra.caller || "");
    const w = store.get(String(input.id || ""));
    if (!w) throw Object.assign(new Error(`no memory write ${plain(input.id, 40)} (memory.writes lists them with their ids)`), { code: "not_found" });
    const project = typeof input.project === "string" && input.project ? input.project : null;
    const person = !claims(caller) && personWrites(caller, extra);
    if (!project && !person) throw denied(state === "forgotten" ? "Forget everywhere is the person's own, from their surfaces" : "restoring everywhere is the person's own, from their surfaces");
    const s = await readScope(caller, extra);
    let author = false;
    if (!person && !ownSession(caller) && !s.r.assistant) {
      const me = claims(caller) ? { kind: null, name: String(s.r.agent) } : caller.startsWith("module:") ? { kind: "module", name: caller.slice(7) } : null;
      author = Boolean(me && String(w.from_name) === me.name && ["agent", "teammate", "assistant", "module"].includes(String(w.from_kind)) && (me.kind ? w.from_kind === me.kind : w.from_kind !== "module"));
      // The watchers runtime forgets for its own watchers and duties.
      if (caller === "module:watchers" && extra.firstParty === true && ["watcher", "duty"].includes(String(w.from_kind))) author = true;
      if (!author) throw denied(`${plain(s.r.agent || caller, 60)} may forget or restore only what it wrote`);
    }
    const links = store.links(w.id);
    if (project) {
      if (!links.some(l => l.project === project)) throw Object.assign(new Error(`${w.id} is not filed in ${plain(project, 60)} (memory.writes shows where each write is filed)`), { code: "not_found" });
      if (!(project === YOU ? s.you : (!s.slugs || s.slugs.has(project)))) throw denied(`${plain(s.r.agent || caller, 60)} does not reach ${plain(project, 60)}`);
    }
    const changed = store.set(w.id, project ? [project] : null, state);
    const now = store.get(w.id);
    for (const p of changed) {
      if (state === "forgotten") ctx.events.emit("memory.forgot", { id: w.id, from: tag(w), ...(project ? { project: p } : {}) });
      else ctx.events.emit("memory.written", { id: w.id, project: p, kind: String(w.kind), from: tag(w), restored: true });
    }
    return { id: w.id, state: String(now.state), changed, projects: store.links(w.id).filter(l => l.project === YOU ? s.you : (!s.slugs || s.slugs.has(l.project))) };
  };
  ctx.tool("memory.write.forget", {
    callers: WHO,
    description: "Forget a memory write: with project, only its link there; without, everywhere (the person only). Undo with memory.write.restore.",
    input: { type: "object", required: ["id"], properties: { id: { type: "string" }, project: { type: "string", description: "only unlink it from this project; the write goes with its last link" } } },
    run: change("forgotten"),
  });
  ctx.tool("memory.write.restore", {
    callers: WHO,
    description: "Undo a forget: with project, that link; without, every link (the person's own surfaces only).",
    input: { type: "object", required: ["id"], properties: { id: { type: "string" }, project: { type: "string" } } },
    run: change("live"),
  });
  // The tool's own run, for memory.heard to file an agent's correction as that same agent.
  return { write: writeDef.run };
}
