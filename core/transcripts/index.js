// @ts-check
// transcripts — the ONE place in Vyre that reads Claude Code's transcript files.
//
// Vyre touches Claude Code only through public surfaces, with this as the single exception
// (docs/SPEC.md, principle 1). The file format is not a published contract and can change under
// us, so everything about it lives here, and every failure degrades to "no history" rather than
// an error: a missing folder is an empty list, an unreadable file is skipped, a bad line costs
// that line. Recall imports this; nothing else should.
//
// Claude Code lays transcripts out as
//   <folder>/<encoded cwd>/<session id>.jsonl                           a session
//   <folder>/<encoded cwd>/<session id>/subagents/agent-<id>.jsonl      a subagent it ran
// and a subagent's Vyre id is "<session id>/agent-<id>", because every line in it carries the
// PARENT's sessionId and the file name is the only thing that tells two subagents apart.
//
// Text leaves this file redacted. Nothing downstream ever sees a credential someone pasted.

import fs from "node:fs";
import path from "node:path";
import { redact } from "./sanitize.js";

export { redact, scan } from "./sanitize.js";

/** Long tool output is noise in a search index; a turn keeps its first 4,000 characters. */
export const CLIP = 4000;

/**
 * @typedef {{ id: string, file: string, parent: string|null, size: number, mtime: number }} Entry
 * @typedef {{ seq: number, role: "user"|"assistant", ts: number, text: string, model?: string }} Turn
 * @typedef {{ id: string, file: string, cwd: string|null, name: string|null, title: string|null,
 *   started: number, ended: number, human: number, parent: string|null, turns: Turn[], redacted: number, bad: number }} Transcript
 */

/**
 * Every transcript under the given folders, one entry per session id.
 *
 * Resuming a session from another directory, or archiving a folder, leaves more than one file
 * with the same id. Taking whichever readdir yields first made two files take turns being "the"
 * session, each one looking changed against the other on every pass, so the fullest copy wins,
 * deterministically: appending to the fullest is the only choice that cannot lose turns.
 * @param {string[]} folders
 * @returns {Entry[]}
 */
