// @ts-check
// Block renderers for the session view: recall.transcript's blocks (contract 2) as DOM. A reply's
// text is markdown (lib/markdown.js, never parsed as markup), thinking is folded under
// "Thinking", and each tool call is a card that knows its tool: Bash shows the command and what
// it printed, an edit shows a unified diff, a write a preview of the new file, a read the first
// lines, a search a compact list, a fetch its link, a todo list its checklist, anything else its
// input as keys and values. A live card (built from thread.tool's summary before the transcript
// has the call) is the same card with less in it, and becomes the rich one in place.
//
// Every visual is a cv- class in chat.css ("session view" section), so a restyle is CSS only.
// Nothing here uses innerHTML: every string is a text node.

import { h, add, put } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { clock } from "../js/fmt.js";
import { renderMarkdown } from "./lib/markdown.js";
import { renderUnified } from "./lib/diff.js";
import { highlight } from "./lib/highlight.js";
import { clip, commandText, duration, langOf, rawLines, toolState, toolTitle, turnParts } from "./lib/blocks.js";

const OUTPUT_LINES = 12;
/** Tools whose card opens on its own: what they did is the point. The rest open on a tap. */
const OPEN = new Set(["Bash", "Edit", "MultiEdit", "Write", "TodoWrite"]);

/** A row's kind, for the header rule (lib/blocks.js plan): user, assistant, turn, or card. */
const tag = (el, kind, ts) => { /** @type {any} */ (el)._kind = kind; /** @type {any} */ (el)._ts = ts ?? null; return el; };

/** "you" (or a surface's name) and the words, as a chat message. */
export function userRow(who, text, ts) {
  return tag(h("div", { class: "msg cv-row cv-user" },
    h("span", { class: "av-person msg-av" }, String(who).slice(0, 2).toUpperCase()),
    h("div", { class: "msg-body" },
      h("div", { class: "msg-head" }, h("span", { class: "msg-who" }, who), ts ? h("span", { class: "msg-when" }, clock(ts)) : null),
      h("div", { class: "msg-text cv-user-text" }, String(text ?? ""))),
  ), "user", ts);
}

/** The header an assistant run starts with: "Vyre" (or the agent's name) and the time. */
export function headRow(who, ts) {
  return tag(h("div", { class: "cv-row cv-head" },
    h("span", { class: "av-agent msg-av" }, String(who).slice(0, 2).toLowerCase()),
    h("span", { class: "msg-who" }, who),
    ts ? h("span", { class: "msg-when" }, clock(ts)) : null,
  ), "assistant", ts);
}

/** Assistant text as markdown. */
export function textRow(text, ts) {
  const el = h("div", { class: "cv-row cv-text msg-text" });
  add(el, renderMarkdown(text));
  return tag(el, "assistant", ts);
}

/**
 * A reply still streaming: text grows, markdown re-renders at most every `every` ms, a cursor
 * sits at the end until done() is called.
 * @returns {HTMLElement & { push: (delta: string) => void, set: (text: string) => void, done: () => void, text: () => string }}
 */
export function liveTextRow(ts, every = 120) {
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-text msg-text cv-live" }), "assistant", ts));
  let text = "", timer = null, finished = false;
  const draw = () => {
    timer = null;
    el.replaceChildren();
    add(el, renderMarkdown(text));
    if (!finished) {
      // The cursor goes inside the last paragraph when there is one, so it sits after the words.
      const last = el.lastElementChild && /^(P|LI|H\d)$/.test(el.lastElementChild.tagName) ? el.lastElementChild : el;
      last.append(h("span", { class: "msg-cursor" }));
    }
  };
  const soon = () => { if (!timer) timer = setTimeout(draw, every); };
  el.push = d => { text += d; soon(); };
  el.set = t => { text = String(t ?? ""); soon(); };
  el.done = () => { finished = true; if (timer) clearTimeout(timer); draw(); el.classList.remove("cv-live"); };
  el.text = () => text;
  draw();
  return el;
}

/** Thinking, folded: "Thinking" opens it. */
export function thinkingRow(text, ts) {
  const body = h("div", { class: "cv-think-body", hidden: true }, String(text ?? ""));
  const btn = h("button", { class: "cv-think-head", type: "button", "aria-expanded": "false", onclick: () => {
    body.hidden = !body.hidden; btn.setAttribute("aria-expanded", String(!body.hidden));
  } }, icon("chevron", 12), "Thinking");
  return tag(h("div", { class: "cv-row cv-think" }, btn, body), "assistant", ts);
}

