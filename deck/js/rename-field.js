// @ts-check
// Rename in place (#65, team/0.2.2/deck-v2/devices.html): a name with a pencil beside it; the pencil opens a field where the name was, Enter or Save
// keeps it, Esc or Cancel leaves it. The name is 1 to 64 characters. The caller says how it is saved (relay.devices.rename,
// system.rename or computers.rename) and the control shows whatever the box answers. It follows a `device.renamed` event for the same id, so a name
// changed on another screen changes here too.

import { h, put } from "./dom.js";
import { icon } from "./icons.js";

export const NAME_MAX = 64;

/**
 * @param {{ name: string, label?: string, save: (name: string) => Promise<{ error?: { message?: string } | null }>, allowEmpty?: boolean, onSaved?: (name: string) => void }} o
 * @returns {HTMLElement & { setName: (n: string) => void }}
 */
export function renameField({ name, label = "Rename", save, allowEmpty = false, onSaved }) {
  let current = name;
  const shown = h("span", { class: "rn-name" }, current);
  const pencil = h("button", { type: "button", class: "btn btn-ghost btn-sm rn-edit", "aria-label": `${label} ${current}`, title: label, onclick: () => edit() }, icon("edit", 14));
  const el = /** @type {any} */ (h("span", { class: "rn" }, shown, pencil));

  function edit() {
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "input rn-in", type: "text", value: current, maxlength: String(NAME_MAX), "aria-label": label, autocomplete: "off", spellcheck: "false" }));
    const msg = h("span", { class: "rn-msg small faint", role: "status" });
    const done = () => put(el, shown, pencil);
    const keep = async () => {
      const v = input.value.trim();
      if (!v && !allowEmpty) { put(msg, "A name is one to 64 characters."); return; }
      if (v.length > NAME_MAX) { put(msg, "A name is one to 64 characters."); return; }
      if (v === current) { done(); return; }
      put(msg, "Saving");
      saveBtn.setAttribute("disabled", "");
      const r = await save(v);
      saveBtn.removeAttribute("disabled");
      if (r && r.error) { put(msg, String(r.error.message || "Could not save that name.")); return; }
      el.setName(v);
      onSaved?.(v);
      done();
    };
    const saveBtn = h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: keep }, "Save");
    input.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "Enter") { e.preventDefault(); void keep(); }
      if (e.key === "Escape") { e.preventDefault(); done(); }
    });
    put(el, input, saveBtn, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: done }, "Cancel"), msg);
    input.focus();
    input.select?.();
  }

  el.setName = (/** @type {string} */ n) => { current = n; put(shown, n); pencil.setAttribute("aria-label", `${label} ${n}`); };
  return el;
}

/** The tool that renames a device of this kind, with the input it takes (tailnet's #65: device.renamed carries {kind, id, name}). */
export function renameCall(/** @type {"relay" | "server" | "computer"} */ kind, /** @type {string} */ id, /** @type {string} */ name) {
  if (kind === "server") return { tool: "system.rename", input: { name } };
  if (kind === "computer") return { tool: "computers.rename", input: { computer: id, name } };
  return { tool: "relay.devices.rename", input: { id, name } };
}
