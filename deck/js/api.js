// @ts-check
// The one way the Deck reaches vyred: POST /v1/tools/<name> and the SSE stream. Nothing else in
// the Deck calls fetch.
//
// Fixtures. Tools that other workstreams have not merged yet (threads.*, agents.*, onboard.*,
// vault.*, learn.*, gate.*) are answered from deck/fixtures/<module>.json, but only when fixtures
// are switched on (?fixtures=1 once, remembered for the tab; ?fixtures=0 turns them off) and only
// when the live tool is missing. Live always wins. With fixtures off, a missing tool is an
// ApiError with missing: true, and the view says which module is not running.
//
// A fixture entry is the tool's data, or one of:
//   { "$by": "<input key>", "cases": { "<value>": data, "*": data } }   chosen by an input field
//   { "$seq": [data, data, ...] }                                         the next one per call, then the last
// and any string "$ago:<n><s|m|h|d>" becomes that long before now, in ms, so fixture times stay fresh.

const store = (() => { try { return window.sessionStorage; } catch { return null; } })();
const q = new URLSearchParams(location.search);
if (q.has("fixtures")) { try { store?.setItem("vyre.fixtures", q.get("fixtures") === "0" ? "0" : "1"); } catch {} }
export const fixturesOn = (() => { try { return store?.getItem("vyre.fixtures") === "1"; } catch { return false; } })();

/** Tools answered from fixtures this page load, so the shell can say so. */
export const fromFixtures = new Set();

/** Tools are named for what they do; some live in a module of another name. */
const MODULE = { threads: "switchboard", agents: "switchboard", onboard: "box", gate: "gate", learn: "learn" };

export class ApiError extends Error {
  /** @param {string} code @param {string} message @param {string} tool @param {Record<string, any>} [detail] the whole error body vyred sent, for fields beyond code/message (e.g. presence_required's `methods`) */
  constructor(code, message, tool, detail) {
    super(message);
    this.code = code;
    this.tool = tool;
    this.module = MODULE[tool.split(".")[0]] || tool.split(".")[0];
    this.missing = code === "no_such_tool" || code === "offline";
    if (detail) this.detail = detail;
  }
}

/** Extra headers for every call (the onboarding token). */
const headers = {};
export function setHeader(name, value) { if (value) headers[name] = value; else delete headers[name]; }

/**
 * Call a tool. Resolves to its data; rejects with an ApiError.
 * @param {string} name e.g. "projects.list"
 * @param {Record<string, any>} [input]
 */
export async function call(name, input = {}) {
  let res, body;
  try {
    res = await fetch("/v1/tools/" + encodeURIComponent(name), {
      method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck", ...headers }, body: JSON.stringify(input),
    });
    body = await res.json().catch(() => null);
  } catch {
    return fallback(name, input, new ApiError("offline", "vyred did not answer", name));
  }
  if (body && "data" in body && !body.error) return body.data;
  const err = new ApiError(body?.error?.code || "http_" + res.status, body?.error?.message || res.statusText, name, body?.error);
  if (err.missing || res.status === 404) return fallback(name, input, err);
  throw err;
}

/** Call, but resolve to { data } or { error } so a view can render either without try/catch. */
export async function attempt(name, input = {}) {
  try { return { data: await call(name, input) }; } catch (error) { return { error }; }
}

/**
 * The one byte transfer the Deck makes outside call(): a body PUT to a same-origin ticketed path
 * (e.g. what glass.files.upload returns), with progress. Moved here from deck/glass/transfer.js
 * so js/api.js stays the only place that talks to vyred.
 * @param {string} path a same-origin ticketed put path
 * @param {Blob} body
 * @param {(sent: number, total: number) => void} [progress]
 * @returns {{ done: Promise<any>, abort: () => void }}
 */
export function upload(path, body, progress) {
  const x = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    if (!path.startsWith("/")) { reject(Object.assign(new Error("the upload path is not on this box"), { code: "bad_path" })); return; }
    x.open("PUT", path);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.setRequestHeader("x-vyre-caller", "deck");
    x.upload.onprogress = e => progress?.(e.loaded, e.lengthComputable ? e.total : body.size);
    x.onload = () => {
      let b = null;
      try { b = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300 && !b?.error) resolve(b?.data ?? b);
      else reject(Object.assign(new Error(b?.error?.message || x.statusText || `the box answered ${x.status}`), { code: b?.error?.code || `http_${x.status}` }));
    };
    x.onerror = () => reject(Object.assign(new Error("the upload did not reach the box"), { code: "offline" }));
    x.onabort = () => reject(Object.assign(new Error("upload cancelled"), { code: "aborted" }));
    x.send(body);
  });
  return { done, abort: () => x.abort() };
}