export function list(folders) {
  /** @type {Map<string, Entry>} */
  const byId = new Map();
  const add = (/** @type {string} */ id, /** @type {string} */ file, /** @type {string|null} */ parent) => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (!st.isFile()) return;
    const e = { id, file, parent, size: st.size, mtime: Math.floor(st.mtimeMs) };
    const prev = byId.get(id);
    if (!prev || e.size > prev.size || (e.size === prev.size && e.file < prev.file)) byId.set(id, e);
  };
  for (const folder of folders) {
    for (const project of readdir(folder)) {
      if (!project.isDirectory()) continue;
      const dir = path.join(folder, project.name);
      for (const e of readdir(dir)) {
        if (e.name.endsWith(".jsonl")) add(e.name.slice(0, -6), path.join(dir, e.name), null);
        else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, "subagents");
          for (const a of readdir(sub)) {
            if (a.name.endsWith(".jsonl")) add(`${e.name}/${a.name.slice(0, -6)}`, path.join(sub, a.name), e.name);
          }
        }
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * One session's file by its exact id, without listing everything: one readdir per folder and a
 * stat per project folder. For a session nothing has indexed yet (a thread that started a moment
 * ago). The fullest copy wins, as in list(). Null when there is none, or the id is not an id.
 * @param {string[]} folders @param {string} id
 * @returns {Entry | null}
 */
export function find(folders, id) {
  const m = /^([A-Za-z0-9_-]{1,128})(?:\/(agent-[A-Za-z0-9_-]{1,128}))?$/.exec(String(id));
  if (!m) return null;
  /** @type {Entry | null} */
  let best = null;
  for (const folder of folders) {
    for (const project of readdir(folder)) {
      if (!project.isDirectory()) continue;
      const file = m[2] ? path.join(folder, project.name, m[1], "subagents", `${m[2]}.jsonl`) : path.join(folder, project.name, `${m[1]}.jsonl`);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const e = { id: String(id), file, parent: m[2] ? m[1] : null, size: st.size, mtime: Math.floor(st.mtimeMs) };
      if (!best || e.size > best.size || (e.size === best.size && e.file < best.file)) best = e;
    }
  }
  return best;
}

/**
 * What a session is, from the head of its file only: its folder and, if named early, its name.
 * For a session not indexed yet, where reading the whole file for a label is not worth it.
 * @param {string} file
 * @returns {{ cwd: string|null, name: string|null }}
 */
export function peek(file) {
  const out = { cwd: /** @type {string|null} */ (null), name: /** @type {string|null} */ (null) };
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let pos = 0;
    while (pos < n) {
      let end = buf.indexOf(0x0a, pos);
      if (end < 0 || end > n) break;
      const o = parse(buf, pos, end);
      pos = end + 1;
      if (!o || typeof o !== "object") continue;
      if (o.type === "custom-title" && typeof o.customTitle === "string" && o.customTitle.trim()) out.name = redact(o.customTitle.trim().slice(0, 120)).text;
      if (out.cwd === null && typeof o.cwd === "string" && o.cwd) out.cwd = o.cwd;
    }
  } catch { /* no head is no label */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return out;
}

/** @param {string} dir */
function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * The text of one line, if it is a turn: what a person typed, or what Claude wrote back.
 *
 * Tool traffic is not a turn. An assistant line holding only a tool_use, or a user line holding
 * only a tool_result, has no text of its own; Claude Code writes each content block of a reply
 * as its own line, so a reply's text arrives on a line of its own and is kept. Lines Claude Code
 * adds on the user's behalf (isMeta) are not something anyone said.
 * @param {any} o
 * @returns {{ role: "user"|"assistant", text: string } | null}
 */
export function turnOf(o) {
  if (!o || (o.type !== "user" && o.type !== "assistant") || o.isMeta) return null;
  const m = o.message;
  if (!m || typeof m !== "object") return null;
  const role = m.role === "assistant" || o.type === "assistant" ? "assistant" : "user";
  const c = m.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.filter(p => p && p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
  text = text.trim();
  // The model that wrote an assistant line (Claude Code records it on the message); a placeholder like "<synthetic>" is no model.
  const model = role === "assistant" && typeof m.model === "string" && m.model && !m.model.startsWith("<") ? m.model.slice(0, 80) : null;
  return text ? { role, text, ...(model ? { model } : {}) } : null;
}

/**
 * Read one transcript into what Recall indexes. Never throws: an unreadable file is null, and a
 * line that is not JSON (a live session's last line is often half written) is counted and
 * skipped.
 *
 * - seq counts turns with text, from 0, in file order. It is the turn's identity.
 * - name is the LAST custom-title. Claude Code writes one again on every resume (one real
 *   session carried 12,454 copies), so the first one froze a session at its oldest name.
 * - cwd comes from the lines. The folder name cannot be decoded: "a-b" and "a/b" encode alike.
 * - human is 0 when a program started it: a subagent (isSidechain) or an SDK run.
 * @param {string} file
 * @param {{ id?: string, parent?: string|null }} [who]
 * @returns {Transcript | null}
 */
export function read(file, who = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const id = who.id ?? path.basename(file, ".jsonl");
  /** @type {Transcript} */
  const t = { id, file, cwd: null, name: null, title: null, started: 0, ended: 0, human: 1,
    parent: who.parent ?? null, turns: [], redacted: 0, bad: 0 };
  let program = null;
  // Line by line over the bytes rather than one giant string: a runaway transcript can be
  // hundreds of megabytes, and one string that size is the thing that falls over.
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    const line = buf.toString("utf8", start, end);
    start = end + 1;
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { t.bad++; continue; }
    if (!o || typeof o !== "object") continue;
    if (o.type === "custom-title") {
      if (typeof o.customTitle === "string" && o.customTitle.trim()) t.name = redact(o.customTitle.trim().slice(0, 120)).text;
      continue;
    }
    if (t.cwd === null && typeof o.cwd === "string" && o.cwd) t.cwd = o.cwd;
    if (program === null && (o.isSidechain !== undefined || o.entrypoint !== undefined)) {
      program = o.isSidechain === true || /^sdk/.test(String(o.entrypoint || ""));
    }
    const ts = Date.parse(o.timestamp || "") || 0;
    if (ts) { if (!t.started || ts < t.started) t.started = ts; if (ts > t.ended) t.ended = ts; }
    const turn = turnOf(o);
    if (!turn) continue;
    const clean = redact(turn.text.length > CLIP ? turn.text.slice(0, CLIP) : turn.text);
    t.redacted += clean.hits.length;
    t.turns.push({ seq: t.turns.length, role: turn.role, ts, text: clean.text, ...(turn.model ? { model: turn.model } : {}) });
    // The first real thing the user typed is a better title than anything generated. Command
    // echoes and injected context start with a tag and are not what anyone would call it.
    if (t.title === null && turn.role === "user" && !clean.text.startsWith("<") && clean.text.length > 3) {
      t.title = clean.text.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  if (program || t.parent) t.human = 0;
  return t;
}

// ---------------------------------------------------------------------------------------------
// blocks: a rich read of one session, for the Deck's Chat to render instead of a terminal.
//
// read() above keeps only what people said, for search. blocks() keeps everything a person would
// want to see: thinking, each tool call with its input and output, and a line of stats at the end
// of every turn. Everything that leaves is redacted and capped, because tool output can hold
// anything the session read.
//
// Claude Code writes each content block of a reply as its own line, all carrying the same
// message.id, and each tool's result on a later user line naming the tool_use_id. A tool block is
// emitted where its call is, and its output is filled in from the result line.
//
// seq is the line index in the file. Blocks are unique by seq and kind (and id, for tools): a
// "turn" block takes the seq of the human line that closed it, the user block on that line comes
// right after it.

/** Tool input strings, tool output and Write content keep this many characters. */
export const BLOCK_CAP = 8000;
/** Thinking keeps this many. */
export const THINK_CAP = 4000;
/** What a person or the model wrote keeps this many. Nobody reads further in a chat view. */
export const TEXT_CAP = 20000;
/** How far past a window's end to read for results and the turn's close, in lines. */
const LOOKAHEAD = 20000;

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMMAND = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;
/** Claude Code's own line when a turn is stopped: never the person steering. */
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * Redact, then cap. Slicing a little past the cap first keeps a runaway string cheap to redact,
 * and redacting before the final cut means a secret is never cut in half and left readable.
 * @param {unknown} s @param {number} cap
 */
function clean(s, cap) {
  const str = typeof s === "string" ? s : String(s ?? "");
  const r = redact(str.length > cap + 512 ? str.slice(0, cap + 512) : str).text;
  if (r.length <= cap && str.length <= cap + 512) return r;
  return `${r.slice(0, cap)}\n[+${Math.max(0, str.length - cap)} characters]`;
}

/**
 * Every string in a tool's input redacted and capped. TodoWrite's todos stay whole (redacted,
 * never cut): a list the Deck draws as a checklist is no use half there.
 * @param {string} tool @param {any} input
 */
function cleanInput(tool, input) {
  const walk = (/** @type {any} */ v, /** @type {number} */ cap, /** @type {number} */ depth) => {
    if (typeof v === "string") return clean(v, cap);
    if (!v || typeof v !== "object") return v;
    if (depth > 8) return "[nested too deep]";
    if (Array.isArray(v)) return v.slice(0, 500).map(x => walk(x, cap, depth + 1));
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, cap, depth + 1);
    return out;
  };
  if (!input || typeof input !== "object") return walk(input, BLOCK_CAP, 0);
  const out = walk(input, BLOCK_CAP, 0);
  if (tool === "TodoWrite" && Array.isArray(input.todos)) out.todos = walk(input.todos, Number.MAX_SAFE_INTEGER, 0);
  return out;
}

/** A tool_result's content as text: a string, or text blocks joined, with images named. */
function resultText(/** @type {any} */ c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return c == null ? "" : JSON.stringify(c);
  return c.map(p => (p && p.type === "text" ? String(p.text ?? "") : p && p.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

/** Only these decode reliably everywhere a picture might render (core/switchboard's own list, kept
 * in step by hand: transcripts never imports another module per docs/SPEC.md principle 1). */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Strict base64 (RFC 4648), no whitespace: a surface builds a `data:` URL straight from this
 * (CSS url(), a string template), so anything that isn't clean base64 is dropped rather than
 * risking a break-out of that context. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** One image's own ceiling. Base64 length stands in for bytes (data.length * 3/4 ~= decoded size)
 * so this never has to decode a picture just to measure it. */
const IMAGE_BYTES_CAP = 2 * 1024 * 1024;
/** No block carries more pictures than this, however many came with it. */
const IMAGES_PER_BLOCK = 4;
/** A block's pictures together stay under this even when each is under IMAGE_BYTES_CAP (four just
 * under the per-image cap would otherwise be 8 MB of one block). */
const IMAGES_BYTES_CAP = 6 * 1024 * 1024;
/** The whole response's pictures together stay under this: a page of `limit` blocks could
 * otherwise carry IMAGES_BYTES_CAP each, and a Mac read goes back over the link (askMacs) - one
 * image-heavy page must not become hundreds of MB. Once spent, later blocks in the same read carry
 * no images at all (same "[image]" text as always); a surface can still fetch one later by seq. */
const RESPONSE_BYTES_CAP = 12 * 1024 * 1024;

/**
 * The pictures in a content-parts array (`{type:"image", source:{type:"base64", media_type,
 * data}}`), within every cap above, including the read's own shared byte budget (`budget.left`,
 * spent here and never refunded). Never removes or changes a block's existing text: a picture
 * dropped for being over a cap still reads "[image]" in the text, exactly as before this existed -
 * this only ever adds `images` alongside it (cohesion item 18).
 * @param {any[]} parts @param {{ left: number }} budget the read's remaining RESPONSE_BYTES_CAP
 * @returns {{ media_type: string, data: string }[]}
 */
function imagesFrom(parts, budget) {
  if (!Array.isArray(parts)) return [];
  const out = [];
  let bytes = 0;
  for (const p of parts) {
    if (out.length >= IMAGES_PER_BLOCK) break;
    if (!p || p.type !== "image") continue;
    const src = p.source;
    if (!src || src.type !== "base64" || typeof src.data !== "string" || !src.data) continue;
    if (!BASE64_RE.test(src.data)) continue;
    const media_type = String(src.media_type || "");
    if (!IMAGE_MEDIA_TYPES.has(media_type)) continue;
    const size = Math.floor(src.data.length * 3 / 4);
    if (size > IMAGE_BYTES_CAP || bytes + size > IMAGES_BYTES_CAP || size > budget.left) continue;
    bytes += size;
    budget.left -= size;
    out.push({ media_type, data: src.data });
  }
  return out;
}

/** An Edit's structured patch, redacted and capped: hunks with their lines. */
function cleanPatch(/** @type {any} */ p) {
  if (!Array.isArray(p) || !p.length) return undefined;
  let budget = BLOCK_CAP;
  const out = [];
  for (const h of p.slice(0, 50)) {
    if (!h || !Array.isArray(h.lines) || budget <= 0) break;
    const lines = [];
    for (const l of h.lines) {
      if (budget <= 0) break;
      const s = clean(String(l), Math.min(2000, budget));
      budget -= s.length;
      lines.push(s);
    }
    out.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines });
  }
  return out;
}

/**
 * `block` on text and thinking is the content block's index within its message, counted across
 * every line that shares message.id (Claude Code writes one block per line), so it equals the
 * index the live stream gives and the Deck can swap a live row for its block in place. `uuid` on
 * a person's line is the transcript line's own.
 *
 * A person's line inside an open turn (the model has called a tool and not yet finished its
 * reply) is a steer: words typed while it worked, which joined the turn at its next step. It is
 * `steered: true, step: <tool calls finished in the turn before it>`, it does not start a turn,
 * and the Deck marks it "Steered at step N" as it did live.
 * @typedef {{ seq: number, kind: "user", ts: number, text: string, command?: true, uuid?: string, steered?: true, step?: number }
 *   | { seq: number, kind: "text", ts: number, message: string|null, block?: number, text: string }
 *   | { seq: number, kind: "thinking", ts: number, block?: number, text: string }
 *   | { seq: number, kind: "tool", ts: number, id: string, tool: string, input: any, output: string|null,
 *       error: boolean, done_ts: number|null, duration_ms: number|null, patch?: any }
 *   | { seq: number, kind: "turn", ts: number, duration_ms: number, tokens: { input: number, output: number },
 *       model: string|null, open?: true }} Block
 */

/**
 * The state of one read: the window's blocks, tools waiting for a result, and the turn so far.
 */
class Reader {
  constructor() {
    /** @type {Block[]} */
    this.blocks = [];
    /** @type {Map<string, any>} tool blocks waiting for their result, by tool_use id */
    this.pending = new Map();
    this.turn = this.fresh(null, 0);
    /** @type {Map<string, number>} content blocks seen so far, by message id */
    this.counts = new Map();
    /** @type {((id: string) => number) | null} blocks a message had before the window, while none of its lines may be missed */
    this.before = null;
    /** This read's own shared picture-byte budget (RESPONSE_BYTES_CAP), spent across every block. */
    this.imageBudget = { left: RESPONSE_BYTES_CAP };
  }

  /** @param {number|null} seq the human line that starts it (null: it started before the window) @param {number} ts */
  fresh(seq, ts) {
    return { seq, ts, first: 0, last: 0, lastSeq: -1, any: false, zero: false, model: /** @type {string|null} */ (null), usage: new Map(),
      // Steering: whether the model's last word was a tool call (so the turn goes on), and how many calls have finished.
      calling: false, steps: 0 };
  }

  /**
   * The turn so far as a block. Only a turn whose human line is in the window is emitted: one
   * that began earlier belongs to the read that holds its start, which reads on to its close.
   * @param {number} seq @param {boolean} open
   */
  closeTurn(seq, open) {
    const t = this.turn;
    if (!t.any || (t.seq === null && !t.zero)) return;
    let input = 0, output = 0;
    for (const u of t.usage.values()) {
      input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      output += u.output_tokens || 0;
    }
    const start = t.ts || t.first || t.last;
    /** @type {any} */
    const b = { seq, kind: "turn", ts: start, duration_ms: Math.max(0, t.last - start), tokens: { input, output }, model: t.model };
    if (open) b.open = true;
    this.blocks.push(b);
  }

  /**
   * One parsed line. `only` limits it to the lookahead's work: results and turn stats, no new
   * blocks. Returns "human" when the line is a person's, so the lookahead knows the turn closed.
   * @param {any} o @param {number} seq @param {boolean} [only]
   */
  line(o, seq, only = false) {
    if (!o || typeof o !== "object" || o.isMeta || o.isSidechain === true || o.parent_tool_use_id) return null;
    if (o.type !== "user" && o.type !== "assistant") return null;
    const m = o.message;
    if (!m || typeof m !== "object") return null;
    const ts = Date.parse(o.timestamp || "") || 0;
    if (o.type === "assistant") return this.assistant(m, seq, ts, only);
    return this.user(o, m, seq, ts, only);
  }

  /** @param {any} o @param {any} m @param {number} seq @param {number} ts @param {boolean} only */
  user(o, m, seq, ts, only) {
    const c = m.content;
    const parts = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
    const texts = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "tool_result") this.result(p, o, ts);
      else if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (p.type === "image") texts.push("[image]");
    }
    const text = texts.join("\n").replace(REMINDER, "").trim();
    if (!text) return null;
    if (this.steers(text)) {
      if (only) return null;
      /** @type {any} */
      const b = { seq, kind: "user", ts, text: clean(text, TEXT_CAP), steered: true, step: this.turn.steps };
      if (typeof o.uuid === "string" && o.uuid) b.uuid = o.uuid;
      const imgs = imagesFrom(parts, this.imageBudget);
      if (imgs.length) b.images = imgs;
      this.before = null;
      this.blocks.push(b);
      return null;
    }
    if (only) return "human";
    this.closeTurn(seq, false);
    /** @type {any} */
    const b = { seq, kind: "user", ts, text: clean(text, TEXT_CAP) };
    if (COMMAND.test(text)) b.command = true;
    if (typeof o.uuid === "string" && o.uuid) b.uuid = o.uuid;
    const imgs = imagesFrom(parts, this.imageBudget);
    if (imgs.length) b.images = imgs;
    // A person spoke inside the window, so every message from here on starts inside it too.
    this.before = null;
    this.blocks.push(b);
    this.turn = this.fresh(seq, ts);
    return "human";
  }

  /**
   * Is a person's line with this text a steer? Only inside a turn this read holds, while a tool
   * call is outstanding or the model's last word was one. A command or Claude Code's own
   * "[Request interrupted by user]" line never is.
   * @param {string} text
   */
  steers(text) {
    const t = this.turn;
    if (!t.any || (t.seq === null && !t.zero)) return false;
    if (COMMAND.test(text) || INTERRUPTED.test(text)) return false;
    return t.calling || [...this.pending.values()].some(b => b.seq >= (t.seq ?? 0));
  }

  /** @param {any} p @param {any} o @param {number} ts */
  result(p, o, ts) {
    const b = this.pending.get(p.tool_use_id);
    if (!b) return;
    this.pending.delete(p.tool_use_id);
    this.turn.steps++;
    b.output = clean(resultText(p.content), BLOCK_CAP);
    b.error = p.is_error === true;
    b.done_ts = ts || null;
    b.duration_ms = ts && b.ts ? Math.max(0, ts - b.ts) : null;
    const patch = o.toolUseResult && typeof o.toolUseResult === "object" ? cleanPatch(o.toolUseResult.structuredPatch) : undefined;
    if (patch) b.patch = patch;
    // A tool's own picture (a screenshot, a Canva render): cohesion item 18's "agent-made image".
    const imgs = imagesFrom(Array.isArray(p.content) ? p.content : [], this.imageBudget);
    if (imgs.length) b.images = imgs;
  }

  /** @param {any} m @param {number} seq @param {number} ts @param {boolean} only */
  assistant(m, seq, ts, only) {
    const t = this.turn;
    t.any = true;
    if (ts) { if (!t.first) t.first = ts; if (ts > t.last) t.last = ts; }
    t.lastSeq = seq;
    if (typeof m.model === "string" && m.model && !m.model.startsWith("<")) t.model = m.model;
    // Every line of one reply repeats its usage, and the last one has the final output count.
    if (m.usage && typeof m.usage === "object") t.usage.set(m.id || `line:${seq}`, m.usage);
    const c = m.content;
    const parts = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
    // The turn goes on while the model's last word is a tool call; text or thinking after one may be its end.
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "tool_use") t.calling = true;
      else if ((p.type === "text" && typeof p.text === "string" && p.text.trim()) || p.type === "thinking") t.calling = false;
    }
    if (only) return null;
    // The API's content block index: every block of the message counts, whatever its type, and
    // the lines of one message each carry the next of its blocks.
    const key = typeof m.id === "string" && m.id ? m.id : null;
    let index = 0;
    if (key) {
      if (this.counts.has(key)) index = /** @type {number} */ (this.counts.get(key));
      // Only the window's first message can have begun before it: one message's lines are
      // written together, so any later message starts inside the window.
      else if (this.before) { index = this.before(key); this.before = null; }
      this.counts.set(key, index + parts.length);
    }
    /** @type {any} */
    let prev = null;
    for (const [i, p] of parts.entries()) {
      if (!p || typeof p !== "object") continue;
      const block = key ? index + i : i;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        if (prev && prev.kind === "text") { prev.raw += "\n" + p.text; continue; }
        prev = { seq, kind: "text", ts, message: m.id ?? null, block, raw: p.text };
        this.blocks.push(prev);
      } else if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) {
        if (prev && prev.kind === "thinking") { prev.raw += "\n" + p.thinking; continue; }
        prev = { seq, kind: "thinking", ts, block, raw: p.thinking };
        this.blocks.push(prev);
      } else if (p.type === "tool_use" && typeof p.id === "string") {
        const tool = String(p.name || "tool");
        const b = { seq, kind: "tool", ts, id: p.id, tool, input: cleanInput(tool, p.input ?? {}), output: null, error: false, done_ts: null, duration_ms: null };
        this.pending.set(p.id, b);
        this.blocks.push(/** @type {any} */ (b));
        prev = b;
      }
    }
    return null;
  }

  /** Text and thinking are gathered raw and cleaned once, when the read is done. */
  finish() {
    for (const b of /** @type {any[]} */ (this.blocks)) {
      if (b.raw === undefined) continue;
      b.text = clean(b.raw.trim(), b.kind === "thinking" ? THINK_CAP : TEXT_CAP);
      delete b.raw;
    }
  }
}

