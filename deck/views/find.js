// @ts-check
// Find: the phone's Lumen. One box at the top; as you type, what matches comes in below in a
// fixed order: ask the assistant, sessions, files, agents, memory, projects. With an empty box,
// the recent sessions and the agents. A pull-down from the top of any phone screen lands here
// (js/pwa.js). On desktop the same thing as a centred column.
//
// Tools, once on open: agents.list (the assistant's name, the Agents section), projects.catalog
// {limit: 300} and threads.list {all: true} merged by id (chat/lib/sessions.js) for session
// titles and Recent, projects.list for project names. Per query (180 ms after typing stops, two
// characters or more, stale answers dropped by sequence number): recall.search, files.search,
// memory.relevant. Agents and projects are filtered here. Vault results never show on the phone:
// vault items stay behind the Vault view.
//
// Asking: agents.ask {agent, text, surface: "deck"} waits for the whole turn, so the answer
// streams in beside it through thread.text. The thread is the assistant's current one when
// agents.list names it, else the one whose thread.sent carries this exact text from the deck.
// Only the last message of the turn is kept, as ask.js does. Nothing polls.
//
// Commands (js/commands.js, the grammar the Mac Lumen and the native apps share): "@kit ..."
// asks that agent (agents.ask, wait: false, then its thread opens); "tell <session> to ..." types
// into a session (threads.send) and watches it; "watch <session>" and "tell me when <session> is
// done" watch it (threads.watch, notify: "deck"). A line under the box says what Enter will do,
// and the matching sessions are listed so a tap picks another one.
//
// On a phone (under 760 px, docs/design/phone.md section 7) this is Lumen opened: the shell
// shows it as a full-height sheet, and this view draws its content. A top row with the box and
// Done (back to where the sheet came from), a segmented scope (All, Chats, Files, Memory, Run),
// then Ask, Run (the grammar above as plain-words rows, the command in mono under each), From
// memory, Chats and Files. An empty box shows the last 8 searches (localStorage, per phone) and
// the four most recent sessions. The layout is picked at render and redrawn when the width
// crosses 760 px; the desktop column is unchanged.

import { looksLikeQuestion, ask as askMemory } from "../js/memory-ask.js";
import { h, put, link, empty, go, back, PHONE_QUERY } from "../js/dom.js";
import { attempt, queued } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when, base, initial } from "../js/fmt.js";
import { mergeSessions, title } from "../chat/lib/sessions.js";
import { threadHref, projectHref } from "../chat/lib/routes.js";
import { parseCommand, plan, rankSessions } from "../js/commands.js";
import { machineChip } from "../js/machine.js";

const SHOW = 5;
const MIN = 2;
const DEBOUNCE_MS = 150;
const RECENT_KEY = "vyre.find.recent";
const RECENT_MAX = 8;
const SCOPES = [["all", "All"], ["chats", "Chats"], ["files", "Files"], ["memory", "Memory"], ["run", "Run"]];
const FILE_ICON = { folder: "projects", code: "terminal", text: "lines" };

const why = err => err?.missing
  ? (err.module === "switchboard" ? "Sessions are not available on this box, so the assistant cannot answer here yet." : `The ${err.module} module is not running on this machine.`) // internal-word: the module id, compared in code and never drawn
  : String(err?.message || err || "");
const size = n => !n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const words = q => q.toLowerCase().split(/\s+/).filter(Boolean);
const hasAll = (text, ws) => { const t = String(text || "").toLowerCase(); return ws.every(w => t.includes(w)); };

/** "~/work/site", the folder a file is in, kept short. */
function parent(p) {
  const s = String(p || "").replace(/^\/(Users|home)\/[^/]+/, "~");
  const parts = s.split("/");
  parts.pop();
  const dir = parts.join("/") || "/";
  const segs = dir.split("/").filter(Boolean);
  return segs.length > 3 ? "…/" + segs.slice(-2).join("/") : dir;
}

/** The searches kept on this phone, newest first. Storage can be missing or refuse; then none. */
function recentGet() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter(x => typeof x === "string" && x).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function recentAdd(/** @type {string} */ q) {
  try {
    const l = [q, ...recentGet().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(l));
  } catch {}
}

/** Text with the query's words marked. Text nodes only, never markup. */
function hl(text, q) {
  const s = String(text || "");
  const ws = words(q).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!ws.length) return s;
  return s.split(new RegExp(`(${ws.join("|")})`, "i")).map((part, i) => i % 2 ? h("mark", { class: "fd-m" }, part) : part);
}

/** "~/work/site/app/page.tsx", a path kept readable on a phone. */
const home = p => String(p || "").replace(/^\/(Users|home)\/[^/]+/, "~");

/** The typed words as a question. */
const asQuestion = q => /[?.!]$/.test(q) ? q : q + "?";

/** A recall snippet, its «» marks as highlighted spans. Text only, never markup. */
function snippet(s) {
  return String(s || "").split(/[«»]/).map((part, i) => i % 2 ? h("mark", { class: "fd-m" }, part) : part);
}

