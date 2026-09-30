// @ts-check
// trace: one JSONL file per session in <data>/logs, so the person (and whoever improves this) can
// see what every tool call did, how long it took, where it failed and which selector strategy
// bound. Local only: nothing here opens a network connection or leaves the folder.
//
// Redaction, same rules as the product: secrets, passwords, tokens and cookies are always masked
// (extension/shared/redact.js), and a value shaped like a person's email or phone number is masked
// while the field's NAME stays. Workflow config text stays readable.
//
// Shape of a line: {t, seq, kind: "call"|"event"|"session", ...}. A "call" carries tool, args
// (redacted), queueMs, runMs, waitMs (time spent waiting on the page's UI), ok, error {code,
// message, step, dom}, and the page host/path, tab id, newTab, strategy, fallback, retries.

import fs from "node:fs";
import path from "node:path";
import * as redact from "../extension/shared/redact.js";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Seven or more digits with the separators a phone number has, or a bare 10 or 11 digits; a longer bare run is an id and is left alone.
const PHONE = /(?<![\w.])\+?\d[\d ()\-.]{5,}\d(?![\w])/g;
// values: which typed values a trace keeps. "builder" (default): only on GoHighLevel automation and workflow-builder
// pages, where the values are workflow text; everywhere else a typed value is logged as its length. "all": every
// value. "none": never.
export const DEFAULTS = Object.freeze({ logs: "on", shots: false, maxMB: 100, fileMB: 10, values: "builder", confirmSends: true });

/**
 * The fallback ladder, one mechanism: which rung a tool call works on, and what to try when it fails.
 *   1 api      the site's own API (chrome_api learn/catalog/call, a connector)
 *   2 dom      the page's controls with refs, and batches of them (snapshot, act, fill, batch, ghl, wait)
 *   3 devtools DOM, styles, scripts, console and network, for pages that resist (inspect, sources, console, net, eval)
 *   4 ax       the accessibility tree (snapshot with role and name only, then act by role and name)
 *   5 vision   a screenshot the model reads, last
 * @param {string} tool @param {any} [args]
 */
export function rungOf(tool, args) {
  const t = String(tool).replace(/^chrome[._]/, "");
  if (t === "api") return 1;
  if (t === "screenshot") return 5;
  if (["inspect", "sources", "console", "net", "eval"].includes(t)) return 3;
  if (["snapshot", "act", "fill", "batch", "ghl", "wait", "tabs", "click", "type", "open", "state"].includes(t)) return 2;
  return 0;
}
export const RUNGS = Object.freeze({ 1: "api", 2: "dom", 3: "devtools", 4: "ax", 5: "vision" });
/** What to say after a failure on a rung. @param {number} rung */
export function nextRung(rung) {
  return ({
    1: "the site's API did not answer: read the page with chrome_snapshot and act on it (rung 2)",
    2: "the page's controls did not work: look at the DOM, console and network with chrome_inspect, chrome_console, chrome_net (rung 3), or find it by role and name from a chrome_snapshot (rung 4)",
    3: "devtools did not explain it: find the control by its role and name (rung 4), or take a chrome_screenshot and read it (rung 5)",
    4: "the accessibility tree did not have it: take a chrome_screenshot and read it (rung 5)",
    5: "there is no lower rung: tell the person what you see and ask",
  })[/** @type {1|2|3|4|5} */ (rung)] || "";
}

/** A digit run that passes the Luhn check and is 13 to 19 digits long, as a card number does. @param {string} digits */
const luhn = digits => { if (digits.length < 13 || digits.length > 19) return false; let sum = 0, alt = false; for (let i = digits.length - 1; i >= 0; i--) { let n = digits.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };
const SSN = /\b\d{3}-\d{2}-\d{4}\b|\b(?<!\d)\d{9}(?!\d)\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Mask email-, phone-, card- and SSN-shaped text. @param {string} s */
export function pii(s) {
  return String(s).replace(CARD, m => (luhn(m.replace(/\D/g, "")) ? "[card]" : m)).replace(SSN, "[ssn]").replace(EMAIL, "[email]").replace(PHONE, m => { const n = m.replace(/\D/g, "").length; return n >= 7 && (/[ ()\-.+]/.test(m) || (n >= 10 && n <= 11)) ? "[phone]" : m; });
}

/** A value made safe to write: secrets by name and shape, then contact details by shape. @param {any} v @param {number} [depth] */
export function safe(v, depth = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 6) return "[deep]";
  if (typeof v === "string") return pii(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? redact.url(v) : redact.text(v)).slice(0, 2000);
  if (Array.isArray(v)) return v.slice(0, 60).map(x => safe(x, depth + 1));
  if (typeof v === "object") {
    /** @type {Record<string, any>} */ const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 80)) {
      if (redact.secretName(k)) { out[k] = "[redacted:by-name]"; continue; }
      out[k] = safe(x, depth + 1);
    }
    return out;
  }
  return String(v);
}

