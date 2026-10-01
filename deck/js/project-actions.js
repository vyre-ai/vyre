// @ts-check
// What a person does to a project from its page: rename it and archive it (and bring it back).
// The same calls a session makes on their behalf (projects.rename, projects.archive), so there is
// one of each. A rename changes the name only: the slug, folder, threads, teammates and tile stay
// as they were. Archiving is quiet and reversible: the project leaves the list, nothing on disk
// changes, and Undo (a toast here, Restore in the list's Archived view) brings it back.

import { h, put, go } from "./dom.js";
import { attempt } from "./api.js";
import { showToast } from "./toast.js";

/** The words for a project call that did not go through. @param {any} e */
const says = e => (e?.missing ? "The projects module is not running." : String(e?.message || "That did not go through."));

/**
 * Swap `heading` for a name field; Enter saves, Esc or Cancel puts it back. `onSaved(name)` runs
 * after projects.rename answers (the page updates its own copies).
 * @param {{ slug: string, name: string }} p @param {HTMLElement} heading @param {(name: string) => void} [onSaved]
 */
export function renameProject(p, heading, onSaved) {
  const input = /** @type {HTMLInputElement} */ (h("input", { class: "input pj-rename", "aria-label": "Project name", autocomplete: "off", value: p.name }));
  const status = h("span", { class: "small muted", role: "status" });
  const box = h("form", { class: "pj-rename-form" }, input, h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Rename"),
    h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => back() }, "Cancel"), status);
  const back = () => box.replaceWith(heading);
  input.addEventListener("keydown", (/** @type {any} */ e) => { if (e.key === "Escape") { e.stopPropagation(); back(); } });
  box.addEventListener("submit", async (/** @type {any} */ e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) { put(status, "A project needs a name."); return; }
    if (name === p.name) { back(); return; }
    put(status, "Renaming…");
    const r = await attempt("projects.rename", { project: p.slug, name });
    if (r.error) { put(status, says(r.error)); return; }
    onSaved?.(name);
    back();
    try { window.dispatchEvent(new Event("deck:pins")); } catch { /* no window: a test */ }
  });
  heading.replaceWith(box);
  input.focus();
  input.select?.();
}

/**
 * Archive a project and go to the list, with an Undo that brings it back. archived: false is the
 * Restore in the list's Archived view. @param {{ slug: string, name: string }} p @param {boolean} [archived]
 */
export async function archiveProject(p, archived = true) {
  const r = await attempt("projects.archive", { project: p.slug, archived });
  if (r.error) { showToast({ text: `${archived ? "Could not archive" : "Could not restore"} ${p.name}. ${says(r.error)}` }); return false; }
  try { window.dispatchEvent(new Event("deck:pins")); } catch { /* no window: a test */ }
  if (archived) {
    go("/projects");
    showToast({ text: `Archived ${p.name}`, undo: () => { void archiveProject(p, false).then(ok => { if (ok) go(`/projects/${encodeURIComponent(p.slug)}`); }); } });
  } else showToast({ text: `Restored ${p.name}` });
  return true;
}
