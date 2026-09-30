// @ts-check
// Settings, "Update, export and uninstall": what a person does with the Vyre they already run.
// One section of deck/views/settings.js, drawn here (launch owns it). Each card is a thin view over a
// tool the box already answers, and none of them runs anything on the host: the Update card SHOWS
// the one command a box person runs (PLAN R2h), and on a Mac the app updates itself.
//
// Light: nothing on a timer. It loads when Settings opens, after each action, and on update.available.
//
// Export and Uninstall are the same kind of card: what it does in plain words and the one command that
// does it. Sealing a whole export under a passphrase and stopping a stack are done where the data is, on
// the machine's own terminal, so they are never a button in a page that a stolen session could press.
//
// Tools: update.status, update.check.

import { h, put, empty } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { showToast } from "../js/toast.js";
import { updateCard, COMMAND_CARDS } from "../js/update-card.js";

/** @param {typeof COMMAND_CARDS[number]} c */
function commandCard(c) {
  return h("div", { class: "set-card" },
    h("h3", { class: "set-h" }, c.title),
    ...c.says.map(t => h("p", { class: "muted" }, t)),
    ...c.commands.map(m => {
      const copy = h("button", { class: "btn secondary", type: "button", onclick: async (/** @type {MouseEvent} */ e) => {
        const b = /** @type {HTMLElement} */ (e.currentTarget);
        try { await navigator.clipboard.writeText(m.line); put(b, "Copied"); } catch { put(b, "Copy"); }
      } }, "Copy");
      return h("div", null, h("div", { class: "cmd" }, h("pre", null, h("code", null, m.line)), copy), h("p", { class: "muted" }, m.note));
    }));
}

/**
 * @param {HTMLElement} root
 * @param {any} ctx
 */
export async function drawData(root, ctx) {
  const box = h("div", { class: "set-card" });
  let working = false;
  put(root, box, ...COMMAND_CARDS.map(c => commandCard(c)));
  /** @type {any} */ let timer = null;
  const load = async (check = false) => {
    clearTimeout(timer);
    const r = await attempt(check ? "update.check" : "update.status");
    if (!ctx.alive()) return;
    // Mid-update vyred restarts, so an unanswered ask is expected: say so and ask again.
    if (r.error) { if (working) { put(box, h("h3", { class: "set-h" }, "Restarting Vyre"), h("p", { class: "muted" }, "This page reconnects by itself.")); timer = setTimeout(() => load(), 4000); ctx.cleanup(() => clearTimeout(timer)); return; } return put(box, empty("The update check is not available.", r.error)); }
    const c = updateCard(r.data);
    working = c.busy;
    const copy = c.command ? h("button", { class: "btn secondary", type: "button", onclick: async (/** @type {MouseEvent} */ e) => {
      const b = /** @type {HTMLElement} */ (e.currentTarget);
      try { await navigator.clipboard.writeText(/** @type {string} */ (c.command)); put(b, "Copied"); } catch { put(b, "Copy"); }
    } }, "Copy") : null;
    const apply = h("button", { class: "btn primary", type: "button", onclick: async () => {
      const a = await attempt("update.apply");
      if (a.error) showToast(String(a.error.message || "Could not ask for the update"));
      load();
    } }, `Update to ${c.version}`);
    put(box,
      h("h3", { class: "set-h" }, c.headline),
      h("p", { class: "muted" }, c.detail),
      c.progress ? h("p", { class: "status", role: "status" }, h("span", { class: "ring", "aria-hidden": "true" }), c.progress) : null,
      c.result ? h("p", { class: c.result.ok ? "note" : "warn", role: c.result.ok ? "status" : "alert" }, c.result.text) : null,
      c.version && !c.busy ? h("div", null,
        c.app ? h("p", null, "Vyre.app updates itself. Restart it when it says so.")
          : c.canApply ? h("div", { class: "actions" }, apply) : null,
        c.canApply ? h("p", { class: "muted" }, "Vyre checks the release's signature, backs up your data first, and puts the old version back on its own if the new one does not start.") : null,
        c.command ? h("details", null, h("summary", null, c.canApply ? "Or run it yourself" : "Run it on your server"),
          h("div", { class: "cmd" }, h("pre", null, h("code", null, c.command)), copy),
          c.canApply ? null : h("p", { class: "muted" }, "It backs up your data first and puts the old version back on its own if the new one does not come up.")) : null,
        ...c.notes.map(n => h("details", null, h("summary", null, `What changed in ${n.version}`), h("pre", { class: "muted" }, n.notes || "No notes."))),
      ) : null,
      h("div", { class: "actions" }, h("button", { class: "btn secondary", type: "button", onclick: () => load(true) }, "Look now")));
    // Only while a request or a run is open does the card ask again, every few seconds.
    if (c.busy) { timer = setTimeout(() => load(), 3000); ctx.cleanup(() => clearTimeout(timer)); }
  };
  await load();
  const off = on("update.available", () => { load().catch(() => {}); });
  ctx.cleanup(off);
}