/** Parse one line, or undefined when it is not JSON. @param {Buffer} buf @param {number} a @param {number} b */
function parse(buf, a, b) {
  const s = buf.toString("utf8", a, b);
  if (!s.trim()) return null;
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Byte offset where line n starts, counting newlines only; buf.length when the file is shorter. */
function lineStart(/** @type {Buffer} */ buf, /** @type {number} */ n) {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) return buf.length;
    at = nl + 1;
  }
  return at;
}

/** How many lines, counting an unterminated last one. */
function lineCount(/** @type {Buffer} */ buf) {
  let n = 0, at = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    n++; at = nl + 1;
  }
  return at < buf.length ? n + 1 : n;
}

/**
 * How many content blocks message `id` had in the lines just before byte `at`: walk back over its
 * lines (and anything else between them) until another message, a person's line or LOOKAHEAD
 * lines.
 * @param {Buffer} buf @param {number} at @param {string} id
 */
function blocksBefore(buf, at, id) {
  let n = 0, end = at - 1, seen = 0;
  while (end > 0 && seen < LOOKAHEAD) {
    const start = buf.lastIndexOf(0x0a, end - 1) + 1;
    const o = parse(buf, start, end);
    end = start - 1; seen++;
    if (!o || typeof o !== "object" || o.isSidechain === true || o.parent_tool_use_id) continue;
    const m = o.message;
    if (!m || typeof m !== "object") continue;
    if (o.type === "assistant") {
      if (m.id !== id) break;                                         // an earlier message: this one started after it
      n += typeof m.content === "string" ? 1 : Array.isArray(m.content) ? m.content.length : 0;
      continue;
    }
    if (o.type === "user" && !o.isMeta) {
      const c = m.content;
      if (typeof c === "string" || (Array.isArray(c) && c.some(p => p && p.type === "text"))) break;
    }
  }
  return n;
}

