// @ts-check
// turns — reading a past span of a session word for word, and finding turns by what they touched.
//
// recall_turns holds every turn's text as the transcript said it (redacted, and cut at CLIP
// characters for the index), so a span is a read of rows in order, with no model and no summary.
// A turn the index had to cut is read whole from the transcript itself when the file is still
// there and still says the same words; else the stored text is given and the answer says it was
// cut. Links (core/transcripts/links.js) turn "what touched auth.ts" and "which turn made commit
// a1b2c3d" into an index read.

import fs from "node:fs";
import { fullTurns, CLIP } from "../transcripts/index.js";
import { scrubText } from "./sealed.js";
import { withoutSeed as ownWords } from "../../lib/seed.js";

/** Most turns one span returns, and most characters across them: a span is for reading, not for dumping a session. */
export const SPAN_TURNS = 60;
export const SPAN_CHARS = 60_000;
/** A transcript bigger than this is not read whole to give one long turn its full text. */
export const MAX_READ_BYTES = 256 * 1024 * 1024;

/** A turn's pointer: the key anyone can cite and `recall.turn` reads back. @param {string} session @param {number} seq */
export const pointer = (session, seq) => `${session}:${seq}`;

/**
 * Parse a pointer. A session id can hold a "/" (a subagent) but never ":", so the last ":" splits it.
 * @param {string} p @returns {{ session: string, seq: number }|null}
 */
export function parsePointer(p) {
  const m = /^(.+):(\d{1,9})$/.exec(String(p || "").trim());
  return m ? { session: m[1], seq: Number(m[2]) } : null;
}

/**
 * A session by id or an unambiguous prefix of one.
 * @param {import("node:sqlite").DatabaseSync} db @param {string} session
 * @returns {any}
 */
export function resolve(db, session) {
  let row = db.prepare("SELECT * FROM recall_sessions WHERE id = ?").get(session);
  if (!row) {
    const like = db.prepare("SELECT * FROM recall_sessions WHERE substr(id, 1, ?) = ? LIMIT 2").all(session.length, session);
    if (like.length > 1) throw new Error(`more than one session starts with ${session}`);
    row = like[0];
  }
  if (!row) throw Object.assign(new Error(`no session ${session}`), { code: "not_found" });
  return row;
}

/** @param {unknown} v @param {number} fallback @param {number} max */
const whole = (v, fallback, max) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback; };

/**
 * The seqs a call asks for: one turn with neighbours around it, or a range.
 * @param {{ seq?: number, before?: number, after?: number, from?: number, to?: number, span?: number }} q
 * @returns {{ from: number, to: number }}
 */
export function range(q) {
  if (q.seq !== undefined && q.seq !== null) {
    const seq = whole(q.seq, -1, 1e9);
    if (seq < 0) throw Object.assign(new Error("seq is a turn number, 0 or more"), { code: "bad_input" });
    return { from: Math.max(0, seq - whole(q.before, 0, SPAN_TURNS)), to: seq + whole(q.after, 0, SPAN_TURNS) };
  }
  if (q.from !== undefined && q.from !== null) {
    const from = whole(q.from, -1, 1e9);
    if (from < 0) throw Object.assign(new Error("from is a turn number, 0 or more"), { code: "bad_input" });
    const to = q.to !== undefined && q.to !== null ? whole(q.to, from, 1e9) : from + whole(q.span, 10, SPAN_TURNS) - 1;
    return { from, to: Math.max(from, to) };
  }
  throw Object.assign(new Error("name the turn: seq (with before and after for its neighbours), or from with to or span"), { code: "bad_input" });
}

/**
 * A span of one session, verbatim, with each turn's links and pointer.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ session: string, seq?: number, before?: number, after?: number, from?: number, to?: number, span?: number, full?: boolean }} q
 * @returns {{ session: { id: string, name: string|null, title: string|null, cwd: string|null, turns: number }, from: number, to: number,
 *   turns: { pointer: string, seq: number, role: string, ts: number, text: string, links: { kind: string, ref: string }[], cut?: boolean, provider?: string|null, model?: string|null }[],
 *   truncated?: { at: number, why: string }, note?: string, next?: number }}
 */
