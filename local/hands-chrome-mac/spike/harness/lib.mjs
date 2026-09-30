// @ts-check
// lib: the shared pieces of the Chrome proof harness (spike/harness/run.mjs and
// bench/chrome-bench.mjs). Everything here is either pure (stats, framing, ids, arg parsing) and
// unit-tested without Chrome, or a thin wrapper over a child process or a WebSocket that only
// runs on a throwaway GitHub runner. Node 22, no dependencies: WebSocket is Node's global.
//
// The framing here is Chrome's native-messaging format (4-byte little-endian length, then UTF-8
// JSON), the same as native-host/stdio.js. It is re-implemented so the spike does not break when
// the real host's file changes; spike-lib.test.js cross-checks the two byte for byte.

import { CHROME_SAFE } from "../../../../lib/chrome-flags/index.js";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- stats

/** Nearest-rank percentile of an ascending array. @param {number[]} sorted @param {number} p */
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/** @param {number[]} samples milliseconds @returns {{n:number,min:number,p50:number,p95:number,max:number,mean:number}} */
export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  if (!s.length) return { n: 0, min: NaN, p50: NaN, p95: NaN, max: NaN, mean: NaN };
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: round(s[0]), p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), max: round(s[s.length - 1]), mean: round(mean) };
}

/** Time an async function n times (after warmup untimed runs). @param {number} n @param {(i:number)=>Promise<any>} fn @param {{warmup?:number, before?:(i:number)=>Promise<any>}} [opt] */
export async function timeIt(n, fn, opt = {}) {
  for (let i = 0; i < (opt.warmup ?? 0); i++) { if (opt.before) await opt.before(-1 - i); await fn(-1 - i); }
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    if (opt.before) await opt.before(i);
    const t = performance.now();
    await fn(i);
    out.push(performance.now() - t);
  }
  return out;
}

// ---------------------------------------------------------------- framing

/** @param {unknown} value @returns {Buffer} */
export function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** Stateful reader: feed chunks, get every whole message they complete. */
export class Deframer {
  constructor() { /** @type {Buffer} */ this.buf = Buffer.alloc(0); }
  /** @param {Buffer} chunk @returns {any[]} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) throw new Error(`frame too large: ${len}`);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
  pending() { return this.buf.length; }
}

// ---------------------------------------------------------------- extension identity

/** Chrome's extension id: first 16 bytes of sha256(public key DER), hex digits mapped 0-9a-f to a-p. @param {Buffer} der */
export function extensionIdFromKey(der) {
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map(c => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

/** A throwaway key so an unpacked extension gets a stable, known id. @returns {{keyB64:string, id:string}} */
export function makeKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = /** @type {Buffer} */ (publicKey.export({ type: "spki", format: "der" }));
  return { keyB64: der.toString("base64"), id: extensionIdFromKey(der) };
}

/**
 * Copy an extension into a temp dir and make sure its manifest has a key. A manifest that already
 * has a key (the real extension pins one) keeps it, and the id is derived from that key.
 * @param {string} src @param {string} dest @returns {{id:string, dir:string, manifest:any}}
 */
export function prepareExtension(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
  const mp = path.join(dest, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  let id;
  if (manifest.key) id = extensionIdFromKey(Buffer.from(manifest.key, "base64"));
  else { const k = makeKey(); manifest.key = k.keyB64; id = k.id; fs.writeFileSync(mp, JSON.stringify(manifest, null, 2)); }
  return { id, dir: dest, manifest };
}

// ---------------------------------------------------------------- native host registration

export const HOST_NAME = "run.vyre.chrome";

/** @param {{wrapper:string, id:string}} o */
export function hostManifest({ wrapper, id }) {
  return { name: HOST_NAME, description: "Vyre chrome proof host", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] };
}

/** The wrapper Chrome executes: sets the socket env and runs node on host.js. @param {{platform?:string, node:string, hostJs:string, sock:string, home:string}} o */
export function wrapperScript({ platform = process.platform, node, hostJs, sock, home }) {
  if (platform === "win32") {
    return `@echo off\r\nset VYRE_CHROME_SOCK=${sock}\r\nset VYRE_HOME=${home}\r\n"${node}" "${hostJs}" %*\r\n`;
  }
  const q = (/** @type {string} */ s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nexport VYRE_CHROME_SOCK=${q(sock)}\nexport VYRE_HOME=${q(home)}\nexec ${q(node)} ${q(hostJs)} "$@"\n`;
}

/** Windows registry keys Chrome-family browsers read native hosts from (a throwaway runner, so all of them). */
export const WIN_REG_KEYS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  "HKCU\\Software\\Google\\Chrome for Testing\\NativeMessagingHosts",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts",
];

/**
 * Register the host manifest for one user-data-dir. macOS/Linux: <udd>/NativeMessagingHosts/<name>.json.
 * Windows: HKCU keys via `reg add`. Returns a cleanup function.
 * @param {{manifestObj:any, dir:string, userDataDir:string, platform?:string}} o
 */
export function registerHost({ manifestObj, dir, userDataDir, platform = process.platform }) {
  const body = JSON.stringify(manifestObj, null, 2);
  if (platform === "win32") {
    const mp = path.join(dir, `${HOST_NAME}.json`);
    fs.writeFileSync(mp, body);
    const keys = WIN_REG_KEYS.map(k => `${k}\\${HOST_NAME}`);
    for (const k of keys) {
      const r = spawnSync("reg", ["add", k, "/ve", "/t", "REG_SZ", "/d", mp, "/f"], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`reg add ${k} failed: ${r.stderr || r.stdout}`);
    }
    return () => { for (const k of keys) spawnSync("reg", ["delete", k, "/f"], { encoding: "utf8" }); };
  }
  const d = path.join(userDataDir, "NativeMessagingHosts");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${HOST_NAME}.json`), body);
  return () => {};
}

/** A socket path short enough for macOS's ~104-byte sun_path limit, or a Windows pipe name. @param {string} [platform] */
export function ipcPath(platform = process.platform) {
  const tag = crypto.randomBytes(4).toString("hex");
  if (platform === "win32") return `\\\\.\\pipe\\vyre-spike-${process.pid}-${tag}`;
  const dir = fs.mkdtempSync("/tmp/vyre-s-");
  return path.join(dir, "c.sock");
}

// ---------------------------------------------------------------- args

/** `--k v`, `--k=v` and bare `--flag`. Repeated flags keep the last. @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

// ---------------------------------------------------------------- Chrome

/**
 * Chrome for Testing via the official installer. `--chrome <path>` or CHROME_PATH skips the install.
 * @param {{chrome?:string, cacheDir?:string}} [o] @returns {{path:string, version:string, installMs:number}}
 */
export function resolveChrome(o = {}) {
  const explicit = o.chrome || process.env.CHROME_PATH;
  if (explicit) return { path: explicit, version: "explicit", installMs: 0 };
  const cacheDir = o.cacheDir || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "vyre-chrome-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const win = process.platform === "win32";
  const t0 = Date.now();
  const r = spawnSync("npx", ["--yes", "@puppeteer/browsers", "install", "chrome@stable", "--path", win ? `"${cacheDir}"` : cacheDir], { encoding: "utf8", shell: win, timeout: 5 * 60_000 });
  const parsed = parseInstallOutput(`${r.stdout || ""}`);
  if (r.status !== 0 || !parsed) throw new Error(`chrome install failed (status ${r.status}): ${(r.stderr || r.stdout || "").slice(-400)}`);
  return { ...parsed, installMs: Date.now() - t0 };
}

/** Last "chrome@<version> <path>" line of the installer's output. @param {string} out */
export function parseInstallOutput(out) {
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).reverse();
  for (const l of lines) { const m = /^chrome@(\S+)\s+(.+)$/.exec(l); if (m) return { version: m[1], path: m[2] }; }
  return null;
}

