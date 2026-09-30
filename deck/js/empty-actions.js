// @ts-check
// The one action an empty state offers, right where the empty state is. "No projects yet" gets a
// Create project button that opens a name field in its place, not a pointer to somewhere else.
//
// Each tool call here is the same one the owning view makes: createProject is what the Projects
// view's New project form sends, startThread what its New thread box sends, indexHistory what
// Settings' Re-index now sends. Those views call these functions too, so there is one of each.
//
// Styles: .ea in css/deck.css (44px targets under 720px).

import { h, put, go } from "./dom.js";
import { attempt } from "./api.js";

const enc = encodeURIComponent;

/**
 * projects.create. → { slug, name } or { error } in plain words.
 * @param {{ name: string, home?: string, people?: any[], from_thread?: string }} input from_thread: the chat it is made from (its tile carries over)
 */
export async function createProject(input) {
  const r = await attempt("projects.create", input);
  if (r.error) return { error: r.error.missing ? `The ${r.error.module} module is not running, so a project cannot be made here.` : String(r.error.message) };
  window.dispatchEvent(new Event("deck:pins"));
  return { slug: r.data?.slug || r.data?.project?.slug || null, name: r.data?.name || r.data?.project?.name || input.name };
}

/**
 * threads.start in a project's folder. → { id } or { error } in plain words.
 * @param {{ slug: string, home?: string }} p
 * @param {string} [prompt]
 */
export async function startThread(p, prompt) {
  const input = { project: p.slug, cwd: p.home };
  if (prompt) input.prompt = prompt;
  const r = await attempt("threads.start", input);
  if (r.error) return { error: r.error.missing ? "The switchboard module is not running, so a thread cannot start here." : String(r.error.message) };
  const id = r.data?.id || r.data?.thread?.id || r.data?.thread;
  return { id: typeof id === "string" ? id : null };
}

/** A button that swaps itself for a small form, and back on Cancel or Esc. */
function inline(label, primary, drawForm) {
  const box = h("div", { class: "ea" });
  const closed = (focus = false) => {
    const btn = h("button", { type: "button", class: "btn btn-sm" + (primary ? " btn-primary" : ""), onclick: () => drawForm(box, closed) }, label);
    put(box, btn);
    if (focus) btn.focus();
  };
  box.addEventListener("keydown", e => { if (/** @type {KeyboardEvent} */ (e).key === "Escape" && box.querySelector("form")) closed(true); });
  closed();
  return box;
}

/**
 * Create project, in place: a name field and Create. With no onCreated it opens the new board.
 * @param {{ onCreated?: (slug: string, name: string) => void, primary?: boolean }} [o]
 */
export function createProjectInline(o = {}) {
  return inline("Create project", o.primary !== false, (box, closed) => {
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input ea-in", "aria-label": "Project name", autocomplete: "off", placeholder: "Your project's name" }));
    const status = h("span", { class: "small muted", role: "status" });
    const ok = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Create"));
    put(box, h("form", { class: "ea-form", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      e.stopPropagation(); // it may sit inside another form (New agent), which must not submit too
      if (!name.value.trim()) { put(status, "A project needs a name."); name.focus(); return; }
      ok.disabled = true;
      put(status, "Making the project…");
      const r = await createProject({ name: name.value.trim() });
      ok.disabled = false;
      if (r.error) { put(status, r.error); return; }
      if (o.onCreated) { o.onCreated(r.slug || "", r.name); return; }
      if (r.slug) go(`/projects/${enc(r.slug)}`); else put(status, "Made. It shows under Projects.");
    } }, name, ok, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => closed(true) }, "Cancel"), status));
    name.focus();
  });
}

/**
 * Start a thread, in place: what it should do (optional) and Start. Opens the thread once it runs.
 * @param {{ slug: string, home?: string }} p
 */
export function startThreadInline(p) {
  return inline("Start a thread", true, (box, closed) => {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input ea-in ea-wide", rows: "3", "aria-label": "What should the new thread do?", placeholder: "What should it do? You can leave this empty." }));
    const status = h("span", { class: "small muted", role: "status" });
    const ok = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Start"));
    put(box, h("form", { class: "ea-form", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      e.stopPropagation(); // it may sit inside another form (New agent), which must not submit too
      ok.disabled = true;
      put(status, "Starting…");
      const r = await startThread(p, ta.value.trim());
      ok.disabled = false;
      if (r.error) { put(status, r.error); return; }
      if (r.id) go(`/projects/${enc(p.slug)}/${enc(r.id)}`); else put(status, "Started. It shows in the list shortly.");
    } }, ta, ok, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => closed(true) }, "Cancel"), status));
    ta.focus();
  });
}

/**
 * recall.index. → null, or the problem in plain words.
 */
export async function indexHistory() {
  const r = await attempt("recall.index");
  if (!r.error) return null;
  return r.error.missing ? `The ${r.error.module} module is not running, so history cannot be read here.` : String(r.error.message || r.error);
}

/**
 * Index your history, in place: one button and what happened. Memory learns from what it reads.
 * It asks recall.status first, as Settings does: no history module, no button.
 */
export function indexHistoryInline() {
  const box = h("div", { class: "ea ea-row" });
  const status = h("span", { class: "small muted", role: "status" });
  const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: async () => {
    btn.disabled = true;
    put(btn, "Indexing");
    const err = await indexHistory();
    if (err) { put(status, err); btn.disabled = false; put(btn, "Index your history"); return; }
    put(btn, "Indexed");
    put(status, "Memory learns from what was read. New facts show here as they come in.");
  } }, "Index your history"));
  attempt("recall.status").then(r => {
    if (r.error?.missing) { put(box, h("span", { class: "small faint" }, `The ${r.error.module} module is not running, so history cannot be read here.`)); return; }
    if (r.data?.indexing) { btn.disabled = true; put(btn, "Indexing"); }
    put(box, btn, status);
  });
  return box;
}

/** Any other single action, wrapped so it sits and sizes like the rest. */
export function action(label, onclick, primary = true) {
  return h("div", { class: "ea" }, h("button", { type: "button", class: "btn btn-sm" + (primary ? " btn-primary" : ""), onclick }, label));
}
