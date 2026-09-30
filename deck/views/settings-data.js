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
  put(root, box, ...COMMAND_CARDS.map(c => commandCard(c)));
  const load = async (check = false) => {
    const r = await attempt(check ? "update.check" : "update.status");
    if (!ctx.alive()) return;
    if (r.error) return put(box, empty("The update check is not available.", r.error));
    const c = updateCard(r.data);
    const copy = c.command ? h("button", { class: "btn secondary", type: "button", onclick: async (/** @type {MouseEvent} */ e) => {
      const b = /** @type {HTMLElement} */ (e.currentTarget);
      try { await navigator.clipboard.writeText(/** @type {string} */ (c.command)); put(b, "Copied"); } catch { put(b, "Copy"); }
    } }, "Copy") : null;
    put(box,
      h("h3", { class: "set-h" }, c.headline),
      h("p", { class: "muted" }, c.detail),
      c.version ? h("div", null,
        c.app ? h("p", null, "Vyre.app updates itself. Restart it when it says so.")
          : c.command ? h("div", { class: "cmd" }, h("pre", null, h("code", null, c.command)), copy) : null,
        c.command ? h("p", { class: "muted" }, "Run it on your server. It backs up your data first and puts the old version back on its own if the new one does not come up.") : null,
        ...c.notes.map(n => h("details", null, h("summary", null, `What changed in ${n.version}`), h("pre", { class: "muted" }, n.notes || "No notes."))),
      ) : null,
      h("div", { class: "actions" }, h("button", { class: "btn secondary", type: "button", onclick: () => load(true) }, "Look now")));
  };
  await load();
  const off = on("update.available", () => { load().catch(() => {}); });
  ctx.cleanup(off);
}
