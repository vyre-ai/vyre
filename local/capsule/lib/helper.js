// @ts-check
// helper: the Capsule's client for bin/local, the Swift helper for Contacts, the Dictionary and
// result icons.
//
// It runs `local serve` once and keeps it: one JSON request per line in, one JSON answer per line
// out, matched by id. A spawn per keystroke would cost more than the lookup (see the header of
// swift/local.swift). The launcher calls this on every keystroke, so nothing here throws and
// nothing waits long: every call resolves, with an answer or with { error }, within its timeout.
//
// Contacts is a permission macOS asks about once, in a dialog. Only contacts() can cause that
// dialog, and only when macOS has never been asked. status() reads the permission without asking,
// so the Capsule can say why it wants access before anything appears on screen.
//
// The child is started on the first call, not in the constructor. If it dies it is started again
// on a later call, after a backoff that grows with each crash, so a helper that crashes on
// launch does not respawn once per keystroke.
//
// Clipboard: watchClips(true) has the helper poll the pasteboard; each new item arrives as an
// unsolicited {"event":"clip"} line and goes to `onClip`, never anywhere else. While watching is
// on, a helper that dies is restarted after the same backoff and told to watch again, since
// nothing else would call it while the Capsule is hidden. writeClip() puts the user's pick on the
// pasteboard; the user pastes it with their own Command-V.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";

export const NOT_BUILT = "not built: run vyre capsule build";

/** @typedef {{ id: string, name: string, org: string, emails: string[], phones: string[] }} Contact */
/** @typedef {{ kind: string, id: string, label: string, sub: string, last?: number, target: string }} Result */
/** @typedef {{ resolve: (v: any) => void, timer: NodeJS.Timeout }} Pending */

const BACKOFF = [0, 250, 1000, 4000, 15000];
export const ICONS_TIMEOUT_MS = 1500;
/** A child that has answered for this long is healthy again, and the backoff starts over. */
const HEALTHY_MS = 10_000;
export const CLIP_TIMEOUT_MS = 1000;

/** @typedef {{ count: number, at: number, app?: string, text?: string, truncated?: boolean, files?: string[], image?: boolean }} ClipItem */

export class LocalHelper {
  /**
   * @param {string} bin path to bin/local
   * @param {{ spawn?: typeof nodeSpawn, exists?: (p: string) => boolean, timeoutMs?: number, now?: () => number,
   *   onClip?: ((item: ClipItem) => void) | null }} [opts]
   */
  constructor(bin, { spawn = nodeSpawn, exists = fs.existsSync, timeoutMs = 300, now = () => Date.now(), onClip = null } = {}) {
    this.bin = bin;
    this.spawn = spawn;
    this.exists = exists;
    this.timeoutMs = timeoutMs;
    this.now = now;
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    /** @type {Map<number, Pending>} */
    this.pending = new Map();
    this.nextId = 1;
    this.crashes = 0;
    this.startedAt = 0;
    this.retryAt = 0;
    this.closed = false;
    /** Called with each clipboard item the helper records. Set it before watchClips(true). */
    this.onClip = onClip;
    /** @type {{ board?: string, ms?: number } | null} the watch to restore after a restart */
    this.clipWatch = null;
    /** @type {NodeJS.Timeout | null} */
    this.rewatchTimer = null;
  }