export function span(db, q) {
  const row = resolve(db, String(q.session || ""));
  const { from, to } = range(q);
  const upto = Math.min(to, from + SPAN_TURNS - 1);
  const rows = /** @type {any[]} */ (db.prepare("SELECT seq, role, ts, text, provider, model FROM recall_turns WHERE session = ? AND seq >= ? AND seq <= ? ORDER BY seq").all(row.id, from, upto));
  const links = new Map();
  for (const l of /** @type {any[]} */ (db.prepare("SELECT seq, kind, ref FROM recall_links WHERE session = ? AND seq >= ? AND seq <= ? ORDER BY seq, kind, ref").all(row.id, from, upto))) {
    const k = Number(l.seq);
    if (!links.has(k)) links.set(k, []);
    links.get(k).push({ kind: String(l.kind), ref: String(l.ref) });
  }
  // A turn the index cut is read whole from the transcript, if it is still there and still says the same words.
  const longs = q.full === false ? [] : rows.filter(r => String(r.text).length >= CLIP - 200).map(r => Number(r.seq));
  // A runaway transcript (hundreds of megabytes) is not read whole for one turn: the index's text stands, cut.
  let big = false;
  try { big = Boolean(longs.length && row.file && fs.statSync(String(row.file)).size > MAX_READ_BYTES); } catch { /* no file */ }
  const whole_ = longs.length && row.file && !big ? fullTurns(String(row.file), longs) : new Map();
  let note;
  /** @type {any[]} */ const turns = [];
  let chars = 0, truncated;
  for (const r of rows) {
    const seq = Number(r.seq);
    let text = String(r.text), cut = false;
    const w = whole_.get(seq);
    if (w) {
      const full = scrubText(w.text).text;
      if (full.startsWith(text.slice(0, 200)) && full.length >= text.length) { text = full; cut = w.cut; }
      else { cut = true; note = "The transcript on disk no longer matches the index for a long turn, so that turn is given as the index holds it (cut)."; }
    } else if (text.length >= CLIP - 200) cut = true;
    if (chars + text.length > SPAN_CHARS && turns.length) { truncated = { at: seq, why: `the span passed ${SPAN_CHARS} characters; ask again from turn ${seq}` }; break; }
    chars += text.length;
    turns.push({ pointer: pointer(row.id, seq), seq, role: String(r.role), ts: Number(r.ts) || 0, text, links: links.get(seq) || [], ...(cut ? { cut: true } : {}),
      ...(r.provider && r.provider !== "claude" ? { provider: String(r.provider) } : {}), ...(r.model ? { model: String(r.model) } : {}) });
  }
  const out = { session: { id: String(row.id), name: row.name ?? null, title: row.title ?? null, cwd: row.cwd ?? null, turns: Number(row.turns) || 0 }, from, to: upto, turns };
  /** @type {any} */ const res = out;
  if (truncated) res.truncated = truncated;
  else if (to > upto && db.prepare("SELECT 1 FROM recall_turns WHERE session = ? AND seq = ?").get(row.id, upto + 1)) res.truncated = { at: upto + 1, why: `a span is at most ${SPAN_TURNS} turns; ask again from turn ${upto + 1}` };
  if (note) res.note = note;
  if (res.truncated) res.next = res.truncated.at;
  return res;
}

/** LIKE patterns are text here, never wildcards. @param {string} s */
const likeEscape = s => s.replace(/[\\%_]/g, c => "\\" + c);

/**
 * The (kind, ref) pairs a filter names, as SQL: a file matches a stored path equal to it or ending
 * in "/" and it (so "auth.ts" finds "src/auth.ts"); a commit matches a stored hash that starts
 * with it or that it starts with (a short hash and a full one are the same commit).
 * @param {{ kind?: string, ref: string }} f
 * @returns {{ sql: string, args: string[] }|null}
 */
export function linkFilter(f) {
  const ref = String(f.ref || "").trim();
  if (!ref) return null;
  const kind = f.kind ? String(f.kind) : "";
  if (kind === "commit") {
    const h = ref.toLowerCase();
    if (!/^[0-9a-f]{4,40}$/.test(h)) return null;
    return { sql: "(l.kind = 'commit' AND (l.ref LIKE ? ESCAPE '\\' OR ? LIKE l.ref || '%'))", args: [h + "%", h] };
  }
  const kinds = kind ? [kind] : ["file", "read"];
  const marks = kinds.map(() => "?").join(",");
  if (kind === "url") return { sql: "(l.kind = 'url' AND l.ref = ?)", args: [ref] };
  return { sql: `(l.kind IN (${marks}) AND (l.ref = ? OR l.ref LIKE ? ESCAPE '\\'))`, args: [...kinds, ref, "%/" + likeEscape(ref)] };
}