/**
 * Arguments as they are logged: field VALUES for a field whose name looks like a password or token are masked, every
 * other value goes through safe(). @param {any} args
 */
export function safeArgs(args) {
  const a = safe(args);
  const fix = (/** @type {any} */ f, /** @type {any} */ orig) => {
    if (!f || typeof f !== "object" || !orig) return f;
    const name = [orig.label, orig.selector && (orig.selector.name || orig.selector.identifier || orig.selector.text), typeof orig.selector === "string" ? orig.selector : ""].filter(Boolean).join(" ");
    if (name && (redact.secretName(name) || /pass(word|code)?|pwd|secret|token|otp|cvv|card/i.test(name)) && "value" in f) return { ...f, value: "[redacted:by-name]" };
    return f;
  };
  if (a && Array.isArray(a.fields) && args && Array.isArray(args.fields)) a.fields = a.fields.map((/** @type {any} */ f, /** @type {number} */ i) => fix(f, args.fields[i]));
  return a;
}

/** Replace typed values with their length. @param {any} v @param {number} [depth] */
export function stripValues(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.map(x => stripValues(x, depth + 1));
  /** @type {Record<string, any>} */ const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = (k === "value" || k === "text" || k === "config" || k === "params" || k === "answer") && x != null && typeof x !== "object" ? `[${String(x).length} chars]` : (k === "params" || k === "config") ? "[params omitted]" : stripValues(x, depth + 1);
  return o;
}
const GHL_HOST = /(^|\.)(gohighlevel\.com|leadconnectorhq\.com)(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
/** GoHighLevel automation and workflow builder pages (and the fixture's /ghl). */
const BUILDER_PATH = /\/automation|\/workflows?(\/|$)|^\/ghl(\/|$)/i;

/** Host and path of a URL, no query, no login, no fragment. @param {any} u */
export function hostPath(u) {
  try { const x = new URL(String(u)); return { host: x.host, path: x.pathname.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/...") }; } catch { return null; }
}

/** The config file: {logs: "on"|"off", shots: bool, maxMB, fileMB}. Missing or unreadable means the defaults. @param {string} dataDir */
export function readConfig(dataDir) {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) }; } catch { return { ...DEFAULTS }; }
}
/** @param {string} dataDir @param {Record<string, any>} patch */
export function writeConfig(dataDir, patch) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const next = { ...readConfig(dataDir), ...patch };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** Delete the oldest log files until the folder fits the cap. @param {string} dir @param {number} maxBytes */
export function rotate(dir, maxBytes) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.(jsonl|png)$/.test(f)).map(f => { const p = path.join(dir, f); const st = fs.statSync(p); return { p, size: st.size, at: st.mtimeMs }; }); } catch { return 0; }
  files.sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0), removed = 0;
  // Never delete the newest file: it is the one being written.
  while (total > maxBytes && files.length > 1) { const f = /** @type {any} */ (files.shift()); try { fs.unlinkSync(f.p); total -= f.size; removed++; } catch { break; } }
  return removed;
}

/**
 * The trace writer for one session.
 * @param {{ dataDir: string, now?: () => number, pid?: number, version?: string }} o
 */