/** The quiet line under a turn: time taken, tokens, cost. */
export function turnRow(t) {
  const parts = turnParts(t);
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-turn" + (t.open ? " cv-open" : "") }, parts.length ? parts.join(" · ") : null), "turn", t.ts));
  el._cost = typeof t.cost_usd === "number" ? t.cost_usd : null;
  return el;
}

// ---- tool cards ---------------------------------------------------------------

/** Output text, clipped past `max` lines with "show all". */
export function outputEl(text, { err = false, lang = "text", max = OUTPUT_LINES } = {}) {
  const c = clip(text, max);
  const pre = h("pre", { class: "cv-out" + (err ? " cv-err" : "") });
  const fill = s => { const code = h("code", { class: "lang-" + lang }); for (const t of highlight(s, lang)) add(code, t.cls ? h("span", { class: t.cls }, t.text) : t.text); put(pre, code); };
  fill(c.shown);
  if (!c.hidden) return pre;
  const more = h("button", { class: "cv-more", type: "button", onclick: () => { fill(String(text).replace(/\n+$/, "")); more.remove(); } }, `show all (${c.total} lines)`);
  return h("div", { class: "cv-out-wrap" }, pre, more);
}

const safeUrl = u => /^https?:\/\//i.test(String(u || ""));

/** Keys and values, for a tool (or an ask) this view has no special shape for. */
export function kvGrid(obj) {
  const rows = Object.entries(obj || {}).filter(([, v]) => v != null && v !== "");
  if (!rows.length) return null;
  return h("div", { class: "cv-kv" }, rows.map(([k, v]) => [
    h("span", { class: "cv-kv-k" }, k),
    h("span", { class: "cv-kv-v" }, typeof v === "string" ? v.slice(0, 2000) : JSON.stringify(v, null, 1).slice(0, 2000)),
  ]));
}

/** A todo list: completed struck through, the one in progress marked. */
export function checklist(todos) {
  return h("ul", { class: "cv-todos" }, (todos || []).map(t => h("li", { class: "cv-todo cv-todo-" + String(t && t.status || "pending") },
    h("span", { class: "cv-todo-box", "aria-hidden": "true" }, t && t.status === "completed" ? "✓" : ""),
    h("span", { class: "cv-todo-text" }, String((t && (t.status === "in_progress" && t.activeForm ? t.activeForm : t.content)) ?? "")),
  )));
}

/** The body of a tool card for its tool. */
function toolBody(b) {
  const i = b.input || {};
  const out = b.output;
  const err = !!b.error;
  const parts = [];
  switch (b.tool) {
    case "Bash":
      parts.push(h("pre", { class: "cv-cmd" }, h("code", null, "$ " + String(i.command ?? b.summary ?? ""))));
      if (i.description) parts.push(h("div", { class: "cv-note" }, String(i.description)));
      if (out != null && out !== "") parts.push(outputEl(out, { err, lang: "text" }));
      break;
    case "Edit":
      parts.push(fileLine(i.file_path));
      if (i.old_string != null || i.new_string != null) parts.push(renderUnified(i.old_string ?? "", i.new_string ?? ""));
      if (err && out) parts.push(outputEl(out, { err }));
      break;
    case "MultiEdit":
      parts.push(fileLine(i.file_path));
      for (const e of Array.isArray(i.edits) ? i.edits : []) parts.push(renderUnified(e.old_string ?? "", e.new_string ?? ""));
      if (err && out) parts.push(outputEl(out, { err }));
      break;
    case "Write":
      parts.push(fileLine(i.file_path, "new file"));
      if (i.content != null) parts.push(outputEl(i.content, { lang: langOf(i.file_path), max: 20 }));
      if (err && out) parts.push(outputEl(out, { err }));
      break;
    case "Read":
      parts.push(fileLine(i.file_path));
      if (out) parts.push(outputEl(out, { err, lang: err ? "text" : langOf(i.file_path) }));
      break;
    case "Grep": case "Glob": {
      const lines = out ? String(out).split("\n").filter(Boolean) : [];
      if (err) { parts.push(outputEl(out, { err })); break; }
      if (!lines.length && out != null) parts.push(h("div", { class: "cv-note" }, "No matches"));
      const list = h("ul", { class: "cv-hits" }, lines.slice(0, 20).map(l => h("li", null, l)));
      if (lines.length) parts.push(list);
      if (lines.length > 20) parts.push(h("button", { class: "cv-more", type: "button", onclick: e => {
        put(list, lines.map(l => h("li", null, l))); /** @type {any} */ (e.currentTarget).remove(); } }, `show all (${lines.length})`));
      break;
    }
    case "WebFetch": case "WebSearch": {
      const url = i.url;
      parts.push(h("div", { class: "cv-link" }, icon("search", 12),
        url && safeUrl(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, String(url)) : h("span", null, String(url || i.query || b.summary || ""))));
      if (i.prompt) parts.push(h("div", { class: "cv-note" }, String(i.prompt)));
      if (out) parts.push(outputEl(out, { err, max: 8 }));
      break;
    }
    case "TodoWrite":
      parts.push(checklist(Array.isArray(i.todos) ? i.todos : []));
      break;
    default:
      if (Object.keys(i).length) parts.push(kvGrid(i));
      else if (b.summary) parts.push(h("div", { class: "cv-note" }, b.summary));
      if (b.destination) parts.push(h("div", { class: "cv-note" }, "to " + b.destination));
      if (out) parts.push(outputEl(out, { err }));
  }
  return parts;
}

