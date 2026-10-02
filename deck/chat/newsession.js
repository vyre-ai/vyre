// @ts-check
// The New session sheet (ADR 0024, contract 5), at /chat?new[&cwd=][&project=]. Three choices
// and a first message:
//   Where: a project (projects.list), a folder (files.recent, or "Browse..." into the folder
//          browser in pick mode), or no folder. threads.start needs a folder, so "No folder"
//          starts in the first of the box's roots, and says which.
//   Who:   the assistant (its name from onboarding, lib/names.js; "Vyre" when none), a plain session (threads.start), or one of the agents (agents.ask with
//          wait: false, then that agent's thread opens). An agent works where its own projects
//          are, so the folder choice is switched off for one, with a note that says why.
//   What:  the first message. Cmd/Ctrl+Enter starts; Esc closes the sheet.
// On success the new thread opens; a failure is shown as the box said it.

import { kbd } from "../js/platform.js";
import { pasteTracker, NOT_TYPED } from "./core/paste-spans.js";
import { tagPicker } from "./tag-picker.js";
import { listMenu } from "./pickers.js";
import { h, put, go } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { threadHref } from "./lib/routes.js";
import { readNames, labelFor } from "./lib/names.js";

/** How long the sheet waits before saying it is still starting, and before it gives up waiting for an answer (the server is never abandoned: it may still start). */
export const START_SLOW_MS = 8000;
export const START_GIVE_UP_MS = 45000;
/** What the sheet says when threads.start answers "busy", with Try again next to it. */
export const BUSY_NOTE = "All sessions are busy; one will free up shortly.";

/** The last segment of a path, for a short label. @param {string} p */
export const baseName = p => String(p).replace(/\/+$/, "").split("/").pop() || p;

/**
 * What to call, for a choice of where and who. Pure, so it is tested on its own.
 * @param {{ kind: "project", slug: string } | { kind: "folder", path: string } | { kind: "none" }} where
 * @param {string|null} agent null for a plain session ("Vyre")
 * @param {string} text the first message
 * @param {string|null} fallback the folder "No folder" starts in (the first root)
 * @param {string[]} [pasted] the stretches of the first message the person pasted: a #Name inside one never tags
 * @param {{ kind: string, id: string, name: string }[]} [mentions] the # tags picked in the first message
 * @returns {{ tool: string, input: Record<string, any> } | { error: string }}
 */
export function startCall(where, agent, text, fallback, pasted = [], mentions = []) {
  const prompt = String(text || "").trim();
  if (agent) {
    if (!prompt) return { error: `Write the first message for ${agent}.` };
    const held = [...new Set(pasted.map(x => String(x).trim()).filter(x => x && prompt.includes(x)))];
    return { tool: "agents.ask", input: { agent, text: prompt, surface: "deck", wait: false, ...(held.length ? { pasted: held } : {}), ...(mentions.length ? { mentions } : {}) } };
  }
  const input = /** @type {Record<string, any>} */ ({ surface: "deck" });
  if (prompt) input.prompt = prompt;
  const spans = [...new Set(pasted.map(x => String(x).trim()).filter(x => x && prompt.includes(x)))];
  if (spans.length) input.pasted = spans;
  if (mentions.length) input.mentions = mentions;
  if (where.kind === "project") input.project = where.slug;
  else if (where.kind === "folder") input.cwd = where.path;
  else if (fallback) input.cwd = fallback;
  else return { error: "There is no folder to start in: the server has no folders set up for files." };
  return { tool: "threads.start", input };
}

/**
 * Where a started session opens. threads.start returns the thread; agents.ask returns { thread }.
 * @param {any} data @param {string|null} project
 */
export function openHref(data, project) {
  const id = data && (data.thread || data.id);
  if (!id) return null;
  return threadHref({ id: String(id), project: (data.project ?? project) || null });
}

/**
 * @param {HTMLElement} container
 * @param {{ cwd?: string|null, project?: string|null, onDone: () => void, onBrowse?: () => void, shown?: () => boolean }} opts
 *   onDone: close the sheet (Esc, Cancel). onBrowse: open the folder browser to pick a folder.
 *   shown: whether the sheet is on screen; the shell keeps pages mounted while hidden, and a
 *   hidden sheet must not close on an Esc meant for another page.
 * @returns {() => void} cleanup
 */