const fixtureFiles = new Map();
const seqs = new Map();

async function fallback(name, input, err) {
  err.missing = true;
  if (!fixturesOn) throw err;
  const mod = name.split(".")[0];
  if (!fixtureFiles.has(mod)) fixtureFiles.set(mod, fetch(`/fixtures/${mod}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({})));
  const file = await fixtureFiles.get(mod);
  if (!(name in file)) throw err;
  fromFixtures.add(name);
  window.dispatchEvent(new CustomEvent("deck:fixture", { detail: name }));
  return fresh(structuredClone(pick(name, file[name], input)));
}

const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function fresh(v) {
  if (typeof v === "string") { const m = /^\$ago:(\d+)([smhd])$/.exec(v); return m ? Date.now() - Number(m[1]) * UNIT[m[2]] : v; }
  if (Array.isArray(v)) return v.map(fresh);
  if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = fresh(v[k]); }
  return v;
}

function pick(name, entry, input) {
  if (entry && typeof entry === "object" && "$by" in entry) {
    const v = input[entry.$by];
    return entry.cases[v] ?? entry.cases["*"] ?? null;
  }
  if (entry && typeof entry === "object" && "$seq" in entry) {
    const i = seqs.get(name) || 0;
    seqs.set(name, i + 1);
    return entry.$seq[Math.min(i, entry.$seq.length - 1)];
  }
  return entry;
}

/** vyred's module list (GET /v1/modules), or [] when it does not answer. */
export async function modules() {
  try { const r = await fetch("/v1/modules"); const b = await r.json(); return b.data || []; } catch { return []; }
}

// One EventSource for the whole Deck, shared by every view. Views load their state through tools
// and then follow events, so the stream starts at the newest event (since=latest) rather than
// replaying the log. After that, EventSource resumes by Last-Event-ID on its own.
/** @type {EventSource | null} */
let source = null;
let lastSeen = 0;
const subs = new Set();
// The SSE "event:" line carries the type, and named events never reach onmessage, so every type
// a view may want is listened for by name.
const known = new Set(["thread.started", "thread.sent", "thread.text", "thread.tool", "thread.finished", "thread.stopped",
  "ask.raised", "ask.answered", "lease.changed", "session.indexed", "memory.curated", "project.created", "project.changed",
  "thread.picked", "thread.unpicked", "tool.held", "turn.completed", "file.touched",
  "gate.held", "gate.released", "gate.failed", "gate.rejected",
  "lesson.proposed", "lesson.learned", "lesson.caught", "lesson.broken", "lesson.escalated", "lesson.retired",
  "onboard.stepped", "onboard.finished", "vault.item-added", "vault.granted", "vault.revoked", "pass.created", "pass.revoked"]);

/**
 * Listen to vyred's events. type is "thread.text", "thread.*" or "*"; a prefix type hears only
 * the names in `known`. Returns an unsubscribe.
 * @param {string} type
 * @param {(e: { id: number, at: number, type: string, source: string, project: string|null, thread: string|null, payload: any }) => void} fn
 */
export function on(type, fn) {
  const sub = { type, fn };
  subs.add(sub);
  if (!type.includes("*") && !known.has(type)) { known.add(type); source?.addEventListener(type, deliver); }
  if (!source && typeof EventSource !== "undefined") {
    // An EventSource cannot send headers, so the onboarding session rides as ?s=.
    const s = headers["x-vyre-onboard"];
    source = new EventSource("/v1/events/stream?since=latest" + (s ? `&s=${encodeURIComponent(s)}` : ""));
    for (const t of known) source.addEventListener(t, deliver);
  }
  return () => { subs.delete(sub); };
}

/** @param {MessageEvent} m */
function deliver(m) {
  let e;
  try { e = JSON.parse(m.data); } catch { return; }
  if (e.id <= lastSeen) return;
  lastSeen = e.id;
  for (const s of subs) {
    const t = s.type;
    if (t === "*" || t === e.type || (t.endsWith(".*") && e.type.startsWith(t.slice(0, -1)))) {
      try { s.fn(e); } catch (err) { console.error(err); }
    }
  }
}
