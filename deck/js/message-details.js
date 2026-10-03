// @ts-check
// Message details (design-system.md section 4, ux-research.md section 5.2): the time beside an author's name, or the avatar beside a message, opens what is known
// about that message: who, the model, when, the tools it used and what the turn cost. It is read from the rows the thread has drawn, so it needs no request and
// shows only what is there. A sheet for now (a side pane on a wide window comes with the Chat pass).

import { h, put } from "./dom.js";
import { openSheet } from "./sheet.js";

/** The row element a click landed in, if it landed on a message's avatar, name or time. @param {any} t */
export function messageHit(t) {
  let hit = false;
  for (let n = t; n && n.tagName; n = n.parentNode) {
    const c = n.classList;
    if (c && (c.contains("vy-av") || c.contains("msg-when") || c.contains("msg-who") || c.contains("msg-av-wrap"))) hit = true;
    if (c && c.contains("cv-row") && (n._kind === "user" || n._kind === "assistant")) return hit ? n : null;
    if (String(n.tagName).toUpperCase() === "A" || String(n.tagName).toUpperCase() === "BUTTON") { if (!(c && (c.contains("msg-when") || c.contains("msg-who")))) return null; }
  }
  return null;
}

/**
 * What the thread has drawn about one message row.
 * @param {any} row
 * @returns {{ who: string, kind: string, model: string|null, at: number|null, tools: string[], turn: string|null }}
 */
export function detailsOf(row) {
  const q = (/** @type {any} */ el, /** @type {string} */ sel) => (typeof el.querySelector === "function" ? el.querySelector(sel) : null);
  const textOf = (/** @type {any} */ el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
  const who = textOf(q(row, ".msg-who")) || "Vyre";
  const kind = row._kind === "user" ? (who === "you" ? "You" : "Person") : "Assistant or agent";
  const model = textOf(q(row, ".msg-prov")) || null;
  /** @type {string[]} */ const tools = [];
  let turn = /** @type {string|null} */ (null);
  if (row._kind === "assistant") {
    const sibs = Array.from(row.parentNode?.childNodes || []);
    for (const n of /** @type {any[]} */ (sibs.slice(sibs.indexOf(row) + 1))) {
      const c = n.classList;
      if (!c) continue;
      if (c.contains("cv-head") || c.contains("cv-user")) break;
      if (c.contains("cv-tool")) { const t = textOf(q(n, ".cv-tool-head")) || textOf(n); if (t) tools.push(t.slice(0, 80)); }
      if (c.contains("cv-turn")) { turn = textOf(n) || null; break; }
    }
  }
  return { who, kind, model, at: typeof row._ts === "number" ? row._ts : null, tools, turn };
}

/** @param {number|null} at */
export function fullTime(at) {
  if (!at) return "Not recorded";
  try { return new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", second: "2-digit" }); } catch { return String(at); }
}

/** @param {any} row */
export function openMessageDetails(row) {
  const d = detailsOf(row);
  /** @type {[string, string|Node][]} */ const rows = [["Who", `${d.who}, ${d.kind.toLowerCase()}`]];
  if (d.model) rows.push(["Model", d.model]);
  rows.push(["Time", fullTime(d.at)]);
  if (d.tools.length) rows.push(["Tools", h("ul", { class: "md-tools" }, d.tools.map(t => h("li", null, t)))]);
  if (d.turn) rows.push(["Turn", d.turn]);
  return openSheet({ title: "Message details", build: body => put(body, h("dl", { class: "ac-rows md" }, rows.map(([k, v]) => h("div", { class: "ac-row" }, h("dt", null, k), h("dd", null, v))))) });
}
