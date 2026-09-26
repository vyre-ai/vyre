// @ts-check
// icons: the pictures beside launcher rows, as file:// URLs of PNGs in a cache directory.
//
// bin/local renders them (the `icons` op in swift/local.swift): an app's icon, a file's type icon
// or QuickLook thumbnail, a settings pane's icon, a contact's photo. This file decides what to
// ask for and keeps what came back:
//
//   key     what identifies one picture: path + mtime for apps, files and folders (so an app
//           update gets its new icon), the settings URL, or the contact id
//   file    <dir>/<first 32 hex of sha256(key)>.png, the same name the helper writes, so a file
//           rendered in an earlier run (or after a request timed out) is found without asking
//   memory  key -> URL for what this process has seen, result id -> URL for peek()
//
// One get() sends its misses to the helper as one request (split at BATCH items), and a key
// already on its way is awaited, not asked for twice. The directory is an LRU by mtime: a hit
// touches its file (at most once per TOUCH_MS), and prune() deletes the oldest files while there
// are more than maxFiles or more than maxBytes. get() prunes on its first call and then at most
// once a minute. Nothing runs until get() is called, and get() never throws: with no helper, or
// a failing one, it answers with what the disk already has, or {}.
//
// Kinds other than app, file, folder, setting and contact get nothing: the page draws those.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ kind: string, id: string, label?: string, target?: string }} Result */
/** @typedef {{ key: string, kind: string, path?: string, target?: string, contact?: string }} Item */
/** @typedef {{ url: string, file: string, touched: number }} Known */

export const KINDS = new Set(["app", "file", "folder", "setting", "contact"]);
export const BATCH = 40;
const PANE = "x-apple.systempreferences:";
const BOOK = "addressbook://";
const PRUNE_EVERY_MS = 60_000;
const TOUCH_MS = 3_600_000;
/** How long a "no picture" answer (a contact without a photo, say) is believed. */
const NONE_MS = 300_000;

/** The cache file name for a key; swift/local.swift iconName() computes the same. */
export function iconFile(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32) + ".png";
}

export class Icons {
  /**
   * @param {{ dir: string, helper?: { icons: (items: Item[], o: { dir: string, size?: number }) => Promise<any> } | null,
   *   maxFiles?: number, maxBytes?: number, size?: number,
   *   stat?: (p: string) => Promise<{ mtimeMs: number }>, now?: () => number }} opts
   */
  constructor({ dir, helper = null, maxFiles = 1500, maxBytes = 24e6, size = 64, stat = p => fs.promises.stat(p), now = () => Date.now() }) {
    this.dir = dir;
    this.helper = helper;
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.size = size;
    this.stat = stat;
    this.now = now;
    /** @type {Map<string, Known>} */
    this.known = new Map();
    /** @type {Map<string, number>} key -> when the helper said it has no picture */
    this.none = new Map();
    /** @type {Map<string, string>} result id -> URL */
    this.byId = new Map();
    /** @type {Map<string, Promise<string | null>>} */
    this.inflight = new Map();
    this.prunedAt = -Infinity;
    /** @type {Promise<void> | null} */
    this.pruning = null;
    this.made = false;
  }

  /**
   * URLs for the rows that have a picture, rendering what is missing. Never throws.
   * @param {Result[]} results @returns {Promise<Record<string, string>>}
   */
  async get(results) {
    try {
      return await this.#get(results);
    } catch {
      return {};
    } finally {
      this.#maybePrune();
    }
  }

