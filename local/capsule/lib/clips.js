// @ts-check
// clips: the Capsule's clipboard history. Local only.
//
// What the user copies can be anything, so nothing in this file reaches vyred, an event, a log or
// the network (proposal section 5). Items come from the Swift helper's watcher (helper.js
// onClip), live in memory, and are written to one file the caller names, mode 0600, and nowhere
// else. Nothing here prints.
//
// Skipped, never stored at all: what the helper already drops (items marked concealed, transient
// or auto-generated, password-manager copies, the Capsule's own writes), and here anything that
// looks like a secret (looksSecret below). The filter errs on skipping: a clip history that lost a
// commit hash is a small cost; one that kept an API key is not.
//
// Picking a clip writes it back to the pasteboard. Pasting it into the front app is the user's
// own Command-V. The Capsule never types or pastes for them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { match } from "./local.js";

/** @typedef {import("./helper.js").ClipItem} ClipItem */
/** @typedef {{ h: string, kind: "text"|"files"|"image", text?: string, files?: string[], app?: string, t: number }} Clip */
/** @typedef {{ kind: "clip", id: string, label: string, sub: string, last: number, target: string, score: number }} ClipResult */

export const TEXT_MAX = 20_000;
export const LABEL_MAX = 200;
/** How much of a clip's text a query is matched against: enough to find it, cheap per keystroke. */
const MATCH_CHARS = 1000;
const PREFIX = /^(?:clipboard|clips?|paste)(?:\s+(.*))?$/i;
export const NOTE = "Copied. Press ⌘V to paste.";

// ---------------------------------------------------------------------------------------------
// Secrets

