// @ts-check
// local: what the Capsule can find on this Mac without asking anyone: apps, files, settings panes.
//
// A launcher reads every keystroke, including the ones the user deletes, so everything here is
// transient (proposal section 5). Nothing in this file emits a vyred event, logs a query, or
// touches the network: apps come from a directory listing, files from a local `mdfind`, settings
// from a table below. The one thing written to disk is the frecency file, and it holds result ids
// and short query prefixes, never whole queries. All of it works with vyred down (floor rule 9).
//
// Every result has one shape, so the renderer can merge these with route.js's candidates and rank
// them in one list (proposal section 4). `match()` keeps route.js's order of tiers
// (exact > prefix > word-prefix > substring) on a 0..1 scale, and `Frecency.boost()` adds to it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

/**
 * @typedef {{ kind: "app"|"file"|"folder"|"setting", id: string, label: string, sub: string, last: number, target: string, score?: number }} Result
 * @typedef {(id: string, query: string) => number} Boost
 */

const HOME = os.homedir();

/** "/Users/x/Documents/a" reads as "~/Documents/a". */
export function tilde(p, home = HOME) {
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

// ---------------------------------------------------------------------------------------------
// match

const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const compact = s => s.replace(/[^a-z0-9]+/g, "");

/** Words of a label, split on punctuation, spaces and camelCase: "VisualStudio Code" -> visual, studio, code. */
function wordsOf(label) {
  return String(label || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/** Score one label against a query, 0..1. */
function score1(q, label) {
  const l = fold(label);
  if (!l) return 0;
  const qc = compact(q), lc = compact(l);
  if (l === q || (qc && lc === qc)) return 1;
  if (l.startsWith(q) || (qc && lc.startsWith(qc))) return 0.9;
  const ws = wordsOf(label);
  if (ws.some(w => w.startsWith(qc || q))) return 0.8;
  // Initials: "vsc" for Visual Studio Code, "ss" for Screen Sharing.
  if (qc.length >= 2 && ws.length >= 2 && ws.map(w => w[0]).join("").startsWith(qc)) return 0.8;
  if (l.includes(q) || (qc.length >= 2 && lc.includes(qc))) return 0.5;
  if (qc.length >= 2 && isSubsequence(qc, lc)) return 0.3;
  return 0;
}

/**
 * How well `query` names `label`, 0..1: exact 1, prefix 0.9, word-prefix or initials 0.8,
 * substring 0.5, in-order letters 0.3, else 0. A synonym counts slightly less than the label
 * itself, so "Wi-Fi" typed out still beats a pane that only lists "wifi" as a synonym.
 * @param {string} query @param {string} label @param {string[]} [synonyms]
 */
export function match(query, label, synonyms = []) {
  const q = fold(query).trim();
  if (!q) return 0;
  let best = score1(q, label);
  if (best === 1) return 1;
  for (const s of synonyms) best = Math.max(best, score1(q, s) * 0.95);
  return best;
}

/** Rank scored rows: score (plus boost) first, then shorter label, then name. */
function rank(rows, query, limit, boost) {
  const out = [];
  for (const { r, syn } of rows) {
    const m = match(query, r.label, syn);
    if (m <= 0) continue;
    out.push({ r, s: m + (boost ? boost(r.id, query) : 0) });
  }
  out.sort((a, b) => b.s - a.s || a.r.label.length - b.r.label.length || a.r.label.localeCompare(b.r.label));
  return out.slice(0, limit).map(x => ({ ...x.r, score: x.s }));
}

// ---------------------------------------------------------------------------------------------
// Apps

export const APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications",
  "/System/Applications/Utilities", path.join(HOME, "Applications")];

const TTL = 60_000;

/**
 * The installed apps, from a plain directory listing. Names are the bundle name minus ".app";
 * no Info.plist is read, which keeps a full scan to a few milliseconds.
 */
export class Apps {
  /** @param {{ dirs?: string[], ttl?: number, now?: () => number, home?: string }} [opts] */
  constructor({ dirs = APP_DIRS, ttl = TTL, now = Date.now, home = HOME } = {}) {
    this.dirs = dirs; this.ttl = ttl; this.now = now; this.home = home;
    /** @type {Result[]} */ this.cache = [];
    this.at = -Infinity;
    /** @type {Promise<Result[]>|null} */ this.pending = null;
  }

  /** Every app, rescanned at most once per `ttl`. */
  async list() {
    if (this.now() - this.at < this.ttl) return this.cache;
    return this.refresh();
  }

  /** Rescan now. Concurrent calls share one scan. */
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.scan().then(apps => {
      this.cache = apps; this.at = this.now(); this.pending = null;
      return apps;
    }, err => { this.pending = null; throw err; });
    return this.pending;
  }

  async scan() {
    const seen = new Set();
    /** @type {Result[]} */
    const out = [];
    const add = full => {
      if (seen.has(full)) return;
      seen.add(full);
      const name = path.basename(full).replace(/\.app$/i, "");
      out.push({ kind: "app", id: `app:${full}`, label: name, sub: tilde(path.dirname(full), this.home), last: 0, target: full });
    };
    const read = async dir => {
      try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
    };
    await Promise.all(this.dirs.map(async dir => {
      const nested = [];
      for (const e of await read(dir)) {
        if (e.name.startsWith(".")) continue;
        if (/\.app$/i.test(e.name)) add(path.join(dir, e.name));
        // One level down, for vendor folders like "/Applications/Adobe X/". Utilities folders
        // are listed in `dirs` themselves, so scanning them twice only dedupes.
        else if (e.isDirectory()) nested.push(path.join(dir, e.name));
      }
      await Promise.all(nested.map(async sub => {
        for (const e of await read(sub)) if (!e.name.startsWith(".") && /\.app$/i.test(e.name)) add(path.join(sub, e.name));
      }));
    }));
    return out.sort((a, b) => a.target.localeCompare(b.target));
  }

  /**
   * Apps matching `query`, from the cache only, so a keystroke never waits on the disk. An empty
   * cache starts a scan in the background and returns [] this once.
   * @param {string} query @param {number} [limit] @param {Boost} [boost]
   * @returns {Result[]}
   */
  search(query, limit = 6, boost) {
    if (this.now() - this.at >= this.ttl) this.list().catch(() => {});
    return rank(this.cache.map(r => ({ r, syn: [] })), query, limit, boost);
  }
}

// ---------------------------------------------------------------------------------------------
// Files

/**
 * The mdfind query for "a display name containing `q`", case- and diacritic-insensitive. Quotes,
 * backslashes and asterisks are escaped and control characters dropped, so what the user types
 * is only ever a string inside the quotes, never query syntax.
 */
export function mdQuery(q) {
  const safe = String(q).replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/[\\"*]/g, c => "\\" + c);
  return `kMDItemDisplayName == "*${safe}*"cd`;
}

/** Paths no one looks for from a launcher: library, caches, dependencies, VCS, app internals, dot-dirs. */
export function noise(p) {
  return /\/(Library|node_modules|\.git|\.Trash|Caches?|__pycache__|DerivedData|\.cache)(\/|$)/.test(p)
    || /\.(app|framework|bundle|photoslibrary)(\/|$)/i.test(p)
    || /\/\.[^/]/.test(p);
}

/**
 * Files and folders whose name contains `query`, via `mdfind` (never a shell). Reads lines only
 * until `limit` good results arrive, then kills the process; also killed on `signal` or after
 * `timeoutMs`, returning what it had by then.
 * @param {string} query
 * @param {{ limit?: number, onlyin?: string, timeoutMs?: number, signal?: AbortSignal, run?: typeof spawn,
 *   stat?: (p: string) => Promise<{ isDirectory(): boolean, mtimeMs: number }>, home?: string, maxLines?: number }} [opts]
 * @returns {Promise<Result[]>}
 */
export function files(query, { limit = 8, onlyin = HOME, timeoutMs = 400, signal, run = spawn,
  stat = p => fs.promises.stat(p), home = HOME, maxLines = 400 } = {}) {
  const q = String(query || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (q.length < 2 || signal?.aborted) return Promise.resolve([]);
  return new Promise(resolve => {
    /** @type {string[]} */
    const paths = [];
    let buf = "", lines = 0, done = false;
    const child = run("/usr/bin/mdfind", ["-onlyin", onlyin, mdQuery(q)], { stdio: ["ignore", "pipe", "ignore"] });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      try { child.kill(); } catch {}
      Promise.all(paths.map(async p => {
        try {
          const st = await stat(p);
          return /** @type {Result} */ ({ kind: st.isDirectory() ? "folder" : "file", id: `file:${p}`, label: path.basename(p),
            sub: tilde(path.dirname(p), home), last: Math.round(st.mtimeMs || 0), target: p });
        } catch { return null; } // indexed but gone: Spotlight lags deletes
      })).then(rs => resolve(/** @type {Result[]} */ (rs.filter(Boolean))));
    };
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
    const take = line => {
      if (done || !line || ++lines > maxLines) return lines > maxLines ? finish() : undefined;
      if (!line.startsWith("/") || noise(line) || paths.includes(line)) return;
      paths.push(line);
      if (paths.length >= limit) finish();
    };
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", chunk => {
      buf += chunk;
      let i;
      while (!done && (i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.on("error", finish);
    child.on("close", () => { if (buf) take(buf); buf = ""; finish(); });
  });
}

// ---------------------------------------------------------------------------------------------
// Settings

const PANE = "x-apple.systempreferences:";
const PRIV = "com.apple.settings.PrivacySecurity.extension";

// macOS 13+ System Settings extension ids. Every bundle id below (and every Privacy_* anchor) was
// read on Darwin 25 from /System/Library/ExtensionKit/Extensions/*.appex/Contents/Info.plist with
// `plutil -extract CFBundleIdentifier` (General from System Settings.app's own PlugIns), and the
// anchors from the SecurityPrivacyExtension bundle. The one unverified piece is the "?Shortcuts"
// anchor on Keyboard: it is widely used but not listed in the bundle; without it the Keyboard
// pane still opens.
/** @type {[string, string, string[]][]} label, pane, synonyms */
export const PANES = [
  ["Wi-Fi", "com.apple.wifi-settings-extension", ["wifi", "wireless", "internet", "wlan", "hotspot"]],
  ["Bluetooth", "com.apple.BluetoothSettings", ["airpods", "headphones", "pair"]],
  ["Network", "com.apple.Network-Settings.extension", ["internet", "ethernet", "dns", "proxy", "ip address", "firewall"]],
  ["VPN", "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension", ["tunnel"]],
  ["Displays", "com.apple.Displays-Settings.extension", ["monitor", "screen", "resolution", "brightness", "night shift", "external display"]],
  ["Sound", "com.apple.Sound-Settings.extension", ["volume", "audio", "speakers", "microphone", "output", "input", "alert sound"]],
  ["Notifications", "com.apple.Notifications-Settings.extension", ["alerts", "banners"]],
  ["Focus", "com.apple.Focus-Settings.extension", ["do not disturb", "dnd"]],
  ["Battery", "com.apple.Battery-Settings.extension", ["power", "energy", "low power mode", "charging"]],
  ["Keyboard", "com.apple.Keyboard-Settings.extension", ["typing", "key repeat", "input sources", "dictation", "language"]],
  ["Keyboard Shortcuts", "com.apple.Keyboard-Settings.extension?Shortcuts", ["hotkeys", "shortcuts"]],
  ["Trackpad", "com.apple.Trackpad-Settings.extension", ["gestures", "tap to click", "scroll direction"]],
  ["Mouse", "com.apple.Mouse-Settings.extension", ["pointer speed", "scroll direction"]],
  ["Accessibility", "com.apple.Accessibility-Settings.extension", ["voiceover", "zoom", "reduce motion", "larger text"]],
  ["Privacy & Security", PRIV, ["privacy", "security", "permissions", "filevault", "gatekeeper"]],
  ["Accessibility Permissions", `${PRIV}?Privacy_Accessibility`, ["allow app control", "privacy accessibility"]],
  ["Input Monitoring", `${PRIV}?Privacy_ListenEvent`, ["keylogging", "keyboard access", "hotkey permission"]],
  ["Screen Recording", `${PRIV}?Privacy_ScreenCapture`, ["screen capture", "screen sharing permission"]],
  ["Full Disk Access", `${PRIV}?Privacy_AllFiles`, ["disk access", "fda", "all files"]],
  ["Contacts Access", `${PRIV}?Privacy_Contacts`, ["contacts permission", "address book"]],
  ["Camera Access", `${PRIV}?Privacy_Camera`, ["camera", "webcam"]],
  ["Microphone Access", `${PRIV}?Privacy_Microphone`, ["microphone", "mic"]],
  ["Location Services", `${PRIV}?Privacy_LocationServices`, ["location", "gps"]],
  ["Automation", `${PRIV}?Privacy_Automation`, ["apple events", "applescript"]],
  ["General", "com.apple.systempreferences.GeneralSettings", ["about", "about this mac"]],
  ["Software Update", "com.apple.Software-Update-Settings.extension", ["update", "upgrade", "macos update"]],
  ["Storage", "com.apple.settings.Storage", ["disk space", "free space"]],
  ["Date & Time", "com.apple.Date-Time-Settings.extension", ["clock", "time zone", "timezone"]],
  ["Sharing", "com.apple.Sharing-Settings.extension", ["file sharing", "screen sharing", "remote login", "ssh", "computer name", "airplay receiver"]],
  ["Login Items", "com.apple.LoginItems-Settings.extension", ["startup items", "launch at login", "background items"]],
  ["Users & Groups", "com.apple.Users-Groups-Settings.extension", ["accounts", "users", "guest"]],
  ["Touch ID & Password", "com.apple.Touch-ID-Settings.extension", ["password", "fingerprint", "login password"]],
  ["Lock Screen", "com.apple.Lock-Screen-Settings.extension", ["screen saver timeout", "require password"]],
  ["Wallpaper", "com.apple.Wallpaper-Settings.extension", ["background", "desktop picture"]],
  ["Appearance", "com.apple.Appearance-Settings.extension", ["dark mode", "light mode", "accent color", "theme"]],
  ["Desktop & Dock", "com.apple.Desktop-Settings.extension", ["dock", "mission control", "hot corners", "stage manager", "windows"]],
  ["Control Center", "com.apple.ControlCenter-Settings.extension", ["menu bar", "control centre"]],
  ["Siri", "com.apple.Siri-Settings.extension", ["voice assistant", "hey siri"]],
  ["Spotlight", "com.apple.Spotlight-Settings.extension", ["search"]],
  ["Printers & Scanners", "com.apple.Print-Scan-Settings.extension", ["printer", "print", "scanner"]],
  ["Time Machine", "com.apple.Time-Machine-Settings.extension", ["backup"]],
  ["Screen Time", "com.apple.Screen-Time-Settings.extension", ["parental controls", "app limits"]],
  ["Internet Accounts", "com.apple.Internet-Accounts-Settings.extension", ["email accounts", "mail accounts", "google account"]],
  ["Language & Region", "com.apple.Localization-Settings.extension", ["language", "region", "locale"]],
];

const SETTINGS = PANES.map(([label, pane, syn]) => ({
  r: /** @type {Result} */ ({ kind: "setting", id: `setting:${pane}`, label, sub: "System Settings", last: 0, target: PANE + pane }),
  syn,
}));

/**
 * System Settings panes matching `query`, synonyms included ("wifi", "volume", "dark mode").
 * @param {string} query @param {number} [limit] @param {Boost} [boost] @returns {Result[]}
 */
export function settings(query, limit = 4, boost) {
  return rank(SETTINGS, query, limit, boost);
}

// ---------------------------------------------------------------------------------------------
// Frecency

const HALF_LIFE = 7 * 86_400_000;
const CAP = 2000;
const PREFIX = 6;
const PREFIXES = 6;

/**
 * Which results this Mac's user picks, and after typing what. `boost()` lifts a result the user
 * picks often and lately; it saturates at +0.45 for frequency plus +0.15 when the same typed
 * prefix picked the same item before, so it can reorder close matches but never lift a 0.3
 * fuzzy hit over an exact one. Stores ids and prefixes of at most six characters, nothing else.
 */
export class Frecency {
  /** @param {string} file @param {{ now?: () => number, delayMs?: number, cap?: number }} [opts] */
  constructor(file, { now = Date.now, delayMs = 500, cap = CAP } = {}) {
    this.file = file; this.now = now; this.delayMs = delayMs; this.cap = cap;
    /** @type {Record<string, { s: number, t: number, q: Record<string, { s: number, t: number }> }>|null} */
    this.items = null;
    /** @type {NodeJS.Timeout|null} */ this.timer = null;
  }

  load() {
    if (this.items) return this.items;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.items = j && typeof j.items === "object" && !Array.isArray(j.items) ? j.items : {};
    } catch { this.items = {}; }
    return /** @type {NonNullable<Frecency["items"]>} */ (this.items);
  }

  decay(s, t) { return s * Math.pow(0.5, Math.max(0, this.now() - t) / HALF_LIFE); }

  static prefix(query) { return fold(query).trim().slice(0, PREFIX); }

  /** Record that `id` was picked after typing `query`. */
  pick(id, query = "") {
    const items = this.load(), now = this.now();
    const it = items[id] || (items[id] = { s: 0, t: now, q: {} });
    it.s = this.decay(it.s, it.t) + 1; it.t = now;
    const p = Frecency.prefix(query);
    if (p) {
      const e = it.q[p] || (it.q[p] = { s: 0, t: now });
      e.s = this.decay(e.s, e.t) + 1; e.t = now;
      const keys = Object.keys(it.q);
      if (keys.length > PREFIXES) {
        keys.sort((a, b) => this.decay(it.q[a].s, it.q[a].t) - this.decay(it.q[b].s, it.q[b].t));
        for (const k of keys.slice(0, keys.length - PREFIXES)) delete it.q[k];
      }
    }
    this.trim();
    this.schedule();
  }

  /** What to add to a 0..1 match score for `id` when the box holds `query`. At most 0.6. */
  boost(id, query = "") {
    const it = this.load()[id];
    if (!it) return 0;
    let b = 0.45 * (1 - Math.exp(-this.decay(it.s, it.t) / 3));
    const p = Frecency.prefix(query);
    if (p) {
      let best = 0;
      for (const [k, e] of Object.entries(it.q)) {
        // "saf" and "safari" agree; "sa" typed now also agrees with "safari" picked before.
        if (k.startsWith(p) || p.startsWith(k)) best = Math.max(best, this.decay(e.s, e.t));
      }
      b += 0.15 * (1 - Math.exp(-best));
    }
    return Math.min(0.6, b);
  }

  trim() {
    const items = /** @type {NonNullable<Frecency["items"]>} */ (this.items);
    const ids = Object.keys(items);
    if (ids.length <= this.cap) return;
    ids.sort((a, b) => this.decay(items[a].s, items[a].t) - this.decay(items[b].s, items[b].t));
    for (const id of ids.slice(0, ids.length - this.cap)) delete items[id];
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delayMs);
    this.timer.unref?.();
  }

  /** Write now: temp file then rename, so a crash never leaves half a file. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.items) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items }));
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}

// ---------------------------------------------------------------------------------------------
// open

/**
 * Open a result with /usr/bin/open (no shell): an app, a file, a folder, or a settings URL.
 * @param {Result} result
 * @param {{ run?: (file: string, args: string[], cb: (err: Error|null, stdout?: string, stderr?: string) => void) => unknown }} [opts]
 * @returns {Promise<{ ok: true }|{ error: string }>}
 */
export function open(result, { run = execFile } = {}) {
  const target = result && typeof result.target === "string" ? result.target : "";
  if (!target) return Promise.resolve({ error: "nothing to open" });
  const isUrl = target.startsWith(PANE);
  if (!isUrl && !path.isAbsolute(target)) return Promise.resolve({ error: "not a path or settings pane" });
  // Only absolute paths and settings URLs get here, so the argument can never read as a flag.
  const args = [target];
  return new Promise(resolve => {
    try {
      run("/usr/bin/open", args, (err, _out, stderr) => {
        if (err) resolve({ error: String(stderr || err.message || err).trim() || "open failed" });
        else resolve({ ok: true });
      });
    } catch (e) { resolve({ error: String(/** @type {Error} */ (e).message || e) }); }
  });
}
