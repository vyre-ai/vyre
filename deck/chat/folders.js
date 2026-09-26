// @ts-check
// The folder browser (ADR 0024, contract 5), at /chat?folders[&at=<path>][&pick]. The box's
// folders, from files.dirs and files.recent, which pass everything through the files guard: a
// folder outside the roots, a dot folder or a secret never reaches this page.
//
// Recent folders first (at the top only), then the folders inside the roots, or inside `at`.
// A breadcrumb walks back up; a search box finds folders by name (files.dirs q, 250 ms after the
// last keystroke). Each row offers "New session here" and "Open in terminal"; in pick mode (the
// New session sheet's "Browse...") a row offers "Choose" instead.
//
// Keyboard: up and down move, Enter opens the folder, "s" starts a session there (in pick mode,
// chooses it), "t" opens a terminal there. Letters are ignored while typing in the search box.
//
// Drilling in stays on this page (no refetch of the rest of Chat); the address follows with
// pushState, so a reload lands in the same folder and Back walks back up (app.js routes popstate).

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when } from "../js/fmt.js";

const DEBOUNCE_MS = 250;

/** The last segment of a path. @param {string} p */
const baseName = p => String(p).replace(/\/+$/, "").split("/").pop() || p;

/**
 * The breadcrumb for a folder: its root, then each folder down to it. Null for the top.
 * @param {string|null} at @param {{ path: string, name: string }[]} roots
 * @returns {{ name: string, path: string|null }[]}
 */
export function crumbs(at, roots) {
  const top = { name: "Folders", path: null };
  if (!at) return [top];
  const root = roots.filter(r => at === r.path || at.startsWith(r.path.replace(/\/$/, "") + "/")).sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) return [top, { name: baseName(at), path: at }];
  const out = [top, { name: root.name || root.path, path: root.path }];
  const rest = at.slice(root.path.replace(/\/$/, "").length).split("/").filter(Boolean);
  let p = root.path.replace(/\/$/, "");
  for (const seg of rest) { p += "/" + seg; out.push({ name: seg, path: p }); }
  return out;
}

/** The address for a place in the browser. @param {string|null} at @param {boolean} pick */
export const foldersHref = (at, pick) => "/chat?folders" + (at ? "&at=" + encodeURIComponent(at) : "") + (pick ? "&pick" : "");

/** Move a selection by one, clamped to the list. @param {number} sel @param {number} n @param {number} by */
export const moveSel = (sel, n, by) => (n ? Math.max(0, Math.min(n - 1, (sel < 0 ? (by > 0 ? -1 : n) : sel) + by)) : -1);

/** Is the key press inside something the user types into? @param {any} t */
const typing = t => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

/**
 * @param {HTMLElement} container
 * @param {{ at?: string|null, pick?: ((cwd: string) => void) | null, onNewSession: (cwd: string) => void,
 *   onTerminal: (cwd: string) => (Promise<string|void>|string|void), onCancel?: () => void }} opts
 *   pick: when given, the browser chooses a folder for the New session sheet instead.
 *   onTerminal may resolve to a sentence saying why no terminal opened, which is shown.
 * @returns {() => void} cleanup
 */
