// @ts-check
// A report: docs/design/system/components/result-card.md, reused as-is for render kind "report"
// {view?, title, command?, rows | text, actions?}. Three views: table (rows, or columns on the
// desktop when the data names 3 or more), text (prose, or one code block), card (one thing and
// its facts). Eight rows (twelve text lines) then "Show all"; at most three actions as ghost
// buttons that open a link or call a named tool through the outbox; copy as text from the header
// button or Cmd/Ctrl+C on the focused card. Colours are theme variables only (report.css).

import { h, put, isPhone } from "../../js/dom.js";
import { queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { keyHint } from "../ask-item.js";
import { ensureCss, shell, chip, untrusted, problemText } from "./kit.js";

export const MAX_ROWS = 8;
export const MAX_TEXT_LINES = 12;
const MAX_ACTIONS = 3;
/** The only tools a report's button may call. A report is data a tool made, so a tool name inside it never decides
 * what runs: add a name here (a plain refresh or a pairing start, nothing that sends, merges or deletes). */
export const ACTION_TOOLS = new Set(["devices.refresh", "devices.pair", "recall.index", "planner.list"]);
const RUNNING = new Set(["running", "pending", "queued", "in_progress", "starting"]);
const FAILED = new Set(["failed", "failure", "error", "offline", "revoked", "expired"]);
const DONE = new Set(["ok", "done", "passed", "success", "connected", "active", "online", "ready", "live"]);

/** A status value as a mark state and its word. @param {any} v @returns {{ state: "running"|"done"|"failed"|"neutral", word: string }} */
export function statusOf(v) {
  const w = String(v ?? "").trim();
  const s = w.toLowerCase();
  return { state: RUNNING.has(s) ? "running" : FAILED.has(s) ? "failed" : DONE.has(s) ? "done" : "neutral", word: w };
}

/** Rows as cells, whatever shape they came in: an array is its cells; an object is its values, in key order. @param {any} r */
const cellsOf = r => Array.isArray(r) ? r : r && typeof r === "object" ? Object.entries(r).filter(([k]) => k !== "run" && k !== "href").map(([, v]) => v) : [r];
const cellText = (/** @type {any} */ v) => v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** The column names: data.columns, else the keys of the first object row. @param {any} d */
function columnsOf(d) {
  if (Array.isArray(d.columns) && d.columns.length) return d.columns.map(String);
  const r = Array.isArray(d.rows) ? d.rows[0] : null;
  return r && typeof r === "object" && !Array.isArray(r) ? Object.keys(r).filter(k => k !== "run" && k !== "href") : [];
}

/** The card's facts as [key, value] pairs, from pairs, {label, value} rows or a plain object. @param {any} rows @returns {[string, string][]} */
function factsOf(rows) {
  if (Array.isArray(rows)) return rows.map(r => Array.isArray(r) ? [cellText(r[0]), cellText(r[1])]
    : [cellText(r?.label ?? r?.key ?? r?.k ?? r?.name ?? ""), cellText(r?.value ?? r?.v ?? "")]);
  return rows && typeof rows === "object" ? Object.entries(rows).map(([k, v]) => [k, cellText(v)]) : [];
}

/** Which view: the one asked for, else text when there is text, else a table. @param {any} d @returns {"table"|"text"|"card"} */
function viewOf(d) {
  if (d.view === "table" || d.view === "text" || d.view === "card") return d.view;
  return d.text != null && d.rows == null ? "text" : "table";
}

/** The report as the CLI would print it: a table as aligned columns. @param {any} d */
export function reportText(d) {
  const v = viewOf(d), out = [];
  if (d.title) out.push(String(d.title));
  if (v === "text") out.push(String(d.text ?? ""));
  else if (v === "card") for (const [k, val] of factsOf(d.rows)) out.push(`${k}  ${val}`);
  else {
    const cols = columnsOf(d);
    const grid = (Array.isArray(d.rows) ? d.rows : []).map((/** @type {any} */ r) => cellsOf(r).map(cellText));
    if (cols.length) grid.unshift(cols);
    const w = grid[0]?.map((_, i) => Math.max(...grid.map((/** @type {string[]} */ g) => (g[i] || "").length))) || [];
    for (const g of grid) out.push(g.map((c, i) => i === g.length - 1 ? c : c.padEnd(w[i])).join("  ").trimEnd());
  }
  return out.join("\n");
}

/**
 * @param {any} data
 * @param {{ thread?: string|null, phone?: boolean, open?: (href: string) => void }} [ctx]
 */
export function report(data, ctx = {}) {
  ensureCss("report");
  const el = /** @type {any} */ (shell("cv-report", "Report"));
  el.setAttribute("tabindex", "0");
  const phone = ctx.phone ?? isPhone();
  const state = { all: false, busy: /** @type {number|null} */ (null), waiting: false, error: /** @type {any} */ (null), copied: false, done: /** @type {string|null} */ (null) };
  /** @type {any} */ let copyTimer = null;

  const human = (/** @type {any} */ e) => !(e && e.isTrusted === false);
  const actions = () => (Array.isArray(data.actions) ? data.actions : []).filter((/** @type {any} */ a) => a && a.label && allowed(a)).slice(0, MAX_ACTIONS);
  /** A link (from a Vyre tool's own result) or a tool on ACTION_TOOLS: never a name taken from the payload (reviewer-2 M1). */
  const allowed = (/** @type {any} */ a) => !ctx.readOnly && !!a && (!!a.href || ACTION_TOOLS.has(String(a.run?.tool)));

  /** Open a link, or call a named tool through the outbox. @param {any} a @param {number} i */
  async function act(a, i) {
    if (state.busy != null || !allowed(a)) return;
    if (a.href) { ctx.open?.(String(a.href)); return; }
    state.busy = i; state.waiting = false; state.error = null; state.done = null; draw();
    const r = await queued(String(a.run.tool), { ...(a.run.input || {}), ...(ctx.thread ? { thread: ctx.thread } : {}) }, { onWait: () => { state.waiting = true; draw(); } });
    state.busy = null; state.waiting = false;
    if (r.error) state.error = { r: r.error, a, i }; else state.done = a.done ? String(a.done) : null;
    draw();
  }

  async function copy() {
    try { await globalThis.navigator?.clipboard?.writeText(reportText(data)); } catch { return; }
    state.copied = true; draw();
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { state.copied = false; draw(); }, 2000);
    copyTimer.unref?.();
  }

  // ---- bodies -------------------------------------------------------------------------------

  function tableBody() {
    const all = Array.isArray(data.rows) ? data.rows : [];
    if (!all.length) return h("div", { class: "cv-rp-empty" }, String(data.empty || "Nothing to show"));
    const shown = state.all ? all : all.slice(0, MAX_ROWS);
    const cols = columnsOf(data);
    const wrap = (/** @type {any} */ kids) => h("div", { class: "cv-rp-scroll" + (state.all && all.length > MAX_ROWS ? " tall" : "") }, kids);
    if (!phone && cols.length >= 3) {
      return wrap(h("table", { class: "cv-rp-table" },
        h("thead", null, h("tr", null, cols.map((c, i) => h("th", { scope: "col", class: i > 0 && shown.every((/** @type {any} */ r) => typeof cellsOf(r)[i] === "number") ? "num" : null }, c)))),
        h("tbody", null, shown.map((/** @type {any} */ r) => h("tr", null, cellsOf(r).map((v, i) =>
          h("td", { class: typeof v === "number" ? "num" : null }, cols[i] === "status" ? statusCell(v) : cellText(v))))))));
    }
    return wrap(h("div", { class: "cv-rp-rows", role: "list" }, shown.map((/** @type {any} */ r) => rowEl(r, cols))));
  }

  function statusCell(/** @type {any} */ v) {
    const s = statusOf(v);
    return h("span", { class: "cv-rp-st" }, h("span", { class: `cv-mark cv-mark-${s.state}`, "aria-hidden": "true" }), s.word);
  }

  /** One row: title, then meta; a `status` column draws a mark before the title, its word in the meta. */
  function rowEl(/** @type {any} */ r, /** @type {string[]} */ cols) {
    let cells = cellsOf(r);
    let st = null;
    const si = cols.indexOf("status");
    if (si >= 0) { st = statusOf(cells[si]); cells = cells.filter((_, i) => i !== si); }
    const [title, ...rest] = cells.map(cellText);
    const meta = [st?.word, ...rest].filter(Boolean).join(" · ");
    const go = r && !Array.isArray(r) && allowed(r) ? r : null;
    const inner = [st ? h("span", { class: `cv-mark cv-mark-${st.state}`, "aria-hidden": "true" }) : null,
      h("span", { class: "cv-rp-title" }, title), meta ? h("span", { class: "cv-rp-meta" }, meta) : null];
    return go ? h("button", { class: "cv-rp-row go", type: "button", role: "listitem", onclick: (/** @type {any} */ e) => { if (human(e)) act(go, -1); } }, inner)
      : h("div", { class: "cv-rp-row", role: "listitem" }, inner);
  }

  function textBody() {
    const t = String(data.text ?? "");
    const lines = t.split("\n").length;
    const long = lines > MAX_TEXT_LINES || t.length > 1200;
    const isCode = data.code === true || /^```/.test(t.trim());
    const body = isCode ? h("pre", { class: "cv-rp-code" }, t.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, ""))
      : h("div", { class: "cv-rp-prose" }, t.split(/\n{2,}/).filter(p => p.trim()).map(p => h("p", null, p.trim())));
    return [h("div", { class: "cv-rp-text" + (long && !state.all ? " clamp" : "") }, body)];
  }

  function cardBody() {
    const facts = factsOf(data.rows);
    return h("div", { class: "cv-rp-card" },
      data.subject ? h("div", { class: "cv-rp-subject" }, String(data.subject)) : null,
      facts.map(([k, v]) => h("div", { class: "cv-rp-fact" }, h("span", { class: "cv-rp-k" }, k), h("span", { class: "cv-rp-v" }, v))));
  }

  // ---- the card -----------------------------------------------------------------------------

  const cutBy = () => {
    const v = viewOf(data);
    if (v === "table") return Array.isArray(data.rows) && data.rows.length > MAX_ROWS ? data.rows.length : 0;
    if (v === "text") { const t = String(data.text ?? ""); return t.split("\n").length > MAX_TEXT_LINES || t.length > 1200 ? t.split("\n").length : 0; }
    return 0;
  };

  function draw() {
    const v = viewOf(data);
    const title = String(data.title || "Report");
    el.setAttribute("aria-label", title);
    const acts = actions();
    const cut = cutBy();
    const err = data.error;
    put(el,
      h("div", { class: "cv-card-head cv-rp-head" },
        h("span", { class: "cv-card-ico", "aria-hidden": "true" }, data.running ? h("span", { class: "cv-ask-spin" }) : icon("terminal", 16)),
        h("span", { class: "cv-rp-htitle ellipsis" }, title),
        h("span", { class: "cv-card-sp" }),
        data.command ? h("span", { class: "cv-rp-cmd" }, String(data.command)) : null,
        h("button", { class: "ibtn cv-rp-copy", type: "button", "aria-label": "Copy as text", title: "Copy as text", onclick: (/** @type {any} */ e) => { if (human(e)) copy(); } },
          state.copied ? h("span", { class: "cv-rp-copied" }, "Copied") : icon("copy", 14))),
      err ? h("div", { class: "cv-rp-error", role: "alert" },
        h("span", { class: "cv-rp-errline" }, h("span", { class: "cv-mark cv-mark-failed", "aria-hidden": "true" }), problemText(typeof err === "object" ? err.title || err.message || "" : err)),
        typeof err === "object" && err.detail ? h("span", { class: "cv-rp-detail" }, untrusted(err.detail, 300)) : null)
        : v === "text" ? textBody() : v === "card" ? cardBody() : tableBody(),
      state.waiting ? h("div", { class: "cv-rp-queued" }, "Queued · runs when your server is back") : null,
      state.error ? h("div", { class: "cv-rp-error", role: "alert" },
        h("span", { class: "cv-rp-errline" }, h("span", { class: "cv-mark cv-mark-failed", "aria-hidden": "true" }), problemText(state.error.r)),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "retry", onclick: (/** @type {any} */ e) => { if (human(e)) act(state.error.a, state.error.i); } }, "Retry")) : null,
      state.done ? h("div", { class: "cv-rp-doneline" }, state.done) : null,
      (acts.length || (cut && !state.all)) ? h("div", { class: "cv-rp-foot" },
        acts.map((/** @type {any} */ a, /** @type {number} */ i) => h("button", { class: "btn btn-ghost btn-sm cv-rp-act", type: "button", "data-act": String(i), disabled: state.busy != null,
          "aria-busy": state.busy === i ? "true" : null, "aria-keyshortcuts": a.key ? String(a.key) : null,
          onclick: (/** @type {any} */ e) => { if (human(e)) act(a, i); } }, a.label, a.key ? keyHint(String(a.key)) : null)),
        h("span", { class: "cv-card-sp" }),
        cut && !state.all ? h("button", { class: "btn btn-ghost btn-sm cv-rp-all", type: "button",
          onclick: () => { state.all = true; draw(); } }, v === "table" ? `Show all ${cut}` : "Show all") : null) : null);
  }

  el.update = (/** @type {any} */ d) => { data = d || {}; draw(); };
  /** A key on the focused card: an action's key, or Cmd/Ctrl+C when nothing is selected. */
  el.onKey = (/** @type {any} */ e) => {
    if (!human(e) || e.metaKey || e.altKey) return false;
    if ((e.key === "c" || e.key === "C") && e.ctrlKey) { copy(); return true; }
    const i = actions().findIndex((/** @type {any} */ a) => a.key && String(a.key).toLowerCase() === String(e.key).toLowerCase());
    if (i < 0 || e.ctrlKey) return false;
    act(actions()[i], i); return true;
  };
  el.addEventListener("keydown", (/** @type {any} */ e) => {
    if (e.target && e.target !== el) return;
    if ((e.key === "c" || e.key === "C") && e.metaKey && !globalThis.getSelection?.()?.toString()) { copy(); e.preventDefault?.(); return; }
    if (el.onKey(e)) e.preventDefault?.();
  });
  draw();
  return el;
}
