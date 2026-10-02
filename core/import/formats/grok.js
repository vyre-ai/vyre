// @ts-check
// import/formats/grok: xAI's Grok Build sessions, read and converted to Claude Code's transcript shape.
//
// On disk (measured on a real signed-in account, 2 Oct 2026, chat_format_version 1): $GROK_HOME (default ~/.grok)/sessions/<the working
// folder, percent-encoded>/<session id>/ holding summary.json ({ info: { id, cwd }, created_at, updated_at, num_messages, ... }),
// chat_history.jsonl (one JSON object a line: { type: "system" | "user" | "reasoning" | "assistant" | "tool_result", content: a string
// or [{ type: "text", text }], synthetic_reason?: "system_reminder", prompt_index? }), and files this reader never lists (updates.jsonl,
// events.jsonl, terminal logs, images and the lock files). prompt_history.jsonl sits beside the session folders and is not a session.
//
// Only sessions/<folder>/<uuid>/chat_history.jsonl is listed or opened, plus its sibling summary.json for the head. The sign-in
// (config.toml, auth files) sits in the Grok home itself and is never read, listed or matched.

import fs from "node:fs";
import path from "node:path";
import { subdirs, allowed, readAllowed, line, HEAD_MAX } from "./shared.js";

export const source = "grok";
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ALLOW = new RegExp(`^sessions/[^/]+/${ID}/(?:chat_history|summary)\\.(?:jsonl|json)$`, "i");
const SESSION = new RegExp(`^${ID}$`, "i");
export const headBytes = HEAD_MAX;

/** @param {string} home @param {string} file */
export const isAllowed = (home, file) => allowed(home, file, ALLOW);

/** The session files: sessions/<folder>/<uuid>/chat_history.jsonl, never a link. @param {string} home */
export function list(home) {
  const out = [];
  for (const folder of subdirs(path.join(home, "sessions"), /^[^/]+$/))
    for (const dir of subdirs(folder, SESSION)) {
      const file = path.join(dir, "chat_history.jsonl");
      if (!isAllowed(home, file)) continue;
      try { const st = fs.lstatSync(file); if (!st.isFile()) continue; out.push({ file, id: path.basename(dir).toLowerCase(), bytes: st.size, mtime: st.mtimeMs }); } catch { /* no history file */ }
    }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The folder a session ran in: summary.json's info.cwd, else the percent-encoded folder name, or null. @param {string} home @param {string} file */
export function head(home, file) {
  const summary = path.join(path.dirname(file), "summary.json");
  try {
    const j = JSON.parse(readAllowed(home, summary, ALLOW));
    if (j && j.info && typeof j.info.cwd === "string" && j.info.cwd) return j.info.cwd;
  } catch { /* fall back to the folder's name */ }
  try {
    const c = decodeURIComponent(path.basename(path.dirname(path.dirname(file))));
    return c.startsWith("/") || /^[A-Za-z]:[\\/]/.test(c) ? c : null;
  } catch { return null; }
}

/** @param {any} c */
function textOfContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((/** @type {any} */ b) => (b && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

/**
 * Convert one session to Claude Code's JSONL shape. Typed turns and replies only: system prompts, reasoning and tool output are left out.
 * @param {string} home @param {string} file @param {{ cwd?: string|null }} [o]
 * @returns {{ id: string, cwd: string|null, text: string, turns: number }}
 */
export function convert(home, file, o = {}) {
  const raw = readAllowed(home, file, ALLOW);
  const id = path.basename(path.dirname(file)).toLowerCase();
  const cwd = (typeof o.cwd === "string" && o.cwd) || head(home, file);
  let started = "", ended = "";
  try {
    const s = JSON.parse(readAllowed(home, path.join(path.dirname(file), "summary.json"), ALLOW));
    started = String(s.created_at || ""); ended = String(s.updated_at || started);
  } catch { /* no summary: the times stay empty */ }
  const out = [];
  let n = 0, seq = 0, prev = /** @type {string|null} */ (null);
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || (r.type !== "user" && r.type !== "assistant")) continue;
    const t = textOfContent(r.content).trim();
    if (!t) continue;
    const meta = r.type === "user" && typeof r.synthetic_reason === "string";
    const uuid = `${id}-${String(seq++).padStart(6, "0")}`;
    out.push(line({ type: r.type, ...(prev ? { parentUuid: prev } : {}), uuid, ...(cwd ? { cwd } : {}), sessionId: id, timestamp: started || ended || "", message: { role: r.type, content: t }, ...(meta ? { isMeta: true } : {}) }));
    prev = uuid;
    if (!meta) n++;
  }
  return { id, cwd, text: out.join(""), turns: n };
}