function fileLine(path, note) {
  return h("div", { class: "cv-file" }, icon("file", 12), h("span", { class: "cv-file-path" }, String(path || "")), note ? h("span", { class: "cv-file-note" }, note) : null);
}

/**
 * A tool call as a card. `b` is a transcript tool block, or a live one built from thread.tool
 * ({ tool, summary, destination } with no input yet). The card's .update(b) redraws it in place,
 * keeping whether it is open.
 * @returns {HTMLElement & { update: (b: any) => void }}
 */
export function toolCard(b) {
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-tool" }), "assistant", b.ts));
  let open = null;
  el.update = nb => {
    b = nb;
    const state = toolState(b);
    if (open === null && (state !== "running" || b.input)) open = OPEN.has(b.tool) || state === "failed";
    const title = b.input ? toolTitle(b.tool, b.input) : (b.summary || "");
    const d = duration(b.duration_ms);
    el.setAttribute("data-tool", String(b.tool || ""));
    el.setAttribute("data-state", state);
    const body = h("div", { class: "cv-tool-body", hidden: !open }, toolBody(b));
    const head = h("button", { class: "cv-tool-head", type: "button", "aria-expanded": String(!!open), onclick: () => {
      open = !open; body.hidden = !open; head.setAttribute("aria-expanded", String(open));
    } },
      h("span", { class: "cv-tool-name" }, displayName(b.tool)),
      h("span", { class: "cv-tool-title" }, title),
      d ? h("span", { class: "cv-tool-time" }, d) : null,
      h("span", { class: "cv-tool-state cv-" + state }, state),
    );
    put(el, head, body);
  };
  el.update(b);
  return el;
}

/** Tool names as a person reads them; unknown tools keep their own name. */
function displayName(tool) {
  return ({ TodoWrite: "Todos", MultiEdit: "Edit", WebFetch: "Fetch", WebSearch: "Search web", NotebookEdit: "Notebook" })[tool] || String(tool || "tool");
}

/** A block as its row. @param {any} b @param {{ who?: string }} [ctx] */
export function blockRow(b, ctx = {}) {
  if (b.kind === "user") { const el = userRow(ctx.who || "you", b.command ? commandText(b.text) : b.text, b.ts); if (b.command) el.classList.add("cv-command"); return el; }
  if (b.kind === "text") return textRow(b.text, b.ts);
  if (b.kind === "thinking") return thinkingRow(b.text, b.ts);
  if (b.kind === "tool") return toolCard(b);
  if (b.kind === "turn") return turnRow(b);
  return tag(h("div", { class: "cv-row" }), "card", b.ts);
}

// ---- the raw view -------------------------------------------------------------

/** The blocks the way Claude Code's terminal prints them, in one mono block. */
export function rawView(blocks) {
  const pre = h("pre", { class: "cv-raw" });
  for (const line of rawLines(blocks)) {
    const m = /^(⏺ |> |✻ |  ⎿  )(.*)$/.exec(line);
    if (m) add(pre, [h("span", { class: m[1] === "⏺ " ? "cv-raw-dot" : m[1] === "> " ? "cv-raw-you" : m[1] === "✻ " ? "cv-raw-think" : "cv-raw-out" }, m[1]), m[2], "\n"]);
    else add(pre, [line, "\n"]);
  }
  return pre;
}