const PARENT = Buffer.from('{"parentUuid":"');

/**
 * Lines a rewind left behind. A rewind (a double Esc in Claude Code, threads.rewind in Vyre)
 * resumes the session from a message's parent, so the next message the person sends is a second
 * child of that parent, and everything from the first child up to it is a branch the session no
 * longer follows. Such a branch is found as two person's lines (text, not a tool result, not meta,
 * not a sidechain) with the same parentUuid: the lines from the earlier to the later are skipped.
 * Only the line's start is looked at for the parent (Claude Code writes parentUuid first); only
 * the few lines that share a parent are parsed. A rewind nothing has been sent after yet is not a
 * branch in the file: the Deck skips it from the thread.rewound event until then.
 * @param {Buffer} buf @returns {(line: number) => boolean}
 */
function abandonedLines(buf) {
  /** @type {Map<string, number[]>} */
  const kids = new Map();
  let pos = 0, line = 0, twins = false;
  while (pos < buf.length) {
    let end = buf.indexOf(0x0a, pos);
    if (end < 0) end = buf.length;
    if (end - pos > PARENT.length + 36 && buf.compare(PARENT, 0, PARENT.length, pos, pos + PARENT.length) === 0) {
      const parent = buf.toString("latin1", pos + PARENT.length, pos + PARENT.length + 36);
      const list = kids.get(parent);
      if (list) { list.push(line); twins = true; } else kids.set(parent, [line]);
    }
    pos = end + 1; line++;
  }
  if (!twins) return () => false;
  /** @param {number} n */
  const person = n => {
    const at = lineStart(buf, n);
    let end = buf.indexOf(0x0a, at);
    if (end < 0) end = buf.length;
    const o = parse(buf, at, end);
    if (!o || o.type !== "user" || o.isMeta || o.isSidechain === true || o.parent_tool_use_id) return false;
    const c = o.message && o.message.content;
    return typeof c === "string" || (Array.isArray(c) && c.some(p => p && p.type === "text") && !c.some(p => p && p.type === "tool_result"));
  };
  /** @type {[number, number][]} */
  const ranges = [];
  for (const list of kids.values()) {
    if (list.length < 2) continue;
    const people = list.filter(person);
    for (let i = 1; i < people.length; i++) ranges.push([people[i - 1], people[i]]);
  }
  if (!ranges.length) return () => false;
  return n => ranges.some(([a, b]) => n >= a && n < b);
}