export function mountNewSession(container, opts) {
  let alive = true;
  const state = {
    /** @type {{ kind: "project", slug: string } | { kind: "folder", path: string } | { kind: "none" }} */
    where: opts.project ? { kind: "project", slug: opts.project } : opts.cwd ? { kind: "folder", path: opts.cwd } : { kind: "none" },
    /** @type {string|null} */ agent: null,
    /** @type {any[]} */ projects: [], /** @type {any[]} */ recent: [], /** @type {any[]} */ agents: [],
    /** @type {string|null} */ root: null,
    /** The assistant's name, for the plain-session choice. */ assistant: "Vyre",
    loaded: false, starting: false, /** @type {string|null} */ error: null,
  };

  const pastes = pasteTracker();
  let prevText = "", pendingPaste = false;
  const menu = listMenu("Tags");
  const chipsBox = h("div", { class: "ns-tags" });
  const caretAt = () => (typeof text.selectionStart === "number" ? text.selectionStart : text.value.length);
  /** Words put in by the picker (a pick, a chip's x): tracked like an edit that was not typing, and the chips redrawn. */
  function setText(/** @type {string} */ v, at = v.length) {
    text.value = v; try { text.setSelectionRange?.(at, at); } catch { /* no caret to set */ }
    pastes.edit(prevText, v, false); prevText = v; drawTags();
  }
  const drawTags = () => put(chipsBox, tagUI.chipsEl("ns-tags-row"));
  const text = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input ns-text", id: "ns-text", rows: 4, placeholder: "What should this session start with?", "aria-label": "First message",
    onpaste: () => { pendingPaste = true; setTimeout(() => { pendingPaste = false; }, 0); },
    oninput: (/** @type {any} */ e) => {
      const v = text.value; pastes.edit(prevText, v, pendingPaste || !e?.inputType || NOT_TYPED.has(e.inputType)); prevText = v; pendingPaste = false;
      if (!tagUI.suggest() && menu.kind === "vault") menu.close();
      drawTags();
    },
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (menu.isOpen()) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); menu.move(e.key === "ArrowDown" ? 1 : -1); return; }
        if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey && menu.pick()) { e.preventDefault(); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); menu.close(); return; }
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); }
    } }));
  const tagUI = tagPicker({ ta: text, menu, caret: () => caretAt(), setValue: (v, at) => setText(v, at), attempt });
  const whereBox = h("div", { class: "ns-where" });
  const whoBox = h("div", { class: "ns-who" });
  const note = h("div", { class: "ns-error", role: "alert" });
  const startBtn = h("button", { class: "btn btn-primary", type: "button", onclick: () => start() }, "Start session");

  put(container, h("div", { class: "ns-sheet", role: "dialog", "aria-modal": "false", "aria-labelledby": "ns-title" },
    h("div", { class: "chat-head" },
      h("h1", { class: "chat-title", id: "ns-title" }, "New session"),
      h("button", { class: "ibtn", type: "button", "aria-label": "Close", title: "Close (Esc)", onclick: () => opts.onDone() }, icon("close", 16))),
    h("section", { class: "ns-section", "aria-labelledby": "ns-who-h" }, h("h2", { class: "lbl", id: "ns-who-h" }, "Who"), whoBox),
    h("section", { class: "ns-section", "aria-labelledby": "ns-where-h" }, h("h2", { class: "lbl", id: "ns-where-h" }, "Where"), whereBox),
    h("section", { class: "ns-section" }, h("label", { class: "lbl", for: "ns-text" }, "First message"), h("div", { class: "ns-textwrap" }, menu.el, text), chipsBox),
    note,
    h("div", { class: "ns-actions" },
      startBtn,
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => opts.onDone() }, "Cancel"),
      h("span", { class: "ns-hint faint" }, h("span", { class: "kbd" }, kbd("Enter")), " to start, ", h("span", { class: "kbd" }, "Esc"), " to close"))));
  text.setAttribute("id", "ns-text");

  const shown = opts.shown || (() => true);
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape" && !e.defaultPrevented && shown()) { e.preventDefault(); opts.onDone(); } };
  document.addEventListener("keydown", onKey);

  draw();
  load();

  async function load() {
    const [p, r, a, d, nm, now] = await Promise.all([attempt("projects.list"), attempt("files.recent", { limit: 8 }), attempt("agents.list"), attempt("files.dirs", {}), readNames(attempt),
      // What the person is working on now, merged across surfaces (cohesion's context.now {}, not chat's own
      // last report, which is the thread just left): a new session defaults to its project.
      // An older box without it answers no_such_tool, and the sheet opens on "none" as before.
      attempt("context.now", {})]);
    if (!alive) return;
    const nowProject = typeof now?.data?.project === "string" && now.data.project ? now.data.project : null;
    if (state.where.kind === "none" && nowProject && (p.data?.projects || []).some(x => x.slug === nowProject)) state.where = { kind: "project", slug: nowProject };
    state.assistant = labelFor({ role: "assistant" }, nm);
    state.projects = p.data?.projects || [];
    state.recent = Array.isArray(r.data) ? r.data : [];
    state.agents = Array.isArray(a.data) ? a.data : [];
    state.root = d.data?.roots?.[0]?.path || null;
    state.loaded = true;
    draw();
    text.focus();
  }

  /** One radio-like choice row. */
  function choice(label, sub, selected, onpick, disabled = false) {
    return h("button", { class: "ns-choice", type: "button", role: "radio", "aria-checked": String(selected), disabled,
      onclick: () => { onpick(); draw(); } },
      h("span", { class: "ns-radio", "aria-hidden": "true" }),
      h("span", { class: "ns-choice-text" }, h("span", { class: "ns-choice-label ellipsis" }, label), sub ? h("span", { class: "ns-choice-sub code faint ellipsis" }, sub) : null));
  }

  function draw() {
    if (!alive) return;
    const w = state.where;
    put(whoBox, h("div", { class: "ns-choices", role: "radiogroup", "aria-label": "Who" },
      choice(state.assistant, "a session in the folder you pick", state.agent === null, () => { state.agent = null; }),
      state.agents.map(a => choice(a.name, a.kind === "assistant" ? "your assistant, in its own thread" : "an agent, in its own thread",
        state.agent === a.name, () => { state.agent = a.name; }))));

    const off = state.agent !== null;
    const recent = state.recent.filter(f => !(w.kind === "folder" && f.path === w.path));
    const noFolder = state.root ? `No folder (starts in ${state.root})` : "No folder";
    put(whereBox,
      off ? h("div", { class: "ns-note faint" }, `${state.agent} works in its own thread and its own projects, so the folder does not apply.`) : null,
      h("div", { class: "ns-choices", role: "radiogroup", "aria-label": "Where", "aria-disabled": off ? "true" : null },
        state.projects.length ? h("div", { class: "lbl ns-sub" }, "Projects") : null,
        state.projects.map(p => choice(p.name, p.home || null, w.kind === "project" && w.slug === p.slug, () => { state.where = { kind: "project", slug: p.slug }; }, off)),
        h("div", { class: "lbl ns-sub" }, "Folders"),
        w.kind === "folder" ? choice(baseName(w.path), w.path, true, () => {}, off) : null,
        recent.map(f => choice(baseName(f.path), f.path, false, () => { state.where = { kind: "folder", path: f.path }; }, off)),
        h("button", { class: "btn btn-ghost btn-sm ns-browse", type: "button", disabled: off,
          onclick: () => (opts.onBrowse ? opts.onBrowse() : go("/chat?folders&pick")) }, icon("projects", 14), "Browse..."),
        choice(noFolder, null, w.kind === "none", () => { state.where = { kind: "none" }; }, off)),
      !state.loaded ? h("div", { class: "empty" }, "Reading projects and folders...") : null);

    put(note, state.error || "", state.error === BUSY_NOTE
      ? [" ", h("button", { class: "btn btn-ghost btn-sm ns-retry", type: "button", disabled: state.starting, onclick: () => start() }, "Try again")] : null);
    note.hidden = !state.error;
    startBtn.disabled = state.starting;
    put(startBtn, state.starting ? "Starting..." : state.agent ? `Ask ${state.agent}` : "Start session");
  }

  async function start() {
    if (state.starting) return;
    const c = startCall(state.where, state.agent, text.value, state.root, pastes.of(text.value), tagUI.chips().map(t => ({ kind: t.kind, id: t.id, name: t.name })));
    if ("error" in c) { state.error = c.error; draw(); return; }
    state.starting = true; state.error = null; draw();
    // Never "Starting..." forever (#42): a quiet line after a few seconds, and an answer in words if the server never replies. The session may still
    // have started in that case, so the words say where to look.
    const slow = setTimeout(() => { if (alive && state.starting) { state.error = "Still starting. A new project can take a moment."; draw(); } }, START_SLOW_MS);
    let giveUp = /** @type {any} */ (null);
    const gave = new Promise(res => { giveUp = setTimeout(() => res({ error: { code: "timeout", message: "the server did not answer in time. The session may still have started: check the list in Chat." } }), START_GIVE_UP_MS); });
    const r = await Promise.race([attempt(c.tool, c.input), gave]);
    clearTimeout(slow); clearTimeout(giveUp);
    if (!alive) return;
    state.starting = false;
    // Every session slot in use (threads.start code "busy"): not a failure, so say when to try again.
    if (r.error && r.error.code === "busy") { state.error = BUSY_NOTE; draw(); return; }
    if (r.error) { state.error = `Could not start: ${r.error.message || r.error.code}`; draw(); return; }
    if (r.data && r.data.ok === false) { state.error = r.data.note || "The agent did not take the message."; draw(); return; }
    const href = openHref(r.data, state.where.kind === "project" && !state.agent ? state.where.slug : null);
    if (!href) { state.error = "The session started, but the server did not say which thread it is."; draw(); return; }
    // The shell keeps this page; coming back to it later starts a fresh message, not this one again.
    text.value = ""; tagUI.clear(); pastes.reset(); prevText = "";
    drawTags();
    draw();
    go(href);
  }

  return () => { alive = false; document.removeEventListener("keydown", onKey); };
}
