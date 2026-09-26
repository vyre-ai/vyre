// @ts-check
// Find: the phone's Capsule. One box at the top; as you type, what matches comes in below in a
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
// Commands (js/commands.js, the grammar the Mac Capsule and the native apps share): "@kit ..."
// asks that agent (agents.ask, wait: false, then its thread opens); "tell <session> to ..." types
// into a session (threads.send) and watches it; "watch <session>" and "tell me when <session> is
// done" watch it (threads.watch, notify: "deck"). A line under the box says what Enter will do,
// and the matching sessions are listed so a tap picks another one.

import { h, put, link, empty, go } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when, base } from "../js/fmt.js";
import { mergeSessions, title } from "../chat/lib/sessions.js";
import { threadHref, projectHref } from "../chat/lib/routes.js";
import { parseCommand, plan } from "../js/commands.js";

const SHOW = 5;
const MIN = 2;
const DEBOUNCE_MS = 180;
const FILE_ICON = { folder: "projects", code: "terminal", text: "lines" };

const why = err => err?.missing
  ? (err.module === "switchboard" ? "The switchboard module is not running, so the assistant cannot answer here yet." : `The ${err.module} module is not running on this machine.`)
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

/** A recall snippet, its «» marks as highlighted spans. Text only, never markup. */
function snippet(s) {
  return String(s || "").split(/[«»]/).map((part, i) => i % 2 ? h("mark", { class: "fd-m" }, part) : part);
}

/** @param {any} ctx */
export default async function find(ctx) {
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "fd-in", class: "fd-in", type: "search", enterkeyhint: "search",
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Find or ask", "aria-label": "Find or ask",
    role: "combobox", "aria-controls": "fd-list", "aria-expanded": "true", "aria-autocomplete": "list" }));
  const form = h("form", { class: "fd-form", role: "search" }, h("span", { class: "fd-glass", "aria-hidden": "true" }, icon("search", 18)), input);
  const list = h("div", { id: "fd-list", class: "fd-list", role: "listbox", "aria-label": "Results" });
  const answer = h("section", { class: "fd-answer", "aria-live": "polite", hidden: true });
  const planLine = h("div", { class: "fd-plan small", role: "status" });
  put(ctx.root, h("div", { class: "fd" }, h("div", { class: "fd-bar" }, form, planLine), list));
  input.focus();

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
  function sessionRows(q) {
    const ws = words(q), byId = new Map(base_.rows.map(r => [r.id, r])), seen = new Set(), out = [];
    const add = s => { seen.add(s.id); out.push(s); };
    for (const r of base_.rows) if (r.name && hasAll(r.name, ws)) add({ id: r.id, title: title(r), snip: "", project: r.project, cwd: r.cwd, ts: r.last });
    for (const x of Array.isArray(cur.recall?.data) ? cur.recall.data : []) {
      if (!x?.session || seen.has(x.session)) continue;
      const r = byId.get(x.session);
      add({ id: x.session, title: r ? title(r) : x.name || x.title || String(x.session).slice(0, 8), snip: x.snippet, project: r?.project || null, cwd: r?.cwd || x.cwd, ts: x.ts || r?.last });
    }
    return out.map(s => row({ href: threadHref({ id: s.id, project: s.project }), glyph: icon("chat", 16) },
      [line(s.title), s.snip ? h("span", { class: "fd-snip" }, snippet(s.snip)) : null,
        line([s.project ? base_.names.get(s.project) || s.project : base(s.cwd), when(s.ts)].filter(Boolean).join(" · "), "fd-sub")]));
  }

  function fileSection() {
    const d = cur.files?.data;
    if (!d) return null;
    const results = Array.isArray(d.results) ? d.results : [];
    const notes = (Array.isArray(d.sources) ? d.sources : []).filter(s => s && s.ok === false)
      .map(s => `The ${s.source === "mac" ? "Mac" : s.source || "other machine"} did not answer${s.error ? ": " + s.error : "."}`);
    if (!results.some(f => f.source === "mac")) notes.push("Files on your Mac show here when your Mac is online.");
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
      [line(title(r)), line([r.project ? base_.names.get(r.project) || r.project : base(r.cwd), when(r.last)].filter(Boolean).join(" · "), "fd-sub")])));
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
      const r = await attempt("threads.send", { thread: s.id, text: c.text, surface: "deck" });
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

  // ---- drawing --------------------------------------------------------------------------
  function drawIdle() {
    const recent = base_.rows.filter(r => r.human || r.live).slice(0, SHOW);
    put(list,
      recent.length ? section("recent", "Recent", recent.map(r => row({ href: threadHref(r), glyph: icon("chat", 16) },
        [line(title(r)), line([r.project ? base_.names.get(r.project) || r.project : base(r.cwd), when(r.last)].filter(Boolean).join(" · "), "fd-sub")]))) : null,
      base_.agents.length ? h("section", { class: "fd-sec", "aria-label": "Agents" }, h("h2", { class: "lbl" }, "Agents"),
        h("div", { class: "fd-chips" }, base_.agents.map(a => link(`/agents/${encodeURIComponent(a.name)}`, { class: "fd-chip", "data-row": "", role: "option" }, `@${a.name}`)))) : null,
      !base_.loaded ? h("div", { class: "fd-note" }, "Reading your sessions…") : null,
      base_.loaded ? base_.errs.map(([label, err]) => empty(label, err)) : null,
      h("p", { class: "fd-hint" }, "Pull down anywhere to come back here."));
    mark();
  }

  function draw() {
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
  readCommand(input.value);
  draw();
}