const TOKEN_PREFIX = new RegExp(
  "(?:^|[^A-Za-z0-9_])(?:" + [
    "sk-[A-Za-z0-9_-]{16,}", "sk_(?:live|test)_[A-Za-z0-9]{10,}", "[rp]k_(?:live|test)_[A-Za-z0-9]{10,}",
    "gh[pousr]_[A-Za-z0-9]{20,}", "github_pat_[A-Za-z0-9_]{20,}", "glpat-[A-Za-z0-9_-]{16,}",
    "xox[abposr]-[A-Za-z0-9-]{10,}", "xapp-[A-Za-z0-9-]{10,}", "(?:AKIA|ASIA)[0-9A-Z]{16}", "AIza[0-9A-Za-z_-]{30,}",
    "ya29\\.[0-9A-Za-z_-]{20,}", "npm_[A-Za-z0-9]{30,}", "pypi-[A-Za-z0-9_-]{30,}", "hf_[A-Za-z0-9]{30,}",
    "shp(?:at|ss|ca|pa)_[a-fA-F0-9]{20,}", "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}", "dop_v1_[a-f0-9]{40,}",
    "(?:sk|pk)-ant-[A-Za-z0-9_-]{16,}", "AC[a-f0-9]{32}", "SK[a-f0-9]{32}", "EAA[A-Za-z0-9]{40,}",
  ].join("|") + ")",
);
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----/;
/** `password = hunter2`, `API_KEY: ...`, `"token": "..."`, as in a .env file or a config. */
const ASSIGNED = /(?:pass(?:word|wd|phrase)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|bearer|credential|private[_-]?key)["']?\s*[:=]\s*["']?[^\s"']{6,}/i;
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/;
/** scheme://user:password@host */
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i;
const URL_SECRET_PARAM = /[?&#](?:access_token|id_token|refresh_token|token|api_?key|key|secret|client_secret|sig|signature|password|pwd|code|auth|X-Amz-Signature)=[^&\s]{6,}/i;
/** A one-time code on its own: 6 to 8 digits, maybe split in the middle. */
const OTP = /^(?:\d{6,8}|\d{3}[ -]\d{3}|\d{4}[ -]\d{4})$/;

/** Shannon entropy in bits per character. */
function entropy(s) {
  /** @type {Map<string, number>} */
  const n = new Map();
  for (const ch of s) n.set(ch, (n.get(ch) || 0) + 1);
  let e = 0;
  for (const c of n.values()) { const p = c / s.length; e -= p * Math.log2(p); }
  return e;
}

/** Card numbers: 13 to 19 digits that pass the Luhn check. */
function card(s) {
  const d = s.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = +d[d.length - 1 - i];
    if (i % 2) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

/**
 * A run of characters with no spaces that reads like a key: long, random, letters and digits.
 * Paths and plain URLs are not; a UUID or a commit hash is, and is skipped, on purpose.
 * @param {string} tok @param {number} min
 */
function randomToken(tok, min) {
  const t = tok.replace(/^["'`([{<]+|["'`)\]}>,;.]+$/g, "");
  if (t.length < min) return false;
  if (/^(?:[/~.]|[a-z][a-z0-9+.-]*:\/\/)/i.test(t)) return false;    // a path or a URL
  if (!/[0-9]/.test(t) || !/[A-Za-z]/.test(t)) return false;
  if (t.length >= 32 && /^[0-9a-f-]+$/i.test(t)) return true;          // a hash, a UUID, a hex key
  if (/^[A-Za-z]+(?:[-_.][A-Za-z]+)*[0-9]{0,4}$/.test(t)) return false; // words-joined-like-this2
  return entropy(t) >= (t.length >= 40 ? 3.3 : 3.6);
}

/**
 * Whether copied text looks like a secret and must not be kept. Errs on yes.
 * @param {string} text
 */
export function looksSecret(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (OTP.test(t) || card(t)) return true;
  if (TOKEN_PREFIX.test(t) || JWT.test(t) || PRIVATE_KEY.test(t) || ASSIGNED.test(t) || BEARER.test(t)) return true;
  if (URL_CREDENTIALS.test(t) || URL_SECRET_PARAM.test(t)) return true;
  if (!/\s/.test(t)) return randomToken(t, 20);                           // one word on its own
  // Longer text: any long random-looking token inside it (a pasted .env line, a curl command).
  return t.split(/\s+/).some(w => randomToken(w, 32));
}

// ---------------------------------------------------------------------------------------------
// Shape

const hash = s => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** @param {string} p */
const base = p => path.basename(p) || p;

/** @param {Clip} c */
export function label(c) {
  if (c.kind === "files") {
    const f = c.files || [];
    return f.length > 1 ? `${base(f[0])} and ${f.length - 1} more` : base(f[0] || "");
  }
  if (c.kind === "image") return "Image";
  const one = String(c.text || "").replace(/\s+/g, " ").trim();
  return one.length > LABEL_MAX ? one.slice(0, LABEL_MAX - 1).trimEnd() + "…" : one;
}

/** @param {number} ms */
export function age(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** @param {any} c @returns {c is Clip} */
function valid(c) {
  if (!c || typeof c !== "object" || typeof c.h !== "string" || typeof c.t !== "number") return false;
  if (c.kind === "text") return typeof c.text === "string" && !!c.text;
  if (c.kind === "files") return Array.isArray(c.files) && c.files.length > 0 && c.files.every(f => typeof f === "string");
  return c.kind === "image";
}

// ---------------------------------------------------------------------------------------------
// Store

export class Clips {
  /**
   * @param {{ file: string, helper: any, now?: () => number, max?: number, days?: number, delayMs?: number, board?: string }} opts
   * `board` is for tests: a private "vyre-" pasteboard in place of the general one.
   */
  constructor({ file, helper, now = Date.now, max = 200, days = 7, delayMs = 500, board }) {
    this.file = file;
    this.helper = helper;
    this.now = now;
    this.max = max;
    this.days = days;
    this.delayMs = delayMs;
    this.board = board;
    /** @type {Clip[]|null} newest first */
    this.items = null;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** Pasteboard counts of the Capsule's own writes, so a pick never returns as a new clip. */
    this.own = new Set();
  }

  /** Start watching the clipboard. Items arrive through the helper's onClip. */
  start() {
    if (!this.helper) return Promise.resolve({ error: "no helper" });
    this.helper.onClip = (/** @type {ClipItem} */ item) => { this.add(item); };
    return this.helper.watchClips(true, this.board ? { board: this.board } : {});
  }

  /** Stop watching, and write what is pending. */
  async stop() {
    const r = this.helper ? await this.helper.watchClips(false) : { watching: false };
    if (this.helper) this.helper.onClip = null;
    this.flush();
    return r;
  }

  /** @returns {Clip[]} */
  load() {
    if (this.items) return this.items;
    /** @type {Clip[]} */
    let items = [];
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (j && Array.isArray(j.items)) items = j.items.filter(valid);
    } catch {}
    this.items = items;
    this.prune();
    return this.items;
  }

  /** Drop what is past the age cap or the count cap. Returns whether anything went. */
  prune() {
    const items = /** @type {Clip[]} */ (this.items);
    const oldest = this.now() - this.days * 86400_000;
    const kept = items.filter(c => c.t >= oldest).slice(0, this.max);
    if (kept.length === items.length) return false;
    this.items = kept;
    this.schedule();
    return true;
  }

  /**
   * Record one item from the helper. Returns the stored clip, or null when it was skipped.
   * @param {ClipItem} item
   */
  add(item) {
    if (!item || typeof item !== "object") return null;
    if (typeof item.count === "number" && this.own.has(item.count)) { this.own.delete(item.count); return null; }
    const t = typeof item.at === "number" && item.at > 0 ? item.at : this.now();
    const app = typeof item.app === "string" && item.app ? item.app.slice(0, 80) : undefined;
    /** @type {Clip} */
    let c;
    if (Array.isArray(item.files) && item.files.length) {
      const files = item.files.filter(f => typeof f === "string" && f.startsWith("/")).slice(0, 50);
      if (!files.length) return null;
      c = { h: hash("files\0" + files.join("\0")), kind: "files", files, app, t };
    } else if (typeof item.text === "string") {
      if (!item.text.trim() || looksSecret(item.text)) return null;
      const text = item.text.length > TEXT_MAX ? item.text.slice(0, TEXT_MAX) : item.text;
      c = { h: hash("text\0" + text), kind: "text", text, app, t };
    } else if (item.image) {
      c = { h: hash("image\0" + t + "\0" + (item.count ?? "")), kind: "image", app, t };
    } else {
      return null;
    }
    const items = this.load();
    const i = items.findIndex(x => x.h === c.h);
    if (i >= 0) items.splice(i, 1);                      // the same thing again moves to the top
    items.unshift(c);
    this.prune();
    this.schedule();
    return c;
  }

  /** Every kept clip, newest first. */
  list() {
    this.load();
    this.prune();
    return [.../** @type {Clip[]} */ (this.items)];
  }

  /** @param {Clip} c @param {number} score @returns {ClipResult} */
  result(c, score) {
    const when = age(this.now() - c.t);
    return { kind: "clip", id: "clip:" + c.h, label: label(c), sub: c.app ? `${c.app} · ${when}` : when, last: c.t, target: "", score };
  }

  /**
   * Clips for the launcher box. A bare query scores each clip with local.js match() on its text,
   * so clips rank beside apps and files; only word-prefix and substring hits count, since a long
   * text contains nearly any letters in order. "clipboard", "clip" or "paste" first lists recent
   * clips in order (then filters by what follows), above everything else.
   * @param {string} query @param {number} [limit]
   * @returns {ClipResult[]}
   */
  search(query, limit = 8) {
    const q = String(query || "").trim();
    const items = this.list();
    const m = PREFIX.exec(q);
    if (m) {
      const rest = (m[1] || "").trim();
      const hits = rest ? items.filter(c => this.score(rest, c) > 0) : items;
      return hits.slice(0, limit).map((c, i) => this.result(c, 3 - i * 0.01));
    }
    if (q.length < 2) return [];
    /** @type {{ c: Clip, s: number }[]} */
    const hits = [];
    for (const c of items) {
      const s = this.score(q, c);
      if (s > 0) hits.push({ c, s });
    }
    hits.sort((a, b) => b.s - a.s || b.c.t - a.c.t);
    return hits.slice(0, limit).map(({ c, s }) => this.result(c, s));
  }

  /** @param {string} q @param {Clip} c */
  score(q, c) {
    const hay = c.kind === "files" ? (c.files || []).map(base).join(" ") : c.kind === "image" ? "image" : String(c.text).slice(0, MATCH_CHARS);
    const s = match(q, hay);
    return s >= 0.5 ? s : 0;
  }

  /**
   * The user picked a clip: put it back on the pasteboard for their own Command-V.
   * @param {string} id "clip:<hash>"
   * @returns {Promise<{ ok: true, note: string } | { error: string }>}
   */
  async pick(id) {
    const h = String(id || "").replace(/^clip:/, "");
    const items = this.load();
    const c = items.find(x => x.h === h);
    if (!c) return { error: "That clip is gone." };
    if (c.kind === "image") return { error: "Only a note of the image was kept, not the image." };
    if (!this.helper) return { error: "the clipboard helper is not built (vyre capsule build)" };
    const r = await this.helper.writeClip({ ...(c.kind === "files" ? { files: c.files } : { text: c.text }), ...(this.board ? { board: this.board } : {}) });
    if (!r || r.error) return { error: r && r.error ? `Could not copy: ${r.error}` : "Could not copy." };
    if (typeof r.count === "number") {
      this.own.add(r.count);
      if (this.own.size > 16) this.own.delete(this.own.values().next().value);
    }
    // Picked again, so it is recent again.
    const i = items.indexOf(c);
    if (i > 0) { items.splice(i, 1); items.unshift(c); }
    c.t = this.now();
    this.schedule();
    return { ok: true, note: NOTE };
  }

  /** Forget one clip. */
  remove(id) {
    const h = String(id || "").replace(/^clip:/, "");
    const items = this.load();
    const i = items.findIndex(x => x.h === h);
    if (i < 0) return false;
    items.splice(i, 1);
    this.schedule();
    return true;
  }

  /** Forget every clip, and write that down now. */
  clear() {
    this.items = [];
    this.own.clear();
    this.flush();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delayMs);
    this.timer.unref?.();
  }

  /** Write now, 0600, temp file then rename, so a crash never leaves half a file. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.items) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items }), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }
}
