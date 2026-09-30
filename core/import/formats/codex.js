// @ts-check
// import/formats/codex: OpenAI Codex CLI sessions, read and converted to Claude Code's transcript shape.
//
// On disk (openai/codex, codex-rs/rollout): $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl,
// one JSON object per line { timestamp, ordinal?, type, payload }, where type is session_meta (first
// line: id, cwd, timestamp), response_item (message, function_call, function_call_output,
// local_shell_call, custom_tool_call, reasoning, ...), event_msg or turn_context. An older layout
// opened with a bare { id, timestamp, instructions } line and then bare { type: "message", role,
// content } records; both are read.
//
// Only that allowlisted shape is listed or opened. auth.json (the sign-in) sits in the Codex home
// itself and is never read, listed or matched.

import fs from "node:fs";
import path from "node:path";
import { subdirs, files, allowed, headText, readAllowed, line, textOf, HEAD_MAX } from "./shared.js";

export const source = "codex";
const ALLOW = /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9._:-]+\.jsonl$/;
const NAME = /^rollout-[A-Za-z0-9._:-]+\.jsonl$/;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]*)?\.jsonl$/i;
/** How much of a head is read to find the folder (scan cost accounting). */
export const headBytes = HEAD_MAX;

/** Where Codex keeps things. @param {string} home */
export const isAllowed = (home, file) => allowed(home, file, ALLOW);

/** The session files: only sessions/YYYY/MM/DD/rollout-*.jsonl, never a link. @param {string} home */
export function list(home) {
  const out = [];
  for (const y of subdirs(path.join(home, "sessions"), /^\d{4}$/))
    for (const m of subdirs(y, /^\d{2}$/))
      for (const d of subdirs(m, /^\d{2}$/))
        for (const file of files(d, NAME)) {
          if (!isAllowed(home, file)) continue;
          try { const st = fs.lstatSync(file); if (!st.isFile()) continue; out.push({ file, id: (UUID.exec(file)?.[1] || path.basename(file, ".jsonl")).toLowerCase(), bytes: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
        }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The folder a session ran in, from the head of the file only, or null. @param {string} home @param {string} file */
export function head(home, file) {
  let text;
  try { text = headText(home, file, ALLOW); } catch { return null; }
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.trim()) continue;
    let o = null;
    try { o = JSON.parse(row); } catch {
      // The last line of the head can be cut; the first line (session_meta) can hold long instructions.
      const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(row);
      if (m) { try { const c = JSON.parse(m[1]); if (typeof c === "string" && c) return c; } catch { /* cut */ } }
      continue;
    }
    const p = o?.payload && typeof o.payload === "object" ? o.payload : o;
    if (typeof p?.cwd === "string" && p.cwd) return p.cwd;
    // Older sessions carried the folder in the environment context message.
    const m = /<cwd>([^<]+)<\/cwd>/.exec(textOfMessage(p));
    if (m) return m[1].trim();
  }
  return null;
}

/** @param {any} p */
function textOfMessage(p) {
  if (!p || p.type !== "message" || !Array.isArray(p.content)) return "";
  return p.content.map(/** @param {any} c */ c => (c && typeof c.text === "string" ? c.text : "")).join("\n");
}
const INJECTED = /^\s*<(?:environment_context|user_instructions|user_action|turn_aborted|permissions instructions|collaboration_mode)|^\s*# AGENTS\.md instructions/;
const KNOWN = new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted"]);

/**
 * Convert one session to Claude Code's JSONL shape. Reads the whole file, and only if allowlisted.
 * @param {string} home @param {string} file @param {{ cwd?: string|null }} [o]
 * @returns {{ id: string, cwd: string|null, text: string, turns: number }}
 */
export function convert(home, file, o = {}) {
  const raw = readAllowed(home, file, ALLOW);
  let id = (UUID.exec(file)?.[1] || path.basename(file, ".jsonl")).toLowerCase();
  let cwd = null, started = "", last = "", n = 0, seq = 0, prev = null;
  /** @type {any[]} */ const rows = [];
  for (const l of raw.split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* a half-written line */ } }
  // Legacy first line: { id, timestamp, instructions }.
  const first = rows[0];
  if (first && !first.type && first.id && first.instructions !== undefined) { id = String(first.id); started = String(first.timestamp || ""); }
  for (const r of rows) if (r?.type === "session_meta" && r.payload) { if (r.payload.id) id = String(r.payload.id); cwd = r.payload.cwd || cwd; started = started || String(r.payload.timestamp || r.timestamp || ""); break; }
  cwd = cwd || (typeof o.cwd === "string" ? o.cwd : null) || head(home, file);
  last = started;
  const out = [];
  const emit = (/** @type {"user"|"assistant"} */ type, /** @type {any} */ content, /** @type {string} */ ts, extra = {}) => {
    const uuid = `${id}-${String(seq++).padStart(6, "0")}`;
    out.push(line({ type, ...(prev ? { parentUuid: prev } : {}), uuid, ...(cwd ? { cwd } : {}), sessionId: id, timestamp: ts || last, message: { role: type, content }, ...extra }));
    prev = uuid;
  };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const ts = typeof r.timestamp === "string" && r.type ? r.timestamp : "";
    if (ts) last = ts;
    if (r.type && KNOWN.has(r.type)) { if (r.type !== "response_item") continue; }
    const p = r.type === "response_item" ? r.payload : r.type && !KNOWN.has(r.type) ? r : null;
    if (!p || typeof p !== "object") continue;
    if (p.type === "message") {
      if (p.role !== "user" && p.role !== "assistant") continue;
      const t = textOfMessage(p).trim();
      if (!t) continue;
      const meta = p.role === "user" && INJECTED.test(t);
      emit(/** @type {any} */ (p.role), t, ts, meta ? { isMeta: true } : {});
      if (!meta) n++;
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      let input = {};
      if (p.type === "function_call") { try { input = JSON.parse(p.arguments); } catch { input = { arguments: String(p.arguments ?? "") }; } }
      else if (p.type === "custom_tool_call") input = { input: String(p.input ?? "") };
      else input = p.action || {};
      emit("assistant", [{ type: "tool_use", id: String(p.call_id || p.id || `call-${seq}`), name: String(p.name || (p.type === "local_shell_call" ? "shell" : "tool")), input }], ts);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      emit("user", [{ type: "tool_result", tool_use_id: String(p.call_id || ""), content: textOf(p.output) }], ts);
    }
  }
  return { id, cwd, text: out.join(""), turns: n };
}
