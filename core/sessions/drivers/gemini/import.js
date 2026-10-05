// @ts-check
// import/formats/gemini: Google Gemini CLI sessions, read and converted to Claude Code's transcript shape.
//
// On disk (google-gemini/gemini-cli, chatRecordingService): ~/.gemini/tmp/<projectHash>/chats/session-*.jsonl
// (older versions wrote one session-*.json). JSONL: a first metadata record { sessionId, projectHash,
// startTime, lastUpdated, kind, directories }, then one MessageRecord per line { id, timestamp,
// type: user|gemini|info, content, toolCalls? }, where a later line with the same id replaces the
// earlier one, { $set: {...} } updates metadata and { $rewindTo: id } drops that message and
// everything after it. The legacy .json file is that conversation as one object.
//
// projectHash = sha256 of the project root path, so the folder is not stored: it is found by
// hashing the folders the caller knows. Only tmp/<64 hex>/chats/session-* is listed or opened;
// oauth_creds.json, google_accounts.json and .env in the Gemini home are never touched.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { subdirs, files, allowed, readAllowed, line, textOf } from "../import-shared.js";

export const source = "gemini-cli";
const ALLOW = /^tmp\/[0-9a-f]{64}\/chats\/session-[A-Za-z0-9._:-]+\.jsonl?$/;
const NAME = /^session-[A-Za-z0-9._:-]+\.jsonl?$/;
/** Resolving the folder reads no file content: it comes from the hash in the folder name. */
export const headBytes = 0;

/** @param {string} home @param {string} file */
export const isAllowed = (home, file) => allowed(home, file, ALLOW);
/** @param {string} p */
export const hashOf = p => crypto.createHash("sha256").update(p).digest("hex");

/** The session files, only under tmp/<hash>/chats, never a link. @param {string} home */
export function list(home) {
  const out = [];
  for (const h of subdirs(path.join(home, "tmp"), /^[0-9a-f]{64}$/))
    for (const file of files(path.join(h, "chats"), NAME)) {
      if (!isAllowed(home, file)) continue;
      try { const st = fs.lstatSync(file); if (!st.isFile()) continue; out.push({ file, id: "gemini-" + path.basename(file).replace(/\.jsonl?$/, ""), bytes: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
    }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The project hash a file sits under. @param {string} file */
export const projectHashOf = file => path.basename(path.dirname(path.dirname(file)));

/**
 * The folder of a session, by hashing candidate folders (the caller's known projects) against the
 * project hash in its path; null when none matches.
 * @param {string} home @param {string} file @param {{ candidates?: string[] }} [o]
 */
export function head(home, file, o = {}) {
  if (!isAllowed(home, file)) return null;
  const want = projectHashOf(file);
  for (const c of o.candidates || []) { const p = String(c).replace(/(.)\/+$/, "$1"); if (hashOf(p) === want) return p; }
  return null;
}

/** @param {any} c */
function partsText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : "")).join("");
  return c && typeof c.text === "string" ? c.text : "";
}

/** Messages of one session file, with replaced, rewound and updated records applied. @param {string} raw */
function messages(raw) {
  /** @type {any} */ let meta = {};
  /** @type {any[]} */ let msgs = [];
  const t = raw.trim();
  if (t.startsWith("{") && !t.includes("\n{")) {
    try { const j = JSON.parse(t); if (Array.isArray(j.messages)) return { meta: j, msgs: j.messages }; } catch { /* not one object */ }
  }
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || typeof r !== "object") continue;
    if (r.$rewindTo !== undefined) { const i = msgs.findIndex(m => m.id === r.$rewindTo); if (i >= 0) msgs = msgs.slice(0, i); continue; }
    if (r.$set && typeof r.$set === "object") { meta = { ...meta, ...r.$set }; continue; }
    if (r.id !== undefined && typeof r.type === "string") { const i = msgs.findIndex(m => m.id === r.id); if (i >= 0) msgs[i] = r; else msgs.push(r); continue; }
    if (r.sessionId) meta = { ...meta, ...r };
  }
  return { meta, msgs };
}

/**
 * Convert one session to Claude Code's JSONL shape. Reads the whole file, and only if allowlisted.
 * @param {string} home @param {string} file @param {{ cwd?: string|null, candidates?: string[] }} [o]
 * @returns {{ id: string, cwd: string|null, text: string, turns: number }}
 */
export function convert(home, file, o = {}) {
  const raw = readAllowed(home, file, ALLOW);
  const { meta, msgs } = messages(raw);
  const id = String(meta.sessionId || path.basename(file).replace(/\.jsonl?$/, ""));
  let cwd = o.cwd || head(home, file, o);
  if (!cwd) for (const d of Array.isArray(meta.directories) ? meta.directories : []) if (typeof d === "string" && hashOf(d) === projectHashOf(file)) cwd = d;
  let last = String(meta.startTime || ""), seq = 0, n = 0, prev = null;
  const out = [];
  const emit = (/** @type {"user"|"assistant"} */ type, /** @type {any} */ content, /** @type {string} */ ts) => {
    const uuid = `${id}-${String(seq++).padStart(6, "0")}`;
    out.push(line({ type, ...(prev ? { parentUuid: prev } : {}), uuid, ...(cwd ? { cwd } : {}), sessionId: id, timestamp: ts || last, message: { role: type, content } }));
    prev = uuid;
  };
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const ts = typeof m.timestamp === "string" ? m.timestamp : "";
    if (ts) last = ts;
    if (m.type === "user") {
      const t = partsText(m.content).trim();
      if (t) { emit("user", t, ts); n++; }
    } else if (m.type === "gemini") {
      const t = partsText(m.content).trim();
      if (t) { emit("assistant", t, ts); n++; }
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        if (!tc || typeof tc !== "object") continue;
        const tid = String(tc.id || `call-${seq}`);
        emit("assistant", [{ type: "tool_use", id: tid, name: String(tc.name || "tool"), input: tc.args && typeof tc.args === "object" ? tc.args : {} }], ts);
        if (tc.result !== undefined) emit("user", [{ type: "tool_result", tool_use_id: tid, content: textOf(tc.result) }], ts);
      }
    }
  }
  return { id, cwd: cwd || null, text: out.join(""), turns: n };
}