/**
 * Read lines [fromLine, toLine) starting at byte `at`, then read on past toLine for the results
 * and the close of what the window opened. Lines on a branch a rewind left are skipped.
 * @param {Buffer} buf @param {number} at @param {number} fromLine @param {number} toLine @param {number} limit
 * @param {(line: number) => boolean} [dead] the lines to skip (abandonedLines), when the caller has them
 */
function scan(buf, at, fromLine, toLine, limit, dead = abandonedLines(buf)) {
  const r = new Reader();
  // A read from the top of the file owns the turn it starts in, human line or not.
  if (fromLine === 0) r.turn.zero = true;
  // A window that starts inside a message counts the blocks its earlier lines held, so the index
  // does not depend on where the read began.
  else r.before = id => blocksBefore(buf, at, id);
  let seq = fromLine, pos = at, truncated = false, torn = -1;
  while (pos < buf.length && seq < toLine) {
    if (r.blocks.length >= limit) { truncated = true; break; }
    let end = buf.indexOf(0x0a, pos);
    const last = end < 0;
    if (last) end = buf.length;
    const o = parse(buf, pos, end);
    // A live session's last line is often half written: not read, so the next read starts there.
    if (o === undefined && last) { torn = seq; break; }
    if (o && !dead(seq)) r.line(o, seq);
    pos = end + 1; seq++;
  }
  const stop = seq;
  let eof = pos >= buf.length || torn >= 0;
  // Past the window: results for tools it holds, and the rest of its turn, until a person speaks.
  if (!eof && (r.pending.size || (r.turn.any && (r.turn.seq !== null || r.turn.zero)))) {
    let n = 0, s = seq;
    while (pos < buf.length && n < LOOKAHEAD) {
      let end = buf.indexOf(0x0a, pos);
      const last = end < 0;
      if (last) end = buf.length;
      const o = parse(buf, pos, end);
      if (o === undefined && last) break;
      if (o && !dead(s) && r.line(o, s, true) === "human") {
        r.closeTurn(s, false);
        r.turn = r.fresh(s, 0);
        break;
      }
      pos = end + 1; s++; n++;
    }
    if (pos >= buf.length) eof = true;
  }
  if (r.turn.any) r.closeTurn(r.turn.lastSeq, true);
  r.finish();
  return { r, stop, truncated, eof };
}