/**
 * Launch Chrome. Only ever inside a throwaway runner: the caller owns the temp user-data-dir.
 * @param {{chrome:string, userDataDir:string, url?:string, extraArgs?:string[], env?:Record<string,string>, headless?:string|false, logFile?:string}} o
 */
export function launchChrome({ chrome, userDataDir, url = "about:blank", extraArgs = [], env = {}, headless = "new", logFile }) {
  const args = [];
  if (headless) args.push(`--headless=${headless}`);
  args.push(...CHROME_SAFE, `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-search-engine-choice-screen", "--remote-allow-origins=*");
  if (process.platform === "linux" || process.env.CI) args.push("--no-sandbox");
  if (process.platform === "linux") args.push("--disable-dev-shm-usage");
  args.push(...extraArgs, url);
  const log = logFile || path.join(userDataDir, "..", `chrome-${process.pid}.log`);
  const fd = fs.openSync(log, "a");
  const child = spawn(chrome, args, { env: { ...process.env, ...env }, stdio: ["ignore", fd, fd], windowsHide: true });
  return { child, args, logFile: log };
}

/** Stop a process we started (and, on Windows, its tree). @param {import("node:child_process").ChildProcess} child */
export function stopProcess(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
  else { try { child.kill("SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000).unref(); }
}

/** DevToolsActivePort: line 1 the port, line 2 the browser ws path. @param {string} userDataDir @param {number} [timeoutMs] */
export async function readDevToolsPort(userDataDir, timeoutMs = 30_000) {
  const f = path.join(userDataDir, "DevToolsActivePort");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const [port, wsPath] = fs.readFileSync(f, "utf8").split(/\r?\n/);
      if (port && wsPath) return { port: Number(port), wsPath };
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("Chrome did not write DevToolsActivePort");
}

// ---------------------------------------------------------------- CDP over WebSocket

/** Minimal CDP client (flat sessions). */
export class Cdp {
  /** @param {any} ws */
  constructor(ws) {
    this.ws = ws; this.nextId = 1;
    /** @type {Map<number,{resolve:Function,reject:Function,method:string}>} */ this.pending = new Map();
    /** @type {Array<(method:string, params:any, sessionId?:string)=>void>} */ this.listeners = [];
    ws.addEventListener("message", (/** @type {{data:any}} */ ev) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      } else if (m.method) for (const l of this.listeners) l(m.method, m.params, m.sessionId);
    });
    ws.addEventListener("close", () => { for (const p of this.pending.values()) p.reject(new Error("cdp closed")); this.pending.clear(); });
  }
  /** @param {string} url */
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error(`ws connect failed: ${url}`)), { once: true }); });
    return new Cdp(ws);
  }
  /** @param {string} method @param {any} [params] @param {string} [sessionId] @returns {Promise<any>} */
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** @param {(method:string, params:any, sessionId?:string)=>void} fn */
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

/** Append a line to the GitHub step summary when running on Actions. @param {string} line */
export function stepSummary(line) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) try { fs.appendFileSync(f, `${line}\n`); } catch { /* not fatal */ }
}