/**
 * Turns that touched something, newest first, with their session's name and folder.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ kind?: string, ref: string, session?: string, since?: number, limit?: number }} q
 * @returns {{ pointer: string, session: string, seq: number, role: string, ts: number, kind: string, ref: string, snippet: string, name: string|null, cwd: string|null }[]}
 */
export function byLink(db, q) {
  const f = linkFilter(q);
  if (!f) throw Object.assign(new Error("give ref: a file path or name, a commit hash (kind commit), or a url (kind url)"), { code: "bad_input" });
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 30));
  const sess = q.session ? resolve(db, String(q.session)).id : null;
  const rows = /** @type {any[]} */ (db.prepare(`SELECT l.session, l.seq, l.kind, l.ref, s.name, s.cwd, s.ended FROM recall_links l JOIN recall_sessions s ON s.id = l.session
    WHERE ${f.sql}${sess ? " AND l.session = ?" : ""} ORDER BY s.ended DESC, l.session, l.seq DESC LIMIT ?`).all(...f.args, ...(sess ? [sess] : []), limit * 4));
  const turn = db.prepare("SELECT role, ts, text FROM recall_turns WHERE session = ? AND seq = ?");
  const out = [], seen = new Set();
  for (const r of rows) {
    const key = r.session + "\0" + r.seq;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = /** @type {any} */ (turn.get(r.session, r.seq));
    if (!t) continue;
    const ts = Number(t.ts) || 0;
    if (q.since && ts < Number(q.since)) continue;
    out.push({ pointer: pointer(String(r.session), Number(r.seq)), session: String(r.session), seq: Number(r.seq), role: String(t.role), ts, kind: String(r.kind), ref: String(r.ref),
      snippet: String(t.text).replace(/\s+/g, " ").slice(0, 200), name: r.name ?? null, cwd: r.cwd ?? null });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The (session, seq) keys of every turn that matches ALL the filters, for narrowing a search to turns that touched a file or made a commit.
 * @param {import("node:sqlite").DatabaseSync} db @param {{ kind?: string, ref: string }[]} filters
 * @returns {Set<string>|null} "session\0seq" keys; null when no filter was usable
 */
export function keysFor(db, filters) {
  /** @type {Set<string>|null} */ let keep = null;
  for (const f of filters || []) {
    const sql = linkFilter(f);
    if (!sql) continue;
    const got = new Set(/** @type {any[]} */ (db.prepare(`SELECT l.session, l.seq FROM recall_links l WHERE ${sql.sql}`).all(...sql.args)).map(r => r.session + "\0" + r.seq));
    keep = keep ? new Set([...keep].filter(k => got.has(k))) : got;
  }
  return keep;
}

/**
 * One line a reader can scan for a turn: pointer, role, time, and its first words.
 * @param {{ session: string, seq: number, role: string, ts: number, text: string }} t @param {number} [width]
 */
export function label(t, width = 80) {
  const when = t.ts ? new Date(t.ts).toISOString().slice(0, 16).replace("T", " ") : "";
  const text = String(t.text).replace(/\s+/g, " ").trim();
  return `${pointer(t.session, t.seq)} ${t.role === "user" ? "person" : "assistant"}${when ? " " + when : ""}: ${text.length > width ? text.slice(0, width - 1) + "…" : text}`;
}

/** A session id as a pointer carries it: its first 8 characters, which `resolve` takes as a prefix. @param {string} id */
export const shortId = id => String(id).slice(0, 8);


/**
 * One session's pointer index for a rollover: the person's own requests before turn `upto` as labelled lines, and the files touched and the commits made before it.
 * @param {import("node:sqlite").DatabaseSync} db @param {string} session
 * @param {{ upto?: number, cap?: number }} [o] upto: turns from this seq on are not pointed at (the seed carries them)
 * @returns {{ session: string, lines: string[], files: { ref: string, at: string[] }[], commits: { ref: string, at: string }[], tailFrom: number }}
 */
export function pointersOf(db, session, { upto = Infinity, cap = 30 } = {}) {
  const rows = /** @type {any[]} */ (db.prepare("SELECT seq, role, ts, text FROM recall_turns WHERE session = ? AND seq < ? ORDER BY seq").all(session, Number.isFinite(upto) ? upto : 2_000_000_000));
  const tailFrom = Number.isFinite(upto) ? upto : rows.length ? Number(rows[rows.length - 1].seq) + 1 : 0;
  const id = shortId(session);
  const asks = rows.filter(r => r.role === "user").map(r => ({ ...r, text: ownWords(String(r.text)) }))
    .filter(r => r.text.replace(/\s+/g, " ").trim().length >= 15 && !r.text.trim().startsWith("<"));
  const pick = asks.length <= cap ? asks : Array.from({ length: cap }, (_, k) => asks[Math.floor((k * asks.length) / cap)]);
  const lines = pick.map(r => label({ session: id, seq: Number(r.seq), role: "user", ts: Number(r.ts) || 0, text: r.text }));
  /** @type {Map<string, { kind: string, seqs: number[] }>} */ const files = new Map();
  /** @type {Map<string, number>} */ const commits = new Map();
  for (const l of /** @type {any[]} */ (db.prepare("SELECT seq, kind, ref FROM recall_links WHERE session = ? AND seq < ? ORDER BY seq").all(session, Number.isFinite(upto) ? upto : 2_000_000_000))) {
    if (l.kind === "commit") commits.set(String(l.ref), Number(l.seq));
    else if (l.kind === "file" || l.kind === "read") {
      const f = files.get(String(l.ref)) || { kind: "read", seqs: [] };
      if (l.kind === "file") f.kind = "file";
      f.seqs.push(Number(l.seq));
      files.set(String(l.ref), f);
    }
  }
  const ranked = [...files].sort((a, b) => (a[1].kind === b[1].kind ? b[1].seqs.length - a[1].seqs.length : a[1].kind === "file" ? -1 : 1)).slice(0, 12);
  return {
    session, lines, tailFrom,
    files: ranked.map(([ref, f]) => ({ ref, at: f.seqs.slice(-3).map(n => `${id}:${n}`) })),
    commits: [...commits].slice(-8).map(([ref, n]) => ({ ref, at: `${id}:${n}` })),
  };
}

/**
 * The split a rollover makes of a session chain (the windows of one thread, oldest first): the last turns, newest window first, whose text adds up to `tailChars` go into
 * the seed word for word; every turn before them is pointed at. One cut for both, so no turn is in neither and none in both.
 *
 * A turn the index holds only the first CLIP characters of is carried cut, with a pointer: memory_turn on it reads the whole.
 * @param {import("node:sqlite").DatabaseSync} db @param {string[]} windows session ids, oldest first (re-ordered by when each began, where that is known)
 * @param {{ tailChars?: number, turnChars?: number, cap?: number }} [o]
 * @returns {{ tail: { who: string, text: string, pointer: string }[], sessions: { session: string, turns: number, lines: string[], files: { ref: string, at: string[] }[], commits: { ref: string, at: string }[], tailFrom: number }[] }}
 */
export function rolloverOf(db, windows, { tailChars = 48_000, turnChars = 6_000, cap = 30 } = {}) {
  // Oldest first by when each began (a thread that ran on Claude, then another provider, then Claude again has windows out of the order they were named in).
  const began = db.prepare("SELECT started FROM recall_sessions WHERE id = ?");
  const chain = windows.map((id, i) => ({ id, i, at: Number(/** @type {any} */ (began.get(id))?.started) || 0 })).sort((a, b) => (a.at && b.at && a.at !== b.at ? a.at - b.at : a.i - b.i)).map(x => x.id);
  /** @type {{ who: string, text: string, pointer: string }[]} */ const tail = [];
  /** @type {Map<string, number>} */ const from = new Map();
  let used = 0, full = false;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i];
    const rows = /** @type {any[]} */ (db.prepare("SELECT seq, role, text FROM recall_turns WHERE session = ? ORDER BY seq DESC").all(id));
    let tailFrom = rows.length ? Number(rows[0].seq) + 1 : 0;
    for (const r of rows) {
      if (full) break;
      const raw = String(r.text);
      const n = Math.min(raw.length, turnChars);
      if (used + n > tailChars && tail.length) { full = true; break; }
      used += n;
      tailFrom = Number(r.seq);
      const ptr = pointer(shortId(id), Number(r.seq));
      tail.unshift({ who: r.role === "user" ? "person" : "assistant", text: raw.length >= CLIP - 200 ? `${raw}\n[cut here: memory_turn ${ptr} reads the whole turn]` : raw, pointer: ptr });
    }
    from.set(id, tailFrom);
  }
  const sessions = chain.map(id => {
    const turns = Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM recall_turns WHERE session = ?").get(id)).n) || 0;
    return { ...pointersOf(db, id, { cap, upto: from.get(id) ?? turns }), turns };
  });
  return { tail, sessions };
}