export function createTrace({ dataDir, now = Date.now, pid = process.pid, version = "" }) {
  const dir = path.join(dataDir, "logs");
  const id = new Date(now()).toISOString().replace(/[:.]/g, "-") + "-" + pid;
  let cfg = readConfig(dataDir);
  let cfgAt = now();
  let seq = 0, part = 0, written = 0, file = "";
  /** @type {Map<number, { host: string, path: string }>} */ const hostByTab = new Map();
  const cfgNow = () => { if (now() - cfgAt > 15_000) { cfg = readConfig(dataDir); cfgAt = now(); } return cfg; };
  const pathFor = () => path.join(dir, `session-${id}${part ? `.${part}` : ""}.jsonl`);

  /** @param {Record<string, any>} rec */
  function write(rec) {
    const c = cfgNow();
    if (c.logs === "off") return false;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!file) { file = pathFor(); }
      const line = JSON.stringify({ t: new Date(now()).toISOString(), run: id, seq: ++seq, ...rec }) + "\n";
      if (written + line.length > c.fileMB * 1024 * 1024) { part++; file = pathFor(); written = 0; rotate(dir, c.maxMB * 1024 * 1024); }
      fs.appendFileSync(file, line, { mode: 0o600 });
      written += line.length;
      return true;
    } catch { return false; }
  }

  write({ kind: "session", event: "start", version, node: process.version, platform: process.platform });
  rotate(dir, cfg.maxMB * 1024 * 1024);

  return {
    id, dir, file: () => file, write,
    config: () => cfgNow(),
    /** Save a failure screenshot next to the log and return its file name, or null. @param {string} b64 @param {string} ext */
    shot(b64, ext = "jpg") {
      if (cfgNow().logs === "off") return null;
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const name = `shot-${id}-${seq}.${ext}`; fs.writeFileSync(path.join(dir, name), Buffer.from(b64, "base64"), { mode: 0o600 }); return name; } catch { return null; }
    },
    /** One finished tool call. @param {{ tool: string, args: any, queueMs: number, runMs: number, ok: boolean, result?: any, error?: any, caller?: string }} c */
    call(c) {
      const meta = describe(c.result, c.error);
      const mode = cfgNow().values;
      // The host a call ran on: from its own result, or the last one seen for the tab it names.
      const tabId = Number.isInteger(meta.tab) ? meta.tab : Number.isInteger(c.args && c.args.tab) ? c.args.tab : undefined;
      if (meta.host && tabId !== undefined) hostByTab.set(tabId, { host: meta.host, path: meta.path || "" });
      const seen = meta.host ? { host: meta.host, path: meta.path || "" } : (tabId !== undefined ? hostByTab.get(tabId) : undefined);
      if (!meta.host && seen) { meta.host = seen.host; if (seen.path) meta.path = seen.path; }
      const keep = mode === "all" || (mode !== "none" && seen && GHL_HOST.test(String(seen.host)) && BUILDER_PATH.test(String(seen.path)));
      const args = keep ? c.args : stripValues(c.args);
      const rung = rungOf(c.tool, c.args);
      return write({ kind: "call", tool: c.tool, ...(rung ? { rung, rungName: /** @type {any} */ (RUNGS)[rung] } : {}), args: safeArgs(args), queueMs: Math.round(c.queueMs), runMs: Math.round(c.runMs), ok: c.ok, ...meta });
    },
    /** @param {string} type @param {any} payload */
    event(type, payload) { return write({ kind: "event", type, data: safe(payload) }); },
  };
}

/**
 * What to keep about a result or an error: timings inside the page, strategy, fallback, retries,
 * the page's host and path, the failing step, and the small DOM snippet. Never the result body.
 * @param {any} result @param {any} error
 */
export function describe(result, error) {
  /** @type {Record<string, any>} */ const m = {};
  const traces = [];
  const walk = (/** @type {any} */ r, /** @type {number} */ d) => {
    if (!r || typeof r !== "object" || d > 3) return;
    if (r.trace && typeof r.trace === "object") traces.push(r.trace);
    if (Array.isArray(r.steps)) for (const s of r.steps.slice(0, 200)) walk(s && (s.result || s), d + 1);
    if (Array.isArray(r.results)) for (const s of r.results.slice(0, 200)) walk(s, d + 1);
  };
  walk(result, 0);
  if (error && error.detail && error.detail.trace) traces.push(error.detail.trace);
  if (traces.length) {
    m.waitMs = Math.round(traces.reduce((n, t) => n + (Number(t.waitedMs) || 0), 0));
    m.retries = traces.reduce((n, t) => n + (Number(t.retries) || 0), 0);
    m.fallback = traces.some(t => t.fallback === true);
    m.newTab = traces.some(t => t.newTab === true);
    const strategies = [...new Set(traces.map(t => t.strategy).filter(Boolean))];
    if (strategies.length) m.strategy = strategies.length === 1 ? strategies[0] : strategies;
    const dismissed = traces.flatMap(t => Array.isArray(t.dismissed) ? t.dismissed : []);
    if (dismissed.length) m.dismissed = safe(dismissed);
    m.steps = traces.length;
  }
  if (result && typeof result === "object") {
    if (Number.isInteger(result.tab)) m.tab = result.tab; else if (Number.isInteger(result.tabId)) m.tab = result.tabId;
    const hp = hostPath(result.url || (result.tab && result.tab.url));
    if (hp) Object.assign(m, hp);
    if (result.held === true) m.held = true;
    if (result.saved !== undefined) m.saved = result.saved === true;
    if (result.failed) m.failedStep = safe(result.failed);
    if (result.ok === false) m.ok = false;
  }
  if (error) {
    const d = error.detail && typeof error.detail === "object" ? error.detail : null;
    m.error = { code: String(error.code || "error"), message: pii(redact.text(String(error.message || error))).slice(0, 600) };
    if (d) {
      const hp = d.host ? { host: d.host, path: d.path } : hostPath(d.url);
      if (hp) Object.assign(m, hp);
      if (d.step !== undefined) m.error.step = safe(d.step);
      if (d.failed) m.error.failed = safe(d.failed);
      if (d.dom !== undefined) m.error.dom = pii(redact.text(String(typeof d.dom === "string" ? d.dom : JSON.stringify(d.dom)))).slice(0, 1200);
      else if (d.snippet !== undefined) m.error.dom = pii(redact.text(String(d.snippet))).slice(0, 1200);
      if (d.candidates) m.error.candidates = safe(d.candidates);
      if (d.blockers) m.error.blockers = safe(d.blockers);
    }
  }
  return m;
}