  /** The Contacts permission, never prompting. */
  status() { return this.#ask({ op: "status" }); }

  /** Contacts matching a name (or an exact email). The only call that may raise the dialog. */
  contacts(q, { limit = 8 } = {}) { return this.#ask({ op: "contacts", q: String(q ?? ""), limit }); }

  /**
   * The app in front right now, { bundle, pid, name }, or null when there is none or the helper
   * cannot say. For opens that do not come through the hotkey, whose line already carries it:
   * ask before the Capsule shows, or the answer is the Capsule. Asks macOS for no permission.
   * @returns {Promise<{ bundle: string, pid: number, name: string } | null>}
   */
  async front() {
    const a = await this.#ask({ op: "front" });
    const f = a && a.front;
    return f && typeof f.bundle === "string" && Number.isInteger(f.pid) ? { bundle: f.bundle, pid: f.pid, name: String(f.name || "") } : null;
  }

  /** The system dictionary's definition of a word: { word, definition } with null for none. */
  define(word) { return this.#ask({ op: "define", q: String(word ?? "") }); }

  /**
   * Icons for launcher rows, rendered to PNGs in `dir`: { icons: { [key]: path | null } }.
   * Each item is { key, kind, path?, target?, contact? } (see the icons section of local.swift).
   * A batch renders off the helper's main loop and may take longer than a lookup, hence its own
   * timeout. It never asks for Contacts: a contact gets its photo only if access is granted.
   * @param {{ key: string, kind: string, path?: string, target?: string, contact?: string }[]} items
   * @param {{ dir: string, size?: number, timeoutMs?: number }} opts
   */
  icons(items, { dir, size = 64, timeoutMs = ICONS_TIMEOUT_MS }) {
    return this.#ask({ op: "icons", items, size, dir }, timeoutMs);
  }

  /**
   * Start or stop the clipboard watcher: { watching, count } or { error }.
   * `board` names a private "vyre-" pasteboard (tests); omitted, it is the general one.
   * @param {boolean} on @param {{ board?: string, ms?: number }} [opts]
   */
  watchClips(on, { board, ms } = {}) {
    if (!on && this.rewatchTimer) { clearTimeout(this.rewatchTimer); this.rewatchTimer = null; }
    // Set after the ask: a first spawn inside it would otherwise send the watch twice.
    this.clipWatch = null;
    const answer = this.#ask({ op: "clip.watch", on: !!on, ...(board ? { board } : {}), ...(ms ? { ms } : {}) }, CLIP_TIMEOUT_MS);
    this.clipWatch = on ? { board, ms } : null;
    if (on && !this.child) this.#rewatch();   // asked inside a backoff: watch once it passes
    return answer;
  }

  /**
   * Put the user's pick on the pasteboard: { ok, count } or { error }. The helper marks the write
   * as its own, so the watcher does not record it again; `count` is the pasteboard's new count.
   * @param {{ text?: string, files?: string[], board?: string }} what
   */
  writeClip({ text, files, board }) {
    return this.#ask({ op: "clip.write", ...(text ? { text: String(text) } : {}), ...(files?.length ? { files } : {}),
      ...(board ? { board } : {}) }, CLIP_TIMEOUT_MS);
  }

  close() {
    this.closed = true;
    if (this.rewatchTimer) { clearTimeout(this.rewatchTimer); this.rewatchTimer = null; }
    this.#fail("closed");
    const c = this.child;
    this.child = null;
    if (c) { c.stdin?.end(); c.kill(); }
  }

  /** @returns {{ child: import("node:child_process").ChildProcess } | { error: string }} */
  #ensure() {
    if (this.closed) return { error: "closed" };
    if (this.child) return { child: this.child };
    if (!this.exists(this.bin)) return { error: NOT_BUILT };
    if (this.now() < this.retryAt) return { error: "restarting" };
    /** @type {import("node:child_process").ChildProcess} */
    let c;
    try {
      c = this.spawn(this.bin, ["serve"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      this.#crashed();
      return { error: `could not start: ${/** @type {Error} */ (e).message}` };
    }
    this.child = c;
    this.startedAt = this.now();
    if (this.clipWatch) {
      // A restarted helper forgets it was watching. The answer carries no pending id and is dropped.
      const { board, ms } = this.clipWatch;
      try { c.stdin?.write(JSON.stringify({ id: this.nextId++, op: "clip.watch", on: true, ...(board ? { board } : {}), ...(ms ? { ms } : {}) }) + "\n"); } catch {}
    }
    let buf = "";
    c.stdout?.setEncoding("utf8");
    c.stdout?.on("data", chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.#answer(line);
      }
    });
    const gone = () => {
      if (this.child !== c) return;
      this.child = null;
      this.#fail("helper stopped");
      if (!this.closed) { this.#crashed(); this.#rewatch(); }
    };
    c.on("exit", gone);
    c.on("error", gone);
    c.stdin?.on("error", () => {});
    return { child: c };
  }

  #crashed() {
    if (this.startedAt && this.now() - this.startedAt > HEALTHY_MS) this.crashes = 0;
    this.crashes++;
    this.retryAt = this.now() + BACKOFF[Math.min(this.crashes, BACKOFF.length - 1)];
  }

  /** Restart a helper that died while watching the clipboard, once its backoff has passed. */
  #rewatch() {
    if (!this.clipWatch || this.rewatchTimer) return;
    const wait = Math.max(0, this.retryAt - this.now()) + 10;
    this.rewatchTimer = setTimeout(() => {
      this.rewatchTimer = null;
      if (!this.clipWatch || this.child) return;
      const got = this.#ensure();
      // Still inside the backoff, or the spawn itself failed: try again later. Not built, or
      // closed: stop, rather than spin.
      if ("error" in got && (got.error === "restarting" || got.error.startsWith("could not start"))) this.#rewatch();
    }, wait);
    this.rewatchTimer.unref?.();
  }

  /** @param {string} line */
  #answer(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg && msg.event === "clip") {
      if (msg.item && typeof msg.item === "object") { try { this.onClip?.(msg.item); } catch {} }
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;                       // late, after its timeout: dropped
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const { id, ...rest } = msg;
    p.resolve(rest);
  }

  /** @param {string} why */
  #fail(why) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ error: why }); this.pending.delete(id); }
  }

  /** @param {Record<string, any>} req @param {number} [timeoutMs] @returns {Promise<any>} */
  #ask(req, timeoutMs = this.timeoutMs) {
    const got = this.#ensure();
    if ("error" in got) return Promise.resolve(got);
    const { child } = got;
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: "timeout" }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin?.write(JSON.stringify({ id, ...req }) + "\n");
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: "helper stopped" });
      }
    });
  }
}

/**
 * Contacts as launcher rows.
 * @param {Contact[]} contacts
 * @returns {Result[]}
 */
export function toResults(contacts) {
  return (contacts || []).map(c => ({
    kind: "contact",
    id: "contact:" + c.id,
    label: c.name || c.org || (c.emails || [])[0] || "",
    sub: c.org || (c.emails || [])[0] || "",
    last: 0,
    target: "addressbook://" + c.id,
  }));
}

/**
 * The gist of a dictionary entry. The system dictionary's text opens with the headword, its
 * syllables and pronunciation between bars, and a part of speech; the gist is what follows, up to
 * the end of the first sense.
 * @param {string} text
 */
export function firstSentence(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  const bar = t.lastIndexOf("|", 160);
  if (bar >= 0) t = t.slice(bar + 1).trim();
  t = t.replace(/^(noun|verb|adjective|adverb|pronoun|preposition|conjunction|exclamation|abbreviation|prefix|suffix|determiner)\b\s*/i, "");
  t = t.replace(/^\d+\s+/, "");
  const end = t.search(/[:.;](\s|$)/);
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

/**
 * A definition as a launcher row, or null when the dictionary has none.
 * @param {{ word: string, definition: string | null }} d
 * @returns {Result | null}
 */
export function toDefineResult(d) {
  if (!d || !d.word || !d.definition) return null;
  return {
    kind: "define",
    id: "define:" + d.word,
    label: d.word,
    sub: firstSentence(d.definition),
    target: "dict://" + encodeURIComponent(d.word),
  };
}
