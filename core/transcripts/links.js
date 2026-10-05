// @ts-check
// links — what a turn touched, found without a model: a tool call's file, a commit's hash, a url.
//
// transcripts.read() keeps only what people said, so the tool calls between two text turns would
// otherwise leave no trace in the index. A link is a plain lookup key (kind, ref) hung on a turn,
// so "every turn that touched auth.ts" and "the turn that made commit a1b2c3d" are an index read,
// not a search. Kinds: file (changed: Edit, Write, MultiEdit, NotebookEdit), read (Read), commit,
// url. Deliberately not a graph walk: the memory design measured that a graph did not help
// retrieval of past content, and these are lookups.

import { redact } from "./sanitize.js";

/** @typedef {{ kind: string, ref: string }} Link */

/** At most this many links hang on one turn: a turn that touched a thousand files is not more findable for it. */
export const LINKS_PER_TURN = 40;
/** The link kinds, in the order a pointer line lists them. */
export const LINK_KINDS = ["file", "read", "commit", "url"];
const CHANGES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** A git commit hash worth keeping: 7 to 40 hex characters with at least one digit and one letter, so a plain number or a word cut from prose is not one. @param {string} h */
const hashOk = h => /^[0-9a-f]{7,40}$/.test(h) && /\d/.test(h) && /[a-f]/.test(h);
const COMMIT_WORD = /\bcommit(?:ted|s)?\s+`?([0-9a-f]{7,40})`?(?![0-9A-Za-z])/gi;
const COMMIT_BRACKET = /\[[\w./@+-]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/g;
const URL_RE = /https?:\/\/[^\s<>"'`)\]]{4,300}/g;

/**
 * A path as a link's ref: relative to the session's folder when it is inside it, so the same file
 * is one ref whichever way a tool spelled it.
 * @param {unknown} p @param {string|null} cwd
 */
export function pathRef(p, cwd) {
  let r = String(p || "").trim();
  if (!r) return "";
  if (cwd) { const base = cwd.endsWith("/") ? cwd : cwd + "/"; if (r.startsWith(base)) r = r.slice(base.length); }
  return r.slice(0, 300);
}

/**
 * The links one tool call makes, from its name and input.
 * @param {string} name @param {any} input @param {string|null} cwd
 * @returns {Link[]}
 */
export function toolLinks(name, input, cwd) {
  const i = input && typeof input === "object" ? input : {};
  /** @type {Link[]} */ const out = [];
  if (CHANGES.has(name)) { const r = pathRef(i.file_path || i.notebook_path, cwd); if (r) out.push({ kind: "file", ref: r }); }
  else if (name === "Read") { const r = pathRef(i.file_path, cwd); if (r) out.push({ kind: "read", ref: r }); }
  else if (name === "WebFetch" && typeof i.url === "string") out.push({ kind: "url", ref: i.url.slice(0, 300) });
  return out;
}

/**
 * The links a turn's own words make: commits it names and urls it quotes.
 * @param {string} text
 * @returns {Link[]}
 */
export function textLinks(text) {
  /** @type {Link[]} */ const out = [];
  const seen = new Set();
  const add = (/** @type {string} */ kind, /** @type {string} */ ref) => { const k = kind + "\0" + ref; if (!seen.has(k)) { seen.add(k); out.push({ kind, ref }); } };
  for (const re of [COMMIT_WORD, COMMIT_BRACKET]) for (const m of text.matchAll(re)) { const h = m[1].toLowerCase(); if (hashOk(h)) add("commit", h); }
  for (const m of text.matchAll(URL_RE)) add("url", m[0].replace(/[.,;:!?]+$/, ""));
  return out;
}

/**
 * The commits a `git commit` printed in its result: "[main a1b2c3d] message".
 * @param {string} output @returns {Link[]}
 */
export function commitLinks(output) {
  /** @type {Link[]} */ const out = [];
  for (const m of String(output || "").matchAll(COMMIT_BRACKET)) { const h = m[1].toLowerCase(); if (hashOk(h)) out.push({ kind: "commit", ref: h }); }
  return out;
}

/** A tool result's text, whichever way Claude Code shaped it. @param {any} c */
export const resultText = c => (typeof c === "string" ? c : Array.isArray(c) ? c.map(p => (p && typeof p.text === "string" ? p.text : "")).join("\n") : "");

/**
 * Keep a turn's links clean: a ref that a redaction rule would change is dropped whole (half a
 * secret is still a secret), duplicates go, and the count is capped.
 * @param {Link[]} links @returns {Link[]}
 */
export function cleanLinks(links) {
  const seen = new Set();
  /** @type {Link[]} */ const out = [];
  for (const l of links) {
    if (!l || !l.ref || out.length >= LINKS_PER_TURN) continue;
    const k = l.kind + "\0" + l.ref;
    if (seen.has(k)) continue;
    seen.add(k);
    if (redact(l.ref).text !== l.ref) continue;
    out.push({ kind: l.kind, ref: l.ref });
  }
  return out;
}

/**
 * Collects a transcript's links while read() walks its lines, and hangs them on the right turn.
 * A tool call's links go to the NEXT assistant text turn of the exchange (the one that reports on
 * the work); when the exchange ends with none (a person's next turn, or the end of the file) they
 * go to the assistant turn before. A tool call with no assistant turn on either side hangs on
 * nothing. A `git commit`'s printed hash is found when its result arrives, by the call's id.
 */
export class Linker {
  /** @param {string|null} cwd */
  constructor(cwd) {
    this.cwd = cwd;
    /** @type {Link[]} */ this.pending = [];
    /** @type {Set<string>} tool_use ids that are a git commit, to read the hash from their result */
    this.commits = new Set();
    /** @type {number} the seq of the last assistant text turn, or -1 */
    this.last = -1;
  }

  /** @param {string|null} cwd the folder, once the first line has said it */
  setCwd(cwd) { if (cwd && !this.cwd) this.cwd = cwd; }

  /** A raw transcript line: note its tool calls and results. @param {any} o */
  line(o) {
    const c = o && o.message && o.message.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        for (const l of toolLinks(String(b.name || ""), b.input, this.cwd)) this.pending.push(l);
        if (b.name === "Bash" && b.input && typeof b.input.command === "string" && /\bgit\b[^|;&\n]*\bcommit\b/.test(b.input.command) && typeof b.id === "string") this.commits.add(b.id);
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string" && this.commits.delete(b.tool_use_id)) {
        for (const l of commitLinks(resultText(b.content))) this.pending.push(l);
      }
    }
  }

  /**
   * A text turn was kept at `seq`: an assistant turn takes the tool links so far and its own words' links; a person's turn closes the exchange.
   * @param {Record<string, any>[]} turns the turns so far, the new one last
   */
  turn(turns) {
    const t = turns[turns.length - 1];
    if (t.role === "assistant") {
      const got = [...this.pending, ...textLinks(t.text)];
      this.pending = [];
      this.last = t.seq;
      if (got.length) t.links = [...(t.links || []), ...got];
    } else {
      this.close(turns);
      for (const l of textLinks(t.text)) (t.links = t.links || []).push(l);
    }
  }

  /** The exchange ended: links nothing claimed go to the assistant turn before. @param {Record<string, any>[]} turns */
  close(turns) {
    if (this.pending.length && this.last >= 0) { const t = turns[this.last]; if (t) t.links = [...(t.links || []), ...this.pending]; }
    this.pending = [];
  }

  /** Clean every turn's links once the file is read. @param {Record<string, any>[]} turns */
  done(turns) {
    this.close(turns);
    for (const t of turns) if (t.links) { t.links = cleanLinks(t.links); if (!t.links.length) delete t.links; }
  }
}