/** Read log records from the last N session files (newest first, then put in time order). @param {string} dataDir @param {number} [last] */
export function readSessions(dataDir, last = 5) {
  const dir = path.join(dataDir, "logs");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  const bySession = new Map();
  for (const f of files) { const m = /^session-(.+?)(?:\.\d+)?\.jsonl$/.exec(f); if (!m) continue; const arr = bySession.get(m[1]) || []; arr.push(f); bySession.set(m[1], arr); }
  const ids = [...bySession.keys()].sort().slice(-last);
  const recs = [];
  for (const sid of ids) for (const f of bySession.get(sid).sort()) {
    let text = "";
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) { if (!line) continue; try { recs.push(JSON.parse(line)); } catch { /* a torn last line */ } }
  }
  return { sessions: ids, records: recs };
}

/** @param {number[]} xs @param {number} p */
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/**
 * The report: a summary and the records, all re-passed through the redactor.
 * @param {string} dataDir @param {{ last?: number }} [o]
 */
export function report(dataDir, { last = 5 } = {}) {
  const got = readSessions(dataDir, last);
  const { sessions, records } = Array.isArray(got) ? { sessions: [], records: [] } : got;
  const calls = records.filter((/** @type {any} */ r) => r.kind === "call");
  const failures = calls.filter((/** @type {any} */ r) => !r.ok);
  const byKind = {};
  for (const f of failures) { const k = (f.error && f.error.code) || "error"; /** @type {any} */ (byKind)[k] = (/** @type {any} */ (byKind)[k] || 0) + 1; }
  const byTool = {};
  for (const c of calls) {
    const t = /** @type {any} */ (byTool)[c.tool] ||= { calls: 0, failures: 0, runMs: [], waitMs: 0, fallbacks: 0, retries: 0 };
    t.calls++; if (!c.ok) t.failures++; t.runMs.push(c.runMs || 0); t.waitMs += c.waitMs || 0; t.fallbacks += c.fallback ? 1 : 0; t.retries += c.retries || 0;
  }
  const tools = Object.fromEntries(Object.entries(byTool).map(([k, t]) => [k, { calls: t.calls, failures: t.failures, p50Ms: pct(t.runMs, 0.5), p95Ms: pct(t.runMs, 0.95), waitMs: t.waitMs, fallbackRate: t.calls ? +(t.fallbacks / t.calls).toFixed(3) : 0, retries: t.retries }]));
  const withStrategy = calls.filter((/** @type {any} */ c) => c.strategy !== undefined);
  const slowest = [...calls].sort((a, b) => (b.runMs || 0) - (a.runMs || 0)).slice(0, 10).map(c => ({ seq: c.seq, t: c.t, tool: c.tool, runMs: c.runMs, waitMs: c.waitMs || 0, ok: c.ok, host: c.host, path: c.path }));
  const byRung = {};
  for (const c of calls) if (c.rung) { const r = /** @type {any} */ (byRung)[c.rungName] ||= { calls: 0, failures: 0 }; r.calls++; if (!c.ok) r.failures++; }
  const summary = {
    rungs: byRung,
    sessions, calls: calls.length, failures: failures.length,
    failuresByKind: byKind, tools, slowest,
    fallbackRate: withStrategy.length ? +(withStrategy.filter((/** @type {any} */ c) => c.fallback).length / withStrategy.length).toFixed(3) : 0,
    retries: calls.reduce((n, c) => n + (c.retries || 0), 0),
    newTabs: calls.filter((/** @type {any} */ c) => c.newTab).length,
    heldSends: calls.filter((/** @type {any} */ c) => c.held).length,
    hosts: Object.fromEntries(Object.entries(calls.reduce((o, c) => { if (c.host) o[c.host] = (o[c.host] || 0) + 1; return o; }, /** @type {Record<string, number>} */ ({}))).sort((a, b) => b[1] - a[1]).slice(0, 10)),
  };
  // Written records were masked when they were written; they are passed through again so a bundle is safe even if a log was edited by hand.
  return { summary, bundle: { tool: "vyre-chrome report", at: new Date().toISOString(), summary, records: records.map((/** @type {any} */ r) => safe(r)) } };
}