export function mountFolders(container, opts) {
  let alive = true;
  const pick = typeof opts.pick === "function" ? opts.pick : null;
  const state = {
    at: opts.at || null, q: "",
    /** @type {{ path: string, name: string }[]} */ roots: [],
    /** @type {any[]} */ dirs: [], /** @type {any[]} */ recent: [],
    parent: /** @type {string|null} */ (null), truncated: false,
    loading: true, /** @type {string|null} */ error: null, /** @type {string|null} */ note: null,
    sel: -1, seq: 0,
  };

  const search = h("input", { type: "text", placeholder: "Find a folder by name", "aria-label": "Find a folder by name",
    oninput: () => { clearTimeout(timer); timer = window.setTimeout(() => { state.q = /** @type {any} */ (search).value.trim(); load(); }, DEBOUNCE_MS); },
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); select(moveSel(state.sel, rows().length, 1)); }
      else if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); state.q = /** @type {any} */ (search).value.trim(); load().then(() => { if (rows().length) select(0); }); }
      else if (e.key === "Escape" && /** @type {any} */ (search).value) { e.preventDefault(); /** @type {any} */ (search).value = ""; state.q = ""; load(); }
    } });
  let timer = 0;
  const crumbBox = h("nav", { class: "fb-crumbs", "aria-label": "Folder path" });
  const listBox = h("div", { class: "fb-list" });
  const noteBox = h("div", { class: "fb-note", role: "status" });

  put(container, h("div", { class: "fb" },
    h("div", { class: "chat-head" },
      h("h1", { class: "chat-title" }, pick ? "Choose a folder" : "Folders"),
      pick && opts.onCancel ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => opts.onCancel && opts.onCancel() }, "Cancel") : null),
    h("label", { class: "search fb-search" }, icon("search", 14), search),
    crumbBox, noteBox, listBox,
    h("div", { class: "fb-hint faint" }, h("span", { class: "kbd" }, "Up/Down"), " move, ", h("span", { class: "kbd" }, "Enter"), " open, ",
      h("span", { class: "kbd" }, "s"), pick ? " choose" : " new session", pick ? null : [", ", h("span", { class: "kbd" }, "t"), " terminal"])));

  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    const list = rows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); select(moveSel(state.sel, list.length, e.key === "ArrowDown" ? 1 : -1)); return; }
    const row = list[state.sel];
    if (!row) return;
    if (e.key === "Enter") { e.preventDefault(); open(row.path); }
    else if (e.key === "s") { e.preventDefault(); newHere(row.path); }
    else if (e.key === "t" && !pick) { e.preventDefault(); terminal(row.path); }
  };
  document.addEventListener("keydown", onKey);

  load();

  /** Every row now on the page, recent first, in the order the keyboard walks them. */
  function rows() { return [...(state.at || state.q ? [] : state.recent), ...state.dirs]; }

  async function load() {
    const seq = ++state.seq;
    state.loading = true; state.error = null;
    draw();
    const top = !state.at && !state.q;
    const [d, r] = await Promise.all([
      attempt("files.dirs", { ...(state.at ? { path: state.at } : {}), ...(state.q ? { q: state.q } : {}) }),
      top ? attempt("files.recent", { limit: 8 }) : Promise.resolve(null),
    ]);
    if (!alive || seq !== state.seq) return;
    state.loading = false;
    if (d.error) { state.error = d.error.message || d.error.code; state.dirs = []; }
    else {
      state.dirs = d.data.dirs || []; state.roots = d.data.roots || state.roots;
      state.parent = d.data.parent || null; state.truncated = !!d.data.truncated;
    }
    // A recent folder is a path; the listing's badges are looked up where the same folder shows.
    if (r) state.recent = Array.isArray(r.data) ? r.data.map(f => ({ ...f, name: baseName(f.path), recent: true })) : [];
    state.sel = -1;
    draw();
  }

  function go_(at) {
    state.at = at; state.q = ""; /** @type {any} */ (search).value = "";
    try { history.pushState(null, "", foldersHref(at, !!pick)); } catch {}
    load();
  }
  const open = p => go_(p);

  function newHere(p) { if (pick) pick(p); else opts.onNewSession(p); }

  async function terminal(p) {
    state.note = "Opening a terminal in " + baseName(p) + "...";
    draw();
    let why;
    try { why = await opts.onTerminal(p); } catch (e) { why = "Could not open a terminal: " + (/** @type {any} */ (e).message || e); }
    if (!alive) return;
    state.note = typeof why === "string" && why ? why : null;
    draw();
  }

  function select(i) {
    state.sel = i;
    const els = listBox.querySelectorAll(".fb-row");
    els.forEach((el, k) => { el.setAttribute("aria-selected", String(k === i)); if (k === i) { try { /** @type {any} */ (el).focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); } catch {} } });
  }

  function row(d, i) {
    const badges = [d.git ? h("span", { class: "tag fb-git", title: "a git repository" }, icon("branch", 11), "git") : null,
      d.project ? h("span", { class: "tag fb-project", title: "a project's folder" }, d.project) : null];
    return h("div", { class: "fb-row", role: "option", tabindex: "-1", "aria-selected": String(i === state.sel), "data-path": d.path },
      h("button", { class: "fb-open", type: "button", onclick: () => open(d.path), "aria-label": `Open ${d.name}` },
        icon(d.recent ? "clock" : "projects", 14),
        h("span", { class: "fb-name ellipsis" }, d.name),
        h("span", { class: "fb-path code faint ellipsis" }, d.recent ? d.path : state.q ? d.path : ""),
        badges,
        d.recent && d.last ? h("span", { class: "faint fb-when" }, when(d.last)) : null),
      h("div", { class: "fb-actions" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => newHere(d.path) }, pick ? "Choose" : "New session here"),
        pick ? null : h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => terminal(d.path) }, icon("terminal", 14), "Open in terminal")));
  }

  function draw() {
    if (!alive) return;
    const cs = crumbs(state.at, state.roots);
    put(crumbBox, cs.map((c, i) => [i ? h("span", { class: "fb-sep faint", "aria-hidden": "true" }, "/") : null,
      i === cs.length - 1 ? h("span", { class: "fb-crumb", "aria-current": "page" }, c.name)
        : h("button", { class: "fb-crumb link quiet", type: "button", onclick: () => go_(c.path) }, c.name)]),
      state.at && pick ? h("button", { class: "btn btn-sm fb-choose-here", type: "button", onclick: () => pick(/** @type {string} */ (state.at)) }, "Choose this folder") : null,
      state.at && !pick ? h("span", { class: "fb-here" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => newHere(/** @type {string} */ (state.at)) }, "New session here"),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => terminal(/** @type {string} */ (state.at)) }, icon("terminal", 14), "Open in terminal")) : null);
    put(noteBox, state.note || "");
    noteBox.hidden = !state.note;
    const top = !state.at && !state.q;
    let i = 0;
    const recent = top ? state.recent : [];
    put(listBox,
      state.error ? h("div", { class: "empty" }, "The folders could not be read.", h("span", { class: "code" }, state.error)) : null,
      recent.length ? h("section", { "aria-labelledby": "fb-recent-h" },
        h("div", { class: "section-head" }, h("h2", { class: "lbl", id: "fb-recent-h" }, "Recent")),
        h("div", { class: "rows", role: "listbox", "aria-label": "Recent folders" }, recent.map(d => row(d, i++)))) : null,
      h("section", { "aria-labelledby": "fb-dirs-h" },
        h("div", { class: "section-head" }, h("h2", { class: "lbl", id: "fb-dirs-h" }, state.q ? `Folders named like "${state.q}"` : state.at ? baseName(state.at) : "On the box")),
        state.dirs.length ? h("div", { class: "rows", role: "listbox", "aria-label": "Folders" }, state.dirs.map(d => row(d, i++)))
          : state.loading ? h("div", { class: "empty" }, "Reading folders...")
          : state.error ? null
          : h("div", { class: "empty" }, state.q ? "No folder by that name." : state.at ? "No folders inside this one." : "No folders yet. The box's files folders are set in its config."),
        state.truncated ? h("div", { class: "empty faint" }, state.q ? "Showing the first matches. Type more of the name to narrow it." : "Showing the first 1,000 folders.") : null));
  }

  return () => { alive = false; clearTimeout(timer); document.removeEventListener("keydown", onKey); };
}