  /**
   * What is already known in memory, synchronously: for painting a row before get() answers.
   * @param {Result[]} results @returns {Record<string, string>}
   */
  peek(results) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const r of results || []) {
      const url = r && this.byId.get(r.id);
      if (url) out[r.id] = url;
    }
    return out;
  }

  /** Delete the least recently used files while over either bound. Never throws. */
  prune() {
    if (this.pruning) return this.pruning;
    this.prunedAt = this.now();
    this.pruning = this.#prune().catch(() => {}).finally(() => { this.pruning = null; });
    return this.pruning;
  }

  #maybePrune() {
    if (this.now() - this.prunedAt >= PRUNE_EVERY_MS) void this.prune();
  }

  async #prune() {
    let names;
    try { names = await fs.promises.readdir(this.dir); } catch { return; }
    const files = [];
    for (const n of names) {
      if (!n.endsWith(".png")) continue;
      const file = path.join(this.dir, n);
      try {
        const st = await fs.promises.stat(file);
        files.push({ file, mtime: st.mtimeMs, size: st.size });
      } catch { /* gone already */ }
    }
    let count = files.length;
    let bytes = files.reduce((a, f) => a + f.size, 0);
    if (count <= this.maxFiles && bytes <= this.maxBytes) return;
    files.sort((a, b) => a.mtime - b.mtime);
    const gone = new Set();
    for (const f of files) {
      if (count <= this.maxFiles && bytes <= this.maxBytes) break;
      try { await fs.promises.unlink(f.file); } catch { continue; }
      gone.add(f.file);
      count--;
      bytes -= f.size;
    }
    const urls = new Set();
    for (const [key, k] of this.known) if (gone.has(k.file)) { this.known.delete(key); urls.add(k.url); }
    for (const [id, url] of this.byId) if (urls.has(url)) this.byId.delete(id);
  }

  /** @param {Result} r @returns {Promise<Item | null>} */
  async #item(r) {
    if (!r || !KINDS.has(r.kind)) return null;
    const target = String(r.target || "");
    if (r.kind === "setting") {
      return target.startsWith(PANE) ? { key: "setting:" + target, kind: "setting", target } : null;
    }
    if (r.kind === "contact") {
      const id = target.startsWith(BOOK) ? target.slice(BOOK.length) : "";
      return id ? { key: "contact:" + id, kind: "contact", contact: id } : null;
    }
    if (!path.isAbsolute(target)) return null;
    let st;
    try { st = await this.stat(target); } catch { return null; }
    return { key: `${r.kind}:${target}@${Math.round(Number(st.mtimeMs) || 0)}`, kind: r.kind, path: target };
  }

  /** @param {Result[]} results */
  async #get(results) {
    const rows = (await Promise.all((results || []).map(async r => ({ r, item: await this.#item(r) }))))
      .filter(x => x.item);
    if (!rows.length) return {};
    if (!this.made) {
      await fs.promises.mkdir(this.dir, { recursive: true });
      this.made = true;
    }
    /** @type {Map<string, Item>} misses of this call, by key */
    const mine = new Map();
    /** @type {Map<string, (v: string | null) => void>} */
    const settle = new Map();
    for (const { item } of rows) {
      const it = /** @type {Item} */ (item);
      if (this.known.has(it.key) || this.inflight.has(it.key) || mine.has(it.key)) continue;
      const t = this.none.get(it.key);
      if (t !== undefined && this.now() - t < NONE_MS) continue;
      mine.set(it.key, it);
      this.inflight.set(it.key, new Promise(res => settle.set(it.key, res)));
    }
    if (mine.size) await this.#fetch(mine, settle);

    /** @type {Record<string, string>} */
    const out = {};
    await Promise.all(rows.map(async ({ r, item }) => {
      const key = /** @type {Item} */ (item).key;
      const url = this.#hit(key) ?? (this.inflight.has(key) ? await this.inflight.get(key) : null);
      if (url) { out[r.id] = url; this.byId.set(r.id, url); }
    }));
    return out;
  }

  /** The URL for a key this process knows, touching its file now and then. @param {string} key */
  #hit(key) {
    const k = this.known.get(key);
    if (!k) return null;
    if (this.now() - k.touched >= TOUCH_MS) {
      k.touched = this.now();
      const s = k.touched / 1000;
      fs.promises.utimes(k.file, s, s).catch(() => {});
    }
    return k.url;
  }

  /** @param {string} key @param {string} file @param {number} touched */
  #keep(key, file, touched) {
    const url = pathToFileURL(file).href;
    this.known.set(key, { url, file, touched });
    this.none.delete(key);
    return url;
  }

  /**
   * Settle every key in `mine`: from the disk if an earlier run left the file, else from one
   * helper request per BATCH items.
   * @param {Map<string, Item>} mine @param {Map<string, (v: string | null) => void>} settle
   */
  async #fetch(mine, settle) {
    /** @type {(key: string, url: string | null) => void} */
    const done = (key, url) => {
      if (!settle.has(key)) return;
      this.inflight.delete(key);
      settle.get(key)?.(url);
      settle.delete(key);
    };
    try {
      /** @type {Item[]} */
      const ask = [];
      await Promise.all([...mine.values()].map(async it => {
        const file = path.join(this.dir, iconFile(it.key));
        try {
          await fs.promises.access(file);
          const s = this.now() / 1000;
          await fs.promises.utimes(file, s, s).catch(() => {});
          done(it.key, this.#keep(it.key, file, this.now()));
        } catch {
          ask.push(it);
        }
      }));
      if (!ask.length || !this.helper) return;
      const chunks = [];
      for (let i = 0; i < ask.length; i += BATCH) chunks.push(ask.slice(i, i + BATCH));
      await Promise.all(chunks.map(async chunk => {
        let a;
        try { a = await this.helper?.icons(chunk, { dir: this.dir, size: this.size }); } catch { a = null; }
        const icons = a && typeof a.icons === "object" && a.icons ? a.icons : null;
        if (!icons) return;                           // failed or timed out: nothing learned, ask again later
        for (const it of chunk) {
          const p = icons[it.key];
          if (typeof p === "string" && path.isAbsolute(p)) done(it.key, this.#keep(it.key, p, this.now()));
          else if (it.key in icons) { this.none.set(it.key, this.now()); done(it.key, null); }
        }
      }));
    } finally {
      for (const key of [...settle.keys()]) done(key, null);
    }
  }
}
