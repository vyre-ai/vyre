// @ts-check
// launcher: what a bare query finds on this Mac, and what picking a result does.
//
// The Capsule reads every keystroke, including the ones the user deletes, so nothing here reaches
// vyred, a log or the network (proposal section 5). Results come from local.js, calc.js and the
// Swift helper; route.js ranks them with Vyre's own. It all works with vyred down (floor rule 9).
//
// Two speeds. `quick()` answers from memory and the helper (apps, settings, the calculator,
// contacts, a definition), fast enough for every keystroke. `full()` adds files from `mdfind`,
// which takes hundreds of milliseconds, so the page draws `quick()` first and swaps in `full()`
// when it lands, if the box still says the same thing.
//
// Contacts: macOS asks the user once, in a dialog. The Capsule never raises that dialog from
// typing. Until it has been asked, a query that could be a person shows one row offering contacts,
// and the dialog appears only when the user picks that row.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as local from "./local.js";
import * as route from "./route.js";
import { evaluate } from "./calc.js";
import { toResults, toDefineResult } from "./helper.js";
import { watchWords } from "./watch.js";
import * as glass from "./glass.js";

/** @typedef {route.Result} Result */

const DEFINE = /^(?:define|definition of|meaning of|what does)\s+([a-z][a-z' -]{1,40}?)(?:\s+mean)?\s*\??$/i;
const MEANING = /^([a-z][a-z'-]{1,40})\s+(?:meaning|definition|define)\s*$/i;

/** A word to look up, when the box asks for one. */
export function defineWord(text) {
  const t = String(text || "").trim();
  const m = DEFINE.exec(t) || MEANING.exec(t);
  return m ? m[1].trim() : null;
}

/** Could this be someone's name: letters, at most three words, no digits. */
const personish = t => /^[\p{L}][\p{L}'.-]*(\s[\p{L}][\p{L}'.-]*){0,2}$/u.test(t) && t.length >= 3;

const CLIPS = /^(clipboard|clips?|paste)\b/i;

const BOX_TIMEOUT = 1200;
const LINK_TTL = 30_000;
const UNREACHABLE = "The box is not reachable right now.";

/** @typedef {(tool: string, input: object) => Promise<{ data?: any, error?: any }>} Vyred */

const errText = e => (e && typeof e === "object" ? String(e.message || e.code || "") : String(e || ""));
const boxDown = e => /unreach|timeout|timed out|not linked|offline|ECONN|EHOST|down|refused/i.test(errText(e) + " " + (e && e.code ? e.code : ""));

const GRANT = /** @type {Result} */ ({ kind: "grant", id: "grant:contacts", label: "Show contacts here",
  sub: "macOS asks once. They stay on this Mac.", target: "", score: 0.2 });

export class Launcher {
  /**
   * @param {{ apps?: local.Apps, helper?: any, frecency?: local.Frecency|null, files?: typeof local.files,
   *   open?: typeof local.open, run?: typeof execFile, copy?: (text: string) => void, clips?: any,
   *   vyred?: Vyred|null, boxName?: string|null, visible?: () => boolean, boxTimeoutMs?: number, now?: () => number }} [deps]
   */
  constructor({ apps = new local.Apps(), helper = null, frecency = null, files = local.files, open = local.open, run = execFile, copy = () => {}, clips = null,
    vyred = null, boxName = null, providers = null, visible = () => true, boxTimeoutMs = BOX_TIMEOUT, now = Date.now } = {}) {
    /** @type {Vyred|null} (tool, input) => { data } | { error }, on the Mac's own vyred socket; null keeps files to this Mac */
    this.vyred = vyred;
    /** @type {any} modules' results and actions (lib/providers.js), or null */
    this.providers = providers;
    /** @type {string|null} what box rows say they came from; link.status's name when not given */
    this.boxName = boxName;
    /** Whether the Capsule is on screen. Nothing about box files runs while it is hidden. */
    this.visible = visible;
    this.boxTimeoutMs = boxTimeoutMs;
    this.now = now;
    /** @type {{ linked: boolean, at: number }|null} link.status, asked at most every 30 s */
    this.link = null;
    /** @type {any} clipboard history (lib/clips.js), or null */
    this.clips = clips;
    this.apps = apps;
    this.helper = helper;
    this.frecency = frecency;
    this.filesFn = files;
    this.openFn = open;
    this.run = run;
    this.copy = copy;
    /** @type {string|null} authorized | denied | notDetermined | ... ; null until asked */
    this.contactsStatus = null;
    /** @type {AbortController|null} */
    this.pending = null;
    /** @type {string|null} the paired box, as the last catalog said; Glass opens only there */
    this.box = null;
  }

  /** Warm what the first keystroke needs: the app list, and whether contacts may be read. */
  async warm() {
    await this.apps.list().catch(() => {});
    if (this.helper && (this.contactsStatus === null || this.contactsStatus === "notDetermined")) {
      const s = await this.helper.status();
      this.contactsStatus = s && s.status ? String(s.status) : "unavailable";
    }
  }

  boost = (id, q) => (this.frecency ? this.frecency.boost(id, q) : 0);

  /**
   * What the box finds right now, without files.
   * @param {string} text @param {route.Catalog|null} cat
   * @returns {Promise<{ results: Result[], intent: "open"|"ask" }>}
   */
  async quick(text, cat) {
    const q = String(text || "").trim();
    if (!q) return { results: [], intent: "ask" };
    /** @type {Result[]} */
    const extra = [];
    const c = evaluate(q);
    if (c) extra.push({ ...c, target: "", score: 2 });
    const word = defineWord(q);
    const [people, def] = await Promise.all([this.people(q), word && this.helper ? this.helper.define(word) : null]);
    extra.push(...people);
    // "tell the intake thread to run the tests": the row names the thread and the words, so what
    // is sent and where is on screen before Enter (floor rule 2). It is sent as the user, and
    // watched, so the answer comes back here.
    const drive = /^(?:tell|ask)\s+(?:the\s+)?(.+?)(?:\s+thread)?\s+to\s+(.+)$/i.exec(q);
    if (drive && cat) for (const t of (cat.threads || [])) {
      const m = local.match(drive[1], t.label || "");
      if (m >= 0.5) extra.push({ kind: "drive", id: "drive:" + t.id, label: `Tell ${t.label}: ${drive[2]}`, sub: "sent as you, then watched", target: t.id,
        text: drive[2], thread: t.label, score: 1.85 + m / 10 });
    }
    // "watch the intake thread": a row per thread it could mean, to be told when it is done.
    const target = watchWords(q);
    if (target && cat) for (const t of (cat.threads || [])) {
      const m = local.match(target, t.label || "");
      if (m >= 0.5) extra.push({ kind: "watch", id: "watch:" + t.id, label: `Watch ${t.label}`, sub: "tell me when it is done or asks", target: t.id, score: 1.8 + m / 10 });
    }
    if (this.clips) {
      const found = this.clips.search(q, 6);
      extra.push(...found);
      // Listing the history ("clip", "clipboard", "paste"): the way to forget it all is right there.
      if (CLIPS.test(q)) extra.push({ kind: "clipclear", id: "clipclear", label: "Clear clipboard history", sub: found.length ? `${this.clips.list().length} items, on this Mac only` : "nothing kept", target: "", score: 0.01 });
    }
    const d = def && !def.error ? toDefineResult(def) : null;
    if (d) extra.push({ ...d, last: 0, score: 1.5 });
    this.box = cat ? glass.origin(/** @type {glass.Catalog} */ (cat).box) : null;
    extra.push(...glass.results(q, cat));
    const local_ = [...this.apps.search(q, 6, this.boost), ...local.settings(q, 4, this.boost)];
    let results = route.rank(q, { local: local_, extra, cat, boost: this.boost });
    // The contacts offer is for a query that found nothing better; "wifi" does not need it.
    if (results.some(r => r.kind !== "grant" && (r.score || 0) >= 0.8)) results = results.filter(r => r.kind !== "grant");
    return { results, intent: route.intent(q, results) };
  }

  /**
   * quick() plus files. A newer call cancels the mdfind of an older one. When a box is linked, its
   * files are asked for alongside mdfind with their own short timeout; if they land after the
   * Mac's files, `onMore` gets the list again with them in, so a slow box never holds up this Mac.
   * @param {string} text @param {route.Catalog|null} cat
   * @param {(more: { results: Result[], intent: "open"|"ask" }) => void} [onMore]
   */
  async full(text, cat, onMore) {
    this.pending?.abort();
    const ctl = new AbortController();
    this.pending = ctl;
    const q = String(text || "").trim();
    /** @type {Result[]|null} */
    let box = null;
    const boxP = this.boxFiles(q, ctl.signal).then(b => (box = b));
    // Results from modules that offer them to the Capsule (the vault's names, say): names only,
    // on this slow path, and late like box files when they take longer than the Mac's own.
    /** @type {Result[]|null} */
    let mods = this.providers && this.visible() ? null : [];
    const modsP = mods ? Promise.resolve(mods) : this.providers.search(q).catch(() => []).then(m => (mods = m));
    const [base, found] = await Promise.all([this.quick(q, cat), this.filesFn(q, { signal: ctl.signal })]);
    if (ctl.signal.aborted) return null;
    const answer = () => {
      let results = route.rank(q, { local: [...base.results, ...(mods || [])], files: found, box: box || [], cat: null, boost: this.boost });
      if (results.some(r => r.kind !== "grant" && (r.score || 0) >= 0.8)) results = results.filter(r => r.kind !== "grant");
      return { results, intent: route.intent(q, results) };
    };
    if (onMore) {
      if (box === null) boxP.then(b => { if (b.length && !ctl.signal.aborted && this.visible()) onMore(answer()); });
      if (mods === null) modsP.then(m => { if (m.length && !ctl.signal.aborted && this.visible()) onMore(answer()); });
    }
    return answer();
  }

  /** Is a box linked? link.status, remembered for 30 s; also learns the box's name. */
  async linked() {
    if (!this.vyred) return false;
    if (this.link && this.now() - this.link.at < LINK_TTL) return this.link.linked;
    const r = await this.vyred("link.status", {}).catch(e => ({ error: e }));
    const d = r && r.data;
    const linked = Boolean(d && d.linked && d.box);
    if (linked && !this.boxName) this.boxName = d.box.name || d.box.address || null;
    this.link = { linked, at: this.now() };
    return linked;
  }

  /**
   * Files on the box matching `q`, as result rows, or [] when there is no box, it is slow (past
   * `boxTimeoutMs`), down, or the Capsule is hidden. Never throws.
   * @param {string} q @param {AbortSignal} [signal] @returns {Promise<Result[]>}
   */
  async boxFiles(q, signal) {
    if (!this.vyred || q.length < 2 || !this.visible() || signal?.aborted) return [];
    let timer;
    const late = new Promise(res => { timer = setTimeout(() => res(null), this.boxTimeoutMs); });
    const ask = (async () => {
      if (!(await this.linked()) || signal?.aborted || !this.visible()) return null;
      return this.vyred("files.search", { q, where: "box", limit: 20 });
    })().catch(() => null);
    const r = await Promise.race([ask, late]);
    clearTimeout(timer);
    const rows = r && r.data && Array.isArray(r.data.results) ? r.data.results : [];
    const name = this.boxName || "box";
    return rows.filter(x => x && x.source === "box" && typeof x.path === "string" && x.path.startsWith("/") && !local.noise(x.path))
      .map(x => /** @type {Result} */ ({ kind: "boxfile", id: "box:" + x.path, label: String(x.name || path.basename(x.path)),
        sub: `${name} · ${path.dirname(x.path).replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~")}`, last: Date.parse(x.mtime) || 0,
        target: x.path, source: "box", fileKind: x.kind ? String(x.kind) : undefined }));
  }

  /**
   * What the page can show beside a result: the box's own preview for a box file, the first 4 kB
   * of a text file on this Mac, or null.
   * @param {Result} r
   */
  async preview(r) {
    if (!r || typeof r.target !== "string" || !r.target.startsWith("/")) return null;
    if (r.kind === "boxfile") {
      if (!this.vyred) return null;
      const p = await this.vyred("files.preview", { path: r.target, source: "box" }).catch(() => null);
      return p && p.data ? p.data : null;
    }
    if (r.kind !== "file") return null;
    let fh;
    try {
      fh = await fs.promises.open(r.target, "r");
      const buf = Buffer.alloc(4097);
      const { bytesRead } = await fh.read(buf, 0, 4097, 0);
      const head = buf.subarray(0, Math.min(bytesRead, 4096));
      if (head.includes(0)) return null; // binary
      // stream: a multi-byte character cut at 4096 is left out, not drawn as a replacement mark.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytesRead > 4096 });
      return { kind: "text", mime: "text/plain", text, truncated: bytesRead > 4096 };
    } catch { return null; } finally { await fh?.close().catch(() => {}); }
  }

  /** Contacts matching `q`, or the one row that offers them, or nothing. */
  async people(q) {
    if (!this.helper || !personish(q)) return [];
    if (this.contactsStatus === "notDetermined") return [{ ...GRANT }];
    if (this.contactsStatus !== "authorized" && this.contactsStatus !== "limited") return [];
    const r = await this.helper.contacts(q, { limit: 4 });
    if (!r || r.error) return [];
    return toResults(r.contacts).map(x => ({ ...x, score: local.match(q, x.label) + this.boost(x.id, q) })).filter(x => x.score > 0);
  }

  /**
   * The user picked a result. Returns what the page should say, and whether the Capsule should go.
   * @param {Result} r @param {string} query
   * @returns {Promise<{ ok?: true, error?: string, note?: string, close?: boolean }>}
   */
  async pick(r, query) {
    if (!r || typeof r !== "object") return { error: "nothing picked" };
    if (r.kind === "grant") {
      if (!this.helper) return { error: "the contacts helper is not built (vyre capsule build)" };
      // The one place the Contacts dialog can come from: the user asked for it.
      const a = await this.helper.contacts("", { limit: 1 });
      const s = await this.helper.status();
      this.contactsStatus = s && s.status ? String(s.status) : this.contactsStatus;
      if (this.contactsStatus === "authorized") return { ok: true, note: "Contacts will show here now." };
      if (a && a.error === "asking") return { ok: true, note: "macOS is asking. Answer its dialog, then type again." };
      return { error: "Contacts are off for Vyre. Turn them on in System Settings, Privacy & Security, Contacts." };
    }
    if (r.kind === "module") return { error: "choose an action for it" };
    if (r.kind === "clip") {
      if (!this.clips) return { error: "no clipboard history here" };
      const c = await this.clips.pick(r.id);
      return "error" in c ? { error: c.error } : { ok: true, note: c.note, close: true };
    }
    if (r.kind === "clipclear") { this.clips?.clear(); return { ok: true, note: "Clipboard history cleared." }; }
    this.frecency?.pick(r.id, query);
    if (r.kind === "calc") { this.copy(String(r.copy ?? r.label)); return { ok: true, note: `Copied ${r.copy ?? r.label}`, close: true }; }
    if (r.kind === "app" || r.kind === "file" || r.kind === "folder" || r.kind === "setting") {
      const o = await this.openFn(/** @type {any} */ (r));
      return "error" in o ? { error: o.error } : { ok: true, close: true };
    }
    if (r.kind === "boxfile") return this.fetch(r);
    if (r.kind === "glass") return glass.open(this.box, String(/** @type {glass.Result} */ (r).glass || ""), this.run);
    if (r.kind === "contact" || r.kind === "define") {
      const url = String(r.target || "");
      // Only the two schemes this file makes, with nothing that could read as a flag.
      if (!/^(addressbook:\/\/[\w:.-]+|dict:\/\/[\w%.'-]+)$/.test(url)) return { error: "not something the Capsule opens" };
      return new Promise(resolve => {
        this.run("/usr/bin/open", [url], err => resolve(err ? { error: String(err.message || err) } : { ok: true, close: true }));
      });
    }
    return { error: `the Capsule does not open ${r.kind} results` };
  }

  /**
   * Open a box file. When a Taildrive share holding it is mounted (files.drive.local), open it
   * there, where edits land on the box. Otherwise pull a copy to this Mac (vyred puts it under
   * its fetched folder) and open that.
   */
  async fetch(r) {
    const name = this.boxName || "the box";
    if (!this.vyred) return { error: UNREACHABLE };
    const m = await this.vyred("files.drive.local", { path: r.target }).catch(() => null);
    const mounted = m && m.data && typeof m.data.local === "string" && path.isAbsolute(m.data.local) ? m.data.local : "";
    if (mounted) {
      const o = await this.openFn(/** @type {any} */ ({ ...r, kind: "file", target: mounted }));
      if (!("error" in o)) return { ok: true, close: true };
    }
    const f = await this.vyred("files.fetch", { path: r.target, source: "box" }).catch(e => ({ error: e }));
    const localPath = f && f.data && typeof f.data.local === "string" ? f.data.local : "";
    if (!localPath || !path.isAbsolute(localPath)) {
      const e = f && f.error;
      return { error: !e || boxDown(e) ? UNREACHABLE : `Could not fetch it from ${name}: ${errText(e) || "no file came back"}.` };
    }
    const o = await this.openFn(/** @type {any} */ ({ ...r, kind: "file", target: localPath }));
    return "error" in o ? { error: o.error } : { ok: true, close: true, note: `Fetched from ${name}.` };
  }

  close() { this.pending?.abort(); this.helper?.close?.(); this.frecency?.flush?.(); }
}
