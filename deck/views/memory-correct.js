// @ts-check
// Correcting a fact in place (ADR 0007, decisions 4 and 13). The fact's object becomes a field in
// its own sentence, as held drafts do in editable.js: it reads as text until focused. ⌘⏎ (or
// Ctrl+Enter) saves the new object, Esc cancels, and two plain buttons say "No longer true" and
// "Wrong". After a save the closed fact shows muted above the new one, sourced "You, just now",
// with an Undo that calls memory.uncorrect.

import { h, put } from "../js/dom.js";
import { call } from "../js/api.js";
import { splitFact, pct, correctSummary } from "./memory-data.js";
import { withPresence } from "./memory-presence.js";

/** What the user sees when a tool is not there yet, or refused. */
export function errWords(err, what = "Correcting facts") {
  if (err && err.code === "no_such_tool") return `${what} needs a newer memory module than this machine runs. Nothing was changed.`;
  if (err && err.state === "cancelled") return "Cancelled. Nothing changed.";
  if (err && err.state === "no_passkey") return "This needs you in person, and this Deck has no passkey. Enroll one in Settings. Nothing was changed.";
  if (err && err.missing) return `The ${err.module} module is not running on this machine, so nothing was changed.`;
  return String(err && err.message || err || "That did not work.");
}

/**
 * The form. Resolves nothing; calls onDone({ action, object, id }) after memory.correct answers,
 * or onCancel() on Esc or Cancel.
 * @param {any} f a fact from memory.facts
 * @param {{ project?: string, status: HTMLElement, onDone: (r: { action: string, object: string|null, id: any }) => void, onCancel: () => void, cls?: string }} o
 */
export function correctForm(f, o) {
  const parts = splitFact(f.text, f.object?.label || "");
  const id = "cx-" + Math.random().toString(36).slice(2, 8);
  const input = /** @type {HTMLInputElement} */ (h("input", { id, class: "ed-in mem-cx-in", type: "text", autocomplete: "off", spellcheck: "false",
    "aria-label": `New value for ${f.object?.label || "this fact"}. Command Enter saves, Escape cancels.` }));
  input.value = parts.object;
  const size = () => { input.style.width = Math.max(6, Math.min(40, input.value.length + 1)) + "ch"; };
  size();
  const busy = on => { for (const b of el.querySelectorAll("button, input")) /** @type {any} */ (b).disabled = on; };
  const send = async (action) => {
    const object = action === "replace" ? input.value.trim() : null;
    if (action === "replace" && (!object || object === parts.object)) { put(o.status, object ? "That is what it says already." : "Say what it is now, or use No longer true."); input.focus(); return; }
    busy(true);
    put(o.status, action === "replace" ? "Saving your correction." : "Saving.");
    try {
      // The project's slug scopes the correction to that project; without it, everywhere.
      // A presence prompt appears only if vyred asks for one; otherwise this is a plain call.
      const r = await withPresence("memory.correct", { fact: f.id, action, ...(object ? { object } : {}), ...(o.project ? { project: o.project } : {}) },
        { summary: correctSummary(f.text, action, object, o.project) });
      put(o.status);
      o.onDone({ action, object, id: r && (r.id ?? r.correction?.id ?? r.correction) });
    } catch (err) {
      busy(false);
      put(o.status, errWords(err));
      input.focus();
    }
  };
  input.addEventListener("input", size);
  const el = h("form", { class: "mem-cx " + (o.cls || ""), onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); send("replace"); },
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); o.onCancel(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send("replace"); }
    } },
    h("p", { class: "mem-cx-text" }, h("span", { class: "dot recall", "aria-hidden": "true" }),
      h("span", null, parts.before, input, parts.after)),
    h("div", { class: "mem-cx-act" },
      h("button", { type: "submit", class: "btn btn-sm" }, "Save", h("span", { class: "kbd mem-cx-kbd", "aria-hidden": "true" }, "⌘⏎")),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => send("ended") }, "No longer true"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => send("wrong") }, "Wrong"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: o.onCancel }, "Cancel")));
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return el;
}

/**
 * What a correction left: the old fact muted and closed, then the new one in gold, sourced to the
 * user, with Undo. For "ended" and "wrong" there is no new fact.
 * @param {any} f the fact as it was
 * @param {{ action: string, object: string|null, id: any }} c
 * @param {{ status: HTMLElement, onUndone: () => void }} o
 */
export function corrected(f, c, o) {
  const parts = splitFact(f.text, f.object?.label || "");
  const was = c.action === "wrong" ? "Marked wrong, just now" : "No longer true, from today";
  const undo = h("button", { type: "button", class: "link mem-linkbtn mem-undo", onclick: async () => {
    /** @type {HTMLButtonElement} */ (undo).disabled = true;
    try {
      if (c.id === undefined || c.id === null) throw new Error("memory.correct did not say which correction it made, so it cannot be undone here.");
      await call("memory.uncorrect", { id: c.id });
      put(o.status, "Undone. The fact is as it was.");
      o.onUndone();
    } catch (err) { /** @type {HTMLButtonElement} */ (undo).disabled = false; put(o.status, errWords(err, "Undoing a correction")); }
  } }, "Undo");
  return h("div", { class: "mem-cx-done" },
    h("div", { class: "mem-cx-old" },
      h("span", { class: "dot mem-dot-closed", "aria-hidden": "true" }),
      h("div", null, h("s", { class: "mem-cx-old-text" }, f.text), h("div", { class: "mem-cx-meta" }, was))),
    c.action === "replace" ? h("div", { class: "mem-cx-new" },
      h("span", { class: "dot recall", "aria-hidden": "true" }),
      h("div", null, h("div", { class: "mem-cx-new-text" }, parts.before, c.object, parts.after),
        h("div", { class: "mem-cx-meta" }, h("span", { class: "mem-gold" }, "You, just now"), " · ", h("span", { class: "code" }, pct(1))))) : null,
    h("div", { class: "mem-cx-undo" }, undo));
}