/**
 * A rich read of one transcript, as blocks the Deck renders. Never throws: a missing file is no
 * blocks.
 *
 * - from: the first line to read. Without it (and without `before`) the read is the last `limit`
 *   blocks of the file, which is what opening a session shows.
 * - before: the last `limit` blocks before this line, for paging back from `first`.
 * - next: where the next forward read starts. While a turn is still open at the end of the file
 *   it is the line that turn started on, so the next read has the whole turn again and its tools'
 *   results; a live view replaces blocks by seq.
 * - first: the seq of the first block returned (null when none).
 * @param {string} file
 * @param {{ from?: number, limit?: number, before?: number }} [opts]
 * @returns {{ blocks: Block[], next: number, first: number|null }}
 */
export function blocks(file, { from, limit = 400, before } = {}) {
  limit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 400)));
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { blocks: [], next: from ?? 0, first: null }; }
  const out = (/** @type {Block[]} */ bs, /** @type {number} */ next) => ({ blocks: bs, next, first: bs.length ? bs[0].seq : null });

  if (from !== undefined) {
    from = Math.max(0, Math.floor(Number(from) || 0));
    const { r, stop, truncated, eof } = scan(buf, lineStart(buf, from), from, Infinity, limit, abandonedLines(buf));
    return out(r.blocks, nextOf(r, from, stop, truncated, eof));
  }

  // Backwards: the last `limit` blocks before `end`. Grow the window until it holds enough.
  const total = lineCount(buf);
  const end = before === undefined ? total : Math.max(0, Math.min(total, Math.floor(Number(before) || 0)));
  const endAt = before === undefined ? buf.length : lineStart(buf, end);
  let back = limit * 2;
  const dead = abandonedLines(buf);
  for (;;) {
    let at = endAt, n = 0;
    while (n < back && at > 0) {
      const nl = at >= 2 ? buf.lastIndexOf(0x0a, at - 2) : -1;
      at = nl + 1; n++;
    }
    // Start on a person's line, so the first turn in the window is whole and gets its block.
    const probe = new Reader();
    for (let k = 0; k < LOOKAHEAD && at > 0; k++) {
      let e = buf.indexOf(0x0a, at);
      if (e < 0) e = buf.length;
      const o = parse(buf, at, e);
      if (o && probe.line(o, 0, true) === "human") break;
      const nl = at >= 2 ? buf.lastIndexOf(0x0a, at - 2) : -1;
      at = nl + 1; n++;
    }
    const startLine = end - n;
    const { r, stop, truncated, eof } = scan(buf, at, startLine, end, Number.MAX_SAFE_INTEGER, dead);
    if (r.blocks.length >= limit || startLine === 0) {
      const bs = r.blocks.slice(-limit);
      return out(bs, before === undefined ? nextOf(r, startLine, stop, truncated, eof) : end);
    }
    back *= 4;
  }
}