/** @param {any} ctx */
export default async function find(ctx) {
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "fd-in", class: "fd-in", type: "search", enterkeyhint: "search",
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Find or ask", "aria-label": "Find or ask",
    role: "combobox", "aria-controls": "fd-list", "aria-expanded": "true", "aria-autocomplete": "list" }));
  // The clear button shows only on the phone (find.css), and only with words in the box.
  const clear = h("button", { type: "button", class: "fd-clear", "aria-label": "Clear", hidden: true,
    onclick: () => { input.value = ""; input.dispatchEvent(new Event("input")); input.focus(); } }, icon("close", 16));
  const form = h("form", { class: "fd-form", role: "search" }, h("span", { class: "fd-glass", "aria-hidden": "true" }, icon("search", 18)), input, clear);
  const list = h("div", { id: "fd-list", class: "fd-list", role: "listbox", "aria-label": "Results" });
  const answer = h("section", { class: "fd-answer", "aria-live": "polite", hidden: true });
  const planLine = h("div", { class: "fd-plan small", role: "status" });

  // ---- phone or desktop: picked at render, redrawn when the width crosses 760 px ---------------
  const mq = matchMedia(PHONE_QUERY);
  let phone = mq.matches;
  /** The phone's segmented scope. */
  let scope = "all";
  const seg = h("div", { class: "fd-seg", role: "group", "aria-label": "Search in" });
  const drawSeg = () => put(seg, SCOPES.map(([k, label]) => h("button", { type: "button", class: "fd-segb", "aria-pressed": String(scope === k),
    onclick: () => { scope = k; drawSeg(); draw(); } }, label)));
  drawSeg();
  const done = h("button", { type: "button", class: "fd-done", onclick: () => back("/now") }, "Done");
  function placeholder() {
    const p = phone ? `Ask ${who()}, find, or run` : "Find or ask";
    input.placeholder = p;
    input.setAttribute("aria-label", p);
  }
  function frame() {
    phone = mq.matches;
    placeholder();
    put(ctx.root, phone
      ? h("div", { class: "fd fd-phone" }, h("div", { class: "fd-bar" }, h("div", { class: "fd-top" }, form, done), seg, planLine), list)
      : h("div", { class: "fd" }, h("div", { class: "fd-bar" }, form, planLine), list));
  }
  const onWidth = () => {
    if (mq.matches === phone) return;
    const focused = document.activeElement === input;
    frame();
    draw();
    if (focused) input.focus();
  };
  mq.addEventListener("change", onWidth);
  ctx.cleanup(() => mq.removeEventListener("change", onWidth));
  // A tapped result keeps the words in Recent searches.
  list.addEventListener("click", e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (cur.q.length >= MIN && t.closest?.("[data-row]") && !t.closest("[data-recent]")) recentAdd(cur.q);
  }, true);

  // ---- what is loaded once --------------------------------------------------------------
  const base_ = { agents: /** @type {any[]} */ ([]), rows: /** @type {any[]} */ ([]), projects: /** @type {any[]} */ ([]),
    names: new Map(), loaded: false, errs: /** @type {any[]} */ ([]) };
  const assistant = () => base_.agents.find(a => a.kind === "assistant");
  const who = () => assistant()?.name || "the assistant";

  // ---- the current query ----------------------------------------------------------------
  /** @type {{ q: string, n: number, recall?: any, files?: any, memory?: any }} */
  let cur = { q: "", n: 0 };
  let seq = 0, timer = 0, hi = -1;
  const expanded = new Set();
  /** @type {any} */ let asking = null;
  /** @type {HTMLElement | null} */ let sheet = null;
  frame();
  input.focus();

  const rowsNow = () => /** @type {HTMLElement[]} */ ([...list.querySelectorAll("[data-row]")]);
  function mark() {
    const items = rowsNow();
    if (hi >= items.length) hi = items.length - 1;
    items.forEach((el, i) => { el.id = `fd-r-${i}`; el.classList.toggle("hi", i === hi); el.setAttribute("aria-selected", String(i === hi)); });
    if (hi >= 0) { input.setAttribute("aria-activedescendant", `fd-r-${hi}`); items[hi].scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }

  /** One result: a link or a button, icon on the left, a line or two, something small on the right. */
  function row({ href, onclick, glyph, cls = "" }, main, right) {
    const kids = [h("span", { class: "fd-ic", "aria-hidden": "true" }, glyph || null), h("span", { class: "fd-main" }, main), right ? h("span", { class: "fd-right" }, right) : null];
    const props = { class: "fd-row " + cls, "data-row": "", role: "option", "aria-selected": "false" };
    return href ? link(href, props, kids) : h("button", { type: "button", ...props, onclick }, kids);
  }
  const line = (text, cls = "fd-title") => h("span", { class: cls }, text);
  /** A session's title, with the machine chip when it is the paired Mac's (js/machine.js). */
  // The chip sits beside the title, not in it, so a long title's ellipsis never hides it.
  const titled = (/** @type {string} */ text, /** @type {any} */ r) => {
    const chip = r ? machineChip(r) : null;
    return chip ? h("span", { class: "fd-tline" }, line(text), chip) : line(text);
  };

  /** A labelled section of at most SHOW rows, with "Show all N" when there are more. */
  function section(key, label, rows, { cls = "", lblCls = "", notes = [] } = {}) {
    const open = expanded.has(key);
    const shown = open ? rows : rows.slice(0, SHOW);
    return h("section", { class: "fd-sec " + cls, "aria-label": label },
      h("h2", { class: "lbl " + lblCls }, label),
      h("div", { class: "fd-rows" }, shown),
      rows.length > SHOW && !open ? h("button", { type: "button", class: "fd-more", onclick: () => { expanded.add(key); draw(); } }, `Show all ${rows.length}`) : null,
      notes.map(n => h("div", { class: "fd-note" }, n)));
  }

  // ---- sections -------------------------------------------------------------------------
  /** Sessions that match: by name first, then what recall found in their words. */
  function sessionHits(q) {
    const ws = words(q), byId = new Map(base_.rows.map(r => [r.id, r])), seen = new Set(), out = [];
    const add = s => { seen.add(s.id); out.push(s); };
    const from = (/** @type {any} */ r) => r && r.source === "mac" ? { source: "mac", machine: r.machine } : {};
    for (const r of base_.rows) if (r.name && hasAll(r.name, ws)) add({ id: r.id, title: title(r), snip: "", project: r.project, cwd: r.cwd, ts: r.last, ...from(r) });
    for (const x of Array.isArray(cur.recall?.data) ? cur.recall.data : []) {
      if (!x?.session || seen.has(x.session)) continue;
      const r = byId.get(x.session);
      add({ id: x.session, title: r ? title(r) : x.name || x.title || String(x.session).slice(0, 8), snip: x.snippet, project: r?.project || null, cwd: r?.cwd || x.cwd, ts: x.ts || r?.last, ...from(r || x) });
    }
    return out;
  }
  const projectOf = s => s.project ? base_.names.get(s.project) || s.project : base(s.cwd);

  function sessionRows(q) {
    return sessionHits(q).map(s => row({ href: threadHref({ id: s.id, project: s.project }), glyph: icon("chat", 16) },
      [titled(s.title, s), s.snip ? h("span", { class: "fd-snip" }, snippet(s.snip)) : null,
        line([s.project ? base_.names.get(s.project) || s.project : base(s.cwd), when(s.ts)].filter(Boolean).join(" · "), "fd-sub")]));
  }

  function fileSection() {
    const d = cur.files?.data;
    if (!d) return null;
    const results = Array.isArray(d.results) ? d.results : [];
    const notes = (Array.isArray(d.sources) ? d.sources : []).filter(s => s && s.ok === false)
      .map(s => `The ${s.source === "mac" ? "Mac" : s.source || "other machine"} did not answer${s.error ? ": " + s.error : "."}`);
    // The box does not search the Mac's files (the link carries no files.search), so say that,
    // unless a Mac did answer.
    const macAnswered = (Array.isArray(d.sources) ? d.sources : []).some(s => s && s.source === "mac" && s.ok !== false);
    if (!macAnswered && !results.some(f => f.source === "mac")) notes.push("Files on your Mac are not searched from here.");
    if (!results.length) return h("div", { class: "fd-note fd-lone" }, notes);
    const rows = results.map(f => row({ onclick: () => openFile(f), glyph: icon(FILE_ICON[f.kind] || "file", 16) },
      [line(f.name), line(parent(f.path), "fd-sub")], h("span", { class: "fd-tag" }, f.source === "mac" ? "mac" : "box")));
    return section("files", "Files", rows, { notes });
  }

  function agentRows(q) {
    const ws = words(q);
    return base_.agents.filter(a => hasAll(`${a.name} ${a.instructions || ""}`, ws)).map(a =>
      row({ href: `/agents/${encodeURIComponent(a.name)}`, glyph: icon("agents", 16) },
        [line(a.name), line(a.kind === "assistant" ? "your assistant" : String(a.instructions || "agent").split("\n")[0], "fd-sub")]));
  }

  function memoryRows(q) {
    const facts = Array.isArray(cur.memory?.data) ? cur.memory.data : [];
    return facts.filter(f => f && f.text).map(f => row({ href: `/memory?q=${encodeURIComponent(q)}`, glyph: h("span", { class: "dot recall" }), cls: "fd-recall" },
      [h("span", { class: "fd-fact" }, f.text), f.ref?.name || f.source ? line(f.ref?.name || f.source, "fd-sub fd-src") : null]));
  }

  function projectRows(q) {
    const ws = words(q);
    return base_.projects.filter(p => hasAll(`${p.name || ""} ${p.slug}`, ws)).map(p =>
      row({ href: projectHref(p.slug), glyph: icon("projects", 16) }, [line(p.name || p.slug)]));
  }

  // ---- commands ---------------------------------------------------------------------------
  /** @type {import("../js/commands.js").Command} */ let cmd = { kind: "ask", text: "" };
  /** The session a drive or watch goes to: the best match, or the one tapped. */
  let chosen = /** @type {any} */ (null);
  /** What the last command did, shown in place of the plan line until the box changes. */
  let done_ = "";
  function readCommand(text) {
    cmd = parseCommand(text, { agents: base_.agents, sessions: base_.rows, titleOf: title });
    const list_ = "candidates" in cmd ? cmd.candidates : [];
    if (!chosen || !list_.some(r => r.id === chosen.id)) chosen = list_[0] || null;
    drawPlan();
  }
  function drawPlan() {
    const q = input.value.trim();
    if (done_) { put(planLine, done_); return; }
    const short = (/** @type {string} */ t) => t.length > 36 ? t.slice(0, 35).trimEnd() + "…" : t;
    put(planLine, q && cmd.kind !== "ask" ? plan(cmd, chosen ? short(title(chosen)) : "", who()) : "");
  }
  /** The sessions a drive or watch could mean, first the chosen one; a tap picks. */
  function commandSection() {
    if (!("candidates" in cmd) || !cmd.candidates.length) return null;
    return section("cmd", cmd.kind === "drive" ? "Type into" : "Watch", cmd.candidates.map(r => row({ onclick: () => { chosen = r; drawPlan(); draw(); }, glyph: icon(r.id === chosen?.id ? "check" : "chat", 16), cls: r.id === chosen?.id ? "fd-chosen" : "" },
      [titled(title(r), r), line([r.project ? base_.names.get(r.project) || r.project : base(r.cwd), when(r.last)].filter(Boolean).join(" · "), "fd-sub")])));
  }
  async function runCommand() {
    const c = cmd;
    if (c.kind === "agent") {
      put(planLine, `Asking ${c.agent}…`);
      const r = await attempt("agents.ask", { agent: c.agent, text: c.text, surface: "deck", wait: false });
      if (!ctx.alive()) return;
      if (r.error) { done_ = why(r.error); drawPlan(); return; }
      if (r.data?.thread) { go(threadHref({ id: r.data.thread, project: r.data.project || null })); return; }
      done_ = `Sent to ${c.agent}.`; drawPlan(); return;
    }
    const s = chosen;
    if (!s || c.kind === "ask") return askNow(input.value.trim());
    const name = title(s);
    if (c.kind === "drive") {
      put(planLine, `Typing into ${name}…`);
      const r = await queued("threads.send", { thread: s.id, text: c.text, surface: "deck" });
      if (!ctx.alive()) return;
      if (r.error) { done_ = why(r.error); drawPlan(); return; }
      // Another keyboard has it and nothing queued: say so, keep the words, watch nothing.
      if (r.data?.sent === false && !r.data?.queued) { done_ = r.data.note || `${name} did not take it.`; drawPlan(); return; }
    }
    const w = await attempt("threads.watch", { thread: s.id, until: c.kind === "watch" ? c.until : "either", notify: "deck",
      note: c.kind === "drive" ? `Tell ${name}: ${c.text}` : `Watch ${name}` });
    if (!ctx.alive()) return;
    done_ = w.error ? why(w.error)
      : c.kind === "drive" ? `Sent to ${name}. You will hear when it finishes or asks.`
      : `Watching ${name}. You will hear when it ${c.kind === "watch" && c.until === "asks" ? "asks" : c.kind === "watch" && c.until === "finished" ? "is done" : "finishes or asks"}.`;
    if (!w.error) input.value = "";
    drawPlan();
    run(input.value.trim());
  }

  // ---- asking the assistant ---------------------------------------------------------------
  function drawAnswer() {
    const x = asking;
    answer.hidden = !x;
    if (!x) { put(answer); return; }
    put(answer,
      h("div", { class: "lbl" }, `You asked ${x.agent}`),
      h("div", { class: "fd-aq" }, x.q),
      x.text ? h("div", { class: "fd-atext" }, x.text) : null,
      x.status ? h("div", { class: "small muted", role: "status" }, x.status) : null,
      x.thread ? link(threadHref({ id: x.thread, project: x.project }), { class: "btn fd-open" }, "Open the thread") : null);
  }

  async function askNow(q) {
    const a = assistant();
    const agent = a?.name || "assistant";
    const x = { q, agent: a?.name || "the assistant", thread: a?.thread || null, project: null, sent: false, msg: null, text: "", done: false, status: `Asking ${who()}.` };
    asking = x;
    drawAnswer();
    draw();
    input.blur();
    const r = await attempt("agents.ask", { agent, text: q, surface: "deck" });
    if (!ctx.alive() || asking !== x) return;
    if (r.error) { x.status = why(r.error); drawAnswer(); return; }
    const d = r.data || {};
    x.thread = d.thread || x.thread;
    x.project = d.project || null;
    if (typeof d.text === "string" && d.text) { x.text = d.text; x.done = true; x.status = ""; }
    else x.status = d.ask ? `${x.agent} needs a permission answered first. Open the thread to answer it.`
      : d.note ? String(d.note) : `Sent to ${x.agent}. The answer shows here when it comes.`;
    x.sent = true;
    drawAnswer();
  }

  // Our message landing tells us the thread when agents.list did not.
  ctx.on("thread.sent", e => {
    const x = asking, p = e.payload || {};
    if (!x || x.sent || p.surface !== "deck" || p.text !== x.q) return;
    x.thread = e.thread || p.thread || x.thread;
    x.sent = true;
  });
  ctx.on("thread.text", e => {
    const x = asking, p = e.payload || {};
    if (!x || x.done || !x.sent || !x.thread || (e.thread || p.thread) !== x.thread || p.role === "user" || p.notice) return;
    if (p.message !== x.msg) { x.msg = p.message; x.text = ""; }
    if (p.delta) x.text += p.delta;
    if (p.done && p.text) x.text = p.text;
    x.status = "";
    drawAnswer();
  });

  // ---- a file, in a sheet ---------------------------------------------------------------
  function closeSheet() { sheet?.remove(); sheet = null; }
  ctx.cleanup(closeSheet);

  async function openFile(f) {
    closeSheet();
    const body = h("div", { class: "fd-sbody" });
    const meta = h("div", { class: "code fd-smeta" }, [f.source === "mac" ? "mac" : "box", f.path, size(f.size), when(f.mtime)].filter(Boolean).join(" · "));
    const panel = h("div", { class: "fd-sheet", role: "dialog", "aria-modal": "true", "aria-label": f.name, tabindex: "-1",
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); input.focus(); } } },
      h("div", { class: "fd-grip", "aria-hidden": "true" }),
      h("div", { class: "fd-shead" }, h("div", { class: "fd-stitle" }, f.name),
        h("button", { type: "button", class: "ibtn fd-x", "aria-label": "Close", onclick: () => { closeSheet(); input.focus(); } }, icon("close", 18))),
      meta, body);
    sheet = h("div", { class: "fd-back", onclick: (/** @type {MouseEvent} */ e) => { if (e.target === sheet) closeSheet(); } }, panel);
    document.body.append(sheet);
    panel.focus();
    if (!["text", "code", "image", "other"].includes(f.kind)) { put(body, h("div", { class: "small muted" }, "No preview for this kind of file.")); return; }
    put(body, h("div", { class: "small muted" }, "Opening…"));
    const mine = sheet;
    const r = await attempt("files.preview", { path: f.path, ...(f.source === "mac" || f.source === "box" ? { source: f.source } : {}) });
    if (!ctx.alive() || sheet !== mine) return;
    const d = r.data;
    if (r.error) put(body, empty("No preview.", r.error));
    else if (d?.kind === "image" && d.base64) put(body, h("img", { class: "fd-img", alt: f.name, src: `data:${d.mime || "image/png"};base64,${d.base64}` }));
    else if (typeof d?.text === "string") put(body, h("pre", { class: "fd-pre" }, d.text), d.truncated ? h("div", { class: "fd-note" }, "The start of the file only.") : null);
    else put(body, h("div", { class: "small muted" }, d?.note ? `No preview: ${d.note}.` : "No preview for this file."));
  }

  // ---- the phone: Lumen, opened (docs/design/phone.md section 7) ------------------------
  /** A card row: a button or a link, in the list's keyboard order. */
  function prow({ href, onclick, cls = "", label }, ...kids) {
    const props = { class: "fd-prow " + cls, "data-row": "", role: "option", "aria-selected": "false", ...(label ? { "aria-label": label } : {}) };
    return href ? link(href, props, kids) : h("button", { type: "button", ...props, onclick }, kids);
  }
  const chev = () => h("span", { class: "fd-chev", "aria-hidden": "true" }, icon("right", 16));
  const group = (label, ...kids) => h("section", { class: "fd-group", "aria-label": label }, h("h2", { class: "fd-gh" }, label), kids);
  const more = (key, n) => h("button", { type: "button", class: "fd-more", onclick: () => { expanded.add(key); draw(); } }, `Show all ${n}`);

  function phoneAsk(q) {
    const card = h("div", { class: "fd-card" },
      prow({ onclick: () => askNow(q), cls: "fd-askrow", label: `Ask ${who()}: ${q}` },
        h("span", { class: "fd-tile", "aria-hidden": "true" }, initial(assistant()?.name || "v")),
        h("span", { class: "fd-main" }, h("span", { class: "fd-rt" }, `Ask ${who()}`), h("span", { class: "fd-r2" }, asQuestion(q))),
        chev()));
    if (asking) card.append(answer);
    return card;
  }

  /**
   * What the grammar can do with the words, as plain-words rows with the command under each.
   * A parsed command comes first (one row per session it could mean); plain words offer the
   * sessions they name to watch, and an agent named first to ask.
   * @returns {{ act: string, line: string, pick?: any, cmd?: any, fill?: string }[]}
   */
  function runItems(q) {
    const c = cmd;
    const t = r => title(r);
    if (c.kind === "agent") return [{ act: `Ask ${c.agent}: ${c.text}`, line: `@${c.agent} ${c.text}` }];
    if (c.kind === "drive") return c.candidates.slice(0, 4).map(r => ({ act: `Tell ${t(r)} to ${c.text}`, line: `tell ${t(r)} to ${c.text}`, pick: r }));
    if (c.kind === "watch") return c.candidates.slice(0, 4).map(r => ({
      act: c.until === "asks" ? `Tell me when ${t(r)} asks` : c.until === "finished" ? `Tell me when ${t(r)} is done` : `Watch ${t(r)}`,
      line: c.until === "asks" ? `tell me when ${t(r)} asks` : c.until === "finished" ? `tell me when ${t(r)} is done` : `watch ${t(r)}`, pick: r }));
    const out = [];
    // "@ki" or "kit write the ad": the agents it could mean.
    const at = /^@(\S*)$/.exec(q);
    const first = /^(\S+)\s+([\s\S]+)$/.exec(q);
    if (at) for (const a of base_.agents.filter(a => a.name.toLowerCase().startsWith(at[1].toLowerCase())).slice(0, 3))
      out.push({ act: `Ask ${a.name}`, line: `@${a.name} …`, fill: `@${a.name} ` });
    else if (first) {
      const a = base_.agents.find(x => x.name.toLowerCase() === first[1].toLowerCase());
      if (a) out.push({ act: `Ask ${a.name}: ${first[2]}`, line: `@${a.name} ${first[2]}`, cmd: { kind: "agent", agent: a.name, text: first[2].trim() } });
    }
    if (q.length >= MIN) for (const r of rankSessions(q, base_.rows, title).slice(0, 2)) {
      out.push({ act: `Watch ${t(r)}`, line: `watch ${t(r)}`, pick: r, cmd: { kind: "watch", query: q, until: "either", candidates: [r] } });
      out.push({ act: `Tell me when ${t(r)} is done`, line: `tell me when ${t(r)} is done`, pick: r, cmd: { kind: "watch", query: q, until: "finished", candidates: [r] } });
    }
    return out.slice(0, 4);
  }

  function phoneRun(q) {
    const items = runItems(q);
    if (!items.length) {
      if (scope !== "run") return null;
      const a = base_.agents.find(x => x.kind !== "assistant")?.name || who();
      return h("p", { class: "fd-pnote" }, `No command matches. Try @${a} and a task, tell <session> to …, or watch <session>.`);
    }
    return group("Run", h("div", { class: "fd-card" }, items.map(it => prow({ cls: "fd-run", label: `${it.act}. Runs ${it.line}`, onclick: () => {
      if (it.fill) { input.value = it.fill; input.dispatchEvent(new Event("input")); input.focus(); return; }
      if (it.cmd) cmd = it.cmd;
      if (it.pick) chosen = it.pick;
      recentAdd(q);
      runCommand();
    } }, h("span", { class: "fd-glyph", "aria-hidden": "true" }, icon("terminal", 20)),
      h("span", { class: "fd-main" }, h("span", { class: "fd-rt" }, hl(it.act, q)), h("span", { class: "fd-cmd" }, it.line))))));
  }

  /** Ask Vyre Memory: one row, and its answer under it. Kept per question so a redraw does not lose it. @type {Map<string, any>} */
  const memAsked = new Map();
  function phoneMemoryAsk(q) {
    const st = memAsked.get(q);
    const row = prow({ cls: "fd-askrow", label: `Ask Vyre Memory: ${q}`, onclick: () => {
      if (st) return;
      memAsked.set(q, { busy: true });
      drawPhone();
      askMemory(attempt, q).then(r => { memAsked.set(q, r); if (cur.q === q) drawPhone(); });
    } }, h("span", { class: "fd-glyph", "aria-hidden": "true" }, icon("memory", 20)),
      h("span", { class: "fd-main" }, h("span", { class: "fd-rt" }, "Ask Vyre Memory"), h("span", { class: "fd-r2" }, asQuestion(q))), chev());
    const card = h("div", { class: "fd-card" }, row);
    if (st?.busy) card.append(h("p", { class: "fd-pnote", role: "status" }, "Thinking..."));
    else if (st?.error) card.append(h("p", { class: "fd-pnote", role: "status" }, st.error));
    else if (st) card.append(h("div", { class: "fd-pnote", role: "status" }, h("p", null, st.text), st.note ? h("p", { class: "muted" }, st.note) : null,
      st.sources.length ? h("p", { class: "small muted" }, "From " + st.sources.join(", ")) : null));
    return card;
  }

  function phoneMemory(q) {
    const facts = (Array.isArray(cur.memory?.data) ? cur.memory.data : []).filter(f => f && f.text);
    if (!facts.length) return null;
    return h("section", { class: "fd-pmem", "aria-label": "From memory" },
      h("div", { class: "fd-pmem-h" }, icon("memory", 14), "From memory"),
      facts.slice(0, 3).map(f => link(`/memory?q=${encodeURIComponent(q)}`, { class: "fd-pfact", "data-row": "", role: "option", "aria-selected": "false" },
        h("span", { class: "fd-pfact-t" }, hl(f.text, q)),
        h("span", { class: "fd-pfact-s" }, [f.ref?.name || f.source, when(f.at || f.ts || f.updated || f.created)].filter(Boolean).join(" · ")))));
  }

  function phoneChats(q) {
    const hits = sessionHits(q);
    if (!hits.length) return null;
    const open = expanded.has("sessions");
    return group("Chats", h("div", { class: "fd-card" }, (open ? hits : hits.slice(0, SHOW)).map(s =>
      prow({ href: threadHref({ id: s.id, project: s.project }) },
        h("span", { class: "fd-main" }, h("span", { class: "fd-rt" }, hl(s.title, q)),
          s.snip ? h("span", { class: "fd-r2" }, snippet(s.snip)) : null,
          h("span", { class: "fd-meta" }, [projectOf(s), when(s.ts)].filter(Boolean).join(" · "))),
        chev()))),
      hits.length > SHOW && !open ? more("sessions", hits.length) : null);
  }

  function phoneFiles() {
    const d = cur.files?.data;
    if (!d) return null;
    const results = Array.isArray(d.results) ? d.results : [];
    // One line when the Macs are away: their files are the ones missing.
    const away = !results.some(f => f.source === "mac")
      ? h("p", { class: "fd-pnote" }, "Your Macs are away. Files on them show here when they are back.") : null;
    if (!results.length) return scope === "files" || away ? away : null;
    const open = expanded.has("files");
    return group("Files", h("div", { class: "fd-card" }, (open ? results : results.slice(0, SHOW)).map(f =>
      prow({ onclick: () => openFile(f), label: `${f.name}, ${home(f.path)}` },
        h("span", { class: "fd-glyph", "aria-hidden": "true" }, icon(FILE_ICON[f.kind] || "file", 20)),
        h("span", { class: "fd-main" }, h("span", { class: "fd-path" }, home(f.path) || f.name),
          h("span", { class: "fd-meta" }, [f.repo || base(parent(f.path)), f.machine || f.host || (f.source === "mac" ? "Mac" : "box")].filter(Boolean).join(" · ")))))),
      results.length > SHOW && !open ? more("files", results.length) : null, away);
  }

  function drawPhone() {
    const q = cur.q;
    if (!q) return drawPhoneIdle();
    const long = q.length >= MIN;
    const all = scope === "all";
    const blocks = [
      all ? phoneAsk(q) : null,
      all || scope === "run" ? phoneRun(q) : null,
      long && (all || scope === "memory") ? phoneMemory(q) : null,
      long && (scope === "memory" || (all && looksLikeQuestion(q))) ? phoneMemoryAsk(q) : null,
      long && (all || scope === "chats") ? phoneChats(q) : null,
      long && (all || scope === "files") ? phoneFiles() : null,
    ].filter(Boolean);
    const missing = new Map();
    for (const [label, r, sc] of [["Chats were not searched.", cur.recall, "chats"], ["Files were not searched.", cur.files, "files"], ["Memory was not searched.", cur.memory, "memory"]]) {
      if ((all || scope === sc) && r?.error && !missing.has(r.error.module)) missing.set(r.error.module, empty(label, r.error));
    }
    const wanted = all ? [cur.recall, cur.files, cur.memory] : scope === "chats" ? [cur.recall] : scope === "files" ? [cur.files] : scope === "memory" ? [cur.memory] : [];
    const pending = long && wanted.some(r => !r);
    const nothing = !blocks.length && !pending && !missing.size
      ? h("p", { class: "fd-pnote" }, long ? `Nothing in ${SCOPES.find(([k]) => k === scope)?.[1] || "here"} matches.` : "Keep typing to search.") : null;
    put(list, blocks, pending ? h("p", { class: "fd-pnote" }, "Looking…") : null, nothing, [...missing.values()]);
    mark();
  }

  function drawPhoneIdle() {
    const recent = recentGet();
    const sessions = base_.rows.filter(r => r.human || r.live).slice(0, 4);
    put(list,
      recent.length ? group("Recent searches", h("div", { class: "fd-card" }, recent.map(q => h("button", { type: "button", class: "fd-prow fd-recent", "data-row": "", "data-recent": "",
        role: "option", "aria-selected": "false", onclick: () => { input.value = q; input.dispatchEvent(new Event("input")); input.focus(); } },
        h("span", { class: "fd-glyph", "aria-hidden": "true" }, icon("search", 20)), h("span", { class: "fd-main" }, h("span", { class: "fd-r1" }, q)))))) : null,
      sessions.length ? group("Recent", h("div", { class: "fd-card" }, sessions.map(r => prow({ href: threadHref(r) },
        h("span", { class: "fd-main" }, h("span", { class: "fd-rt" }, title(r)),
          h("span", { class: "fd-meta" }, [projectOf(r), when(r.last)].filter(Boolean).join(" · "))),
        chev())))) : null,
      !base_.loaded ? h("p", { class: "fd-pnote" }, "Reading your sessions…") : null,
      base_.loaded ? base_.errs.map(([label, err]) => empty(label, err)) : null);
    mark();
  }

  // ---- drawing --------------------------------------------------------------------------
  function drawIdle() {
    if (phone) return drawPhoneIdle();
    const recent = base_.rows.filter(r => r.human || r.live).slice(0, SHOW);
    put(list,
      recent.length ? section("recent", "Recent", recent.map(r => row({ href: threadHref(r), glyph: icon("chat", 16) },
        [titled(title(r), r), line([r.project ? base_.names.get(r.project) || r.project : base(r.cwd), when(r.last)].filter(Boolean).join(" · "), "fd-sub")]))) : null,
      base_.agents.length ? h("section", { class: "fd-sec", "aria-label": "Agents" }, h("h2", { class: "lbl" }, "Agents"),
        h("div", { class: "fd-chips" }, base_.agents.map(a => link(`/agents/${encodeURIComponent(a.name)}`, { class: "fd-chip", "data-row": "", role: "option" }, `@${a.name}`)))) : null,
      !base_.loaded ? h("div", { class: "fd-note" }, "Reading your sessions…") : null,
      base_.loaded ? base_.errs.map(([label, err]) => empty(label, err)) : null,
      h("p", { class: "fd-hint" }, "Pull down anywhere to come back here."));
    mark();
  }

  function draw() {
    if (phone) return drawPhone();
    const q = cur.q;
    if (!q) return drawIdle();
    const long = q.length >= MIN;
    const ask = section("ask", "Ask", [row({ onclick: () => askNow(q), glyph: icon("ask", 16), cls: "fd-ask" },
      [h("span", { class: "fd-title" }, `Ask ${who()}: `, h("span", { class: "fd-q" }, q))])]);
    if (asking) ask.append(answer);
    const sessions = long ? sessionRows(q) : [];
    const agents = long ? agentRows(q) : [];
    const memory = long ? memoryRows(q) : [];
    const projects = long ? projectRows(q) : [];
    // A module that is not there says so once, faintly, at the end.
    const missing = new Map();
    for (const [label, r] of [["Sessions were not searched.", cur.recall], ["Files were not searched.", cur.files], ["Memory was not searched.", cur.memory]]) {
      if (r?.error && !missing.has(r.error.module)) missing.set(r.error.module, empty(label, r.error));
    }
    const pending = long && [cur.recall, cur.files, cur.memory].some(r => !r);
    const cmdRows = commandSection();
    put(list, cmdRows || ask,
      sessions.length ? section("sessions", "Sessions", sessions) : null,
      long ? fileSection() : null,
      agents.length ? section("agents", "Agents", agents) : null,
      memory.length ? section("memory", "From memory", memory, { cls: "fd-mem recalled", lblCls: "recall" }) : null,
      projects.length ? section("projects", "Projects", projects) : null,
      pending ? h("div", { class: "fd-note" }, "Looking…") : null,
      [...missing.values()]);
    mark();
  }

  // ---- searching ------------------------------------------------------------------------
  function run(q) {
    const n = ++seq;
    clear.hidden = !input.value;
    if (q !== cur.q) { expanded.clear(); hi = -1; }
    cur = { q, n };
    draw();
    if (q.length < MIN) return;
    const got = key => r => { if (!ctx.alive() || n !== seq) return; /** @type {any} */ (cur)[key] = r; draw(); };
    attempt("recall.search", { q, limit: 20 }).then(got("recall"));
    attempt("files.search", { q, limit: 20 }).then(got("files"));
    attempt("memory.relevant", { text: q, limit: 5 }).then(got("memory"));
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    done_ = "";
    clear.hidden = !input.value;
    readCommand(input.value);
    const q = input.value.trim();
    if (!q) { run(""); return; }
    timer = window.setTimeout(() => run(input.value.trim()), DEBOUNCE_MS);
  });
  ctx.cleanup(() => clearTimeout(timer));
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = rowsNow();
      if (!items.length) return;
      e.preventDefault();
      hi = e.key === "ArrowDown" ? Math.min(items.length - 1, hi + 1) : Math.max(-1, hi - 1);
      mark();
    } else if (e.key === "Escape" && (input.value || asking)) {
      e.preventDefault();
      clearTimeout(timer);
      input.value = "";
      asking = null;
      drawAnswer();
      run("");
    }
  });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const items = rowsNow();
    if (hi >= 0 && items[hi]) { items[hi].click(); return; }
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return;
    if (q.length >= MIN) recentAdd(q);
    if (q !== cur.q) run(q);
    readCommand(q);
    if (cmd.kind !== "ask") { runCommand(); return; }
    askNow(q);
  });

  // ---- start ----------------------------------------------------------------------------
  const pre = (ctx.query.get("q") || "").trim();
  if (pre) { input.value = pre; run(pre); } else draw();

  const [al, cat, th, pl] = await Promise.all([attempt("agents.list"), attempt("projects.catalog", { limit: 300 }),
    attempt("threads.list", { all: true }), attempt("projects.list")]);
  if (!ctx.alive()) return;
  const agents = Array.isArray(al.data) ? al.data : al.data?.agents || [];
  base_.agents = [...agents].sort((a, b) => (a.kind === "assistant" ? 0 : 1) - (b.kind === "assistant" ? 0 : 1));
  base_.rows = mergeSessions(cat.data?.sessions || [], Array.isArray(th.data) ? th.data : th.data?.threads || []);
  base_.projects = pl.data?.projects || [];
  base_.names = new Map(base_.projects.map(p => [p.slug, p.name || p.slug]));
  // The Switchboard missing is normal on a machine that never ran a headless thread; say so only
  // for the catalogue and the agents, the lists this screen leans on.
  base_.errs = [["Recent sessions are not available.", cat.error], ["Agents are not available.", al.error]].filter(([, e]) => e);
  base_.loaded = true;
  placeholder();
  readCommand(input.value);
  draw();
}