/**
 * Where the next forward read starts. A read that stopped at its limit moves on; one that reached
 * the end of the file steps back to the open turn, or to the oldest tool still waiting, so the
 * next read sees them complete. Never behind `from`.
 * @param {Reader} r @param {number} from @param {number} stop @param {boolean} truncated @param {boolean} eof
 */
function nextOf(r, from, stop, truncated, eof) {
  if (!eof) return stop;
  let back = stop;
  if (r.turn.any && r.turn.seq !== null) back = Math.min(back, r.turn.seq);
  for (const b of r.pending.values()) back = Math.min(back, b.seq);
  if (truncated && back <= from) return stop;
  return Math.max(from, back);
}

// ---------------------------------------------------------------------------------------------
// follow: a transcript read as it grows, one line at a time, for Recall's live watch.
//
// Each line becomes the turns it holds: a user or assistant turn with text, exactly as read()
// counts and redacts them (so a live turn's id is the seq recall.thread will give it), and a
// "tool" turn per tool call, carried as a one-line summary and never its input or output.

/** A tool call as one line: the command, the file, the query. Redacted and cut to 200. */
export function toolSummary(/** @type {string} */ tool, /** @type {any} */ input) {
  const i = input && typeof input === "object" ? input : {};
  const one = (/** @type {unknown} */ v, n = 200) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  let s;
  if (tool === "Bash") s = one(i.command);
  else if (["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) s = `${tool} ${one(i.file_path || i.notebook_path)}`;
  else if (tool === "WebFetch") s = `fetch ${one(i.url)}`;
  else if (tool === "WebSearch") s = `search ${one(i.query)}`;
  else if (tool === "Glob" || tool === "Grep") s = `${tool} ${one(i.pattern)}${i.path ? " in " + one(i.path, 80) : ""}`;
  else if (tool === "TodoWrite") s = `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
  else if (tool === "Task" || tool === "Agent") s = `${tool} ${one(i.description || i.subagent_type)}`;
  else {
    const first = Object.entries(i).find(([, v]) => typeof v === "string");
    s = `${tool}${first ? ` ${first[0]}: ${first[1]}` : ""}`;
  }
  return redact(one(s)).text;
}

/**
 * @typedef {{ id: string, seq: number, turn?: number, role: "user"|"assistant"|"tool", text: string,
 *   tool?: { name: string, summary: string }, at: number }} LiveTurn
 * @typedef {{ texts: number, pending: Set<string>, busy: boolean, last: "human"|"text"|"tool"|null }} FollowState
 */

/** @returns {FollowState} */
export const followState = () => ({ texts: 0, pending: new Set(), busy: false, last: null });

/**
 * The turns one parsed line holds, updating the state: how many text turns so far (the next
 * one's seq), which tool calls wait for a result, and whether a person is waiting on a reply.
 * @param {any} o @param {number} line @param {FollowState} st
 * @returns {LiveTurn[]}
 */
export function follow(o, line, st) {
  /** @type {LiveTurn[]} */
  const out = [];
  if (!o || typeof o !== "object") return out;
  const at = Date.parse(o.timestamp || "") || 0;
  const t = turnOf(o);
  if (t) {
    const seq = st.texts++;
    const text = redact(t.text.length > CLIP ? t.text.slice(0, CLIP) : t.text).text;
    out.push({ id: String(seq), seq: line, turn: seq, role: t.role, text, at });
  }
  const side = o.isSidechain === true || o.parent_tool_use_id;
  const c = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  if (o.type === "assistant" && !o.isMeta) {
    for (const p of c) {
      if (!p || p.type !== "tool_use" || typeof p.id !== "string") continue;
      // A subagent's calls are its own business; the session shows the Task that ran it.
      if (side) continue;
      const name = String(p.name || "tool");
      const summary = toolSummary(name, p.input);
      out.push({ id: `tool:${p.id}`, seq: line, role: "tool", text: summary, tool: { name, summary }, at });
      st.pending.add(p.id); st.last = "tool";
    }
    if (!side && t) st.last = "text";
  } else if (o.type === "user") {
    for (const p of c) if (p && p.type === "tool_result") st.pending.delete(p.tool_use_id);
    // A person asked for something: busy until the reply ends. A command echo is not a request.
    if (t && !side && !/^\s*<(command-|local-command-)/.test(t.text)) { st.busy = true; st.last = "human"; }
  }
  return out;
}

/**
 * Whether a person is still waiting, judged at the end of what has been read: the last thing is
 * the model's text with no tool call left open. Returns the new value.
 * @param {FollowState} st
 */
export function settle(st) {
  if (st.busy && st.last === "text" && st.pending.size === 0) st.busy = false;
  return st.busy;
}

/**
 * Read complete lines from a buffer that starts at a line boundary, calling fn for each parsed
 * one. Returns how many bytes were consumed (a half-written last line is left) and lines seen.
 * @param {Buffer} buf @param {number} line @param {(o: any, line: number) => void} fn
 */
export function eachLine(buf, line, fn) {
  let pos = 0, n = line;
  while (pos < buf.length) {
    const end = buf.indexOf(0x0a, pos);
    if (end < 0) break;
    const o = parse(buf, pos, end);
    if (o) fn(o, n);
    pos = end + 1; n++;
  }
  return { bytes: pos, line: n };
}
