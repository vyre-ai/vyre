// @ts-check
// The composer: one textarea, Enter to send (Shift+Enter for a newline), the lease taken on the
// first keystroke (threads.send does this itself; typing also asks for it explicitly so "X is
// typing" updates promptly for other surfaces). "/" commands are not special-cased here — Claude
// Code has its own (/rename among them): whatever is typed goes to threads.send verbatim. @ opens
// a small mention menu that just inserts text; it does not resolve or validate.

import { h } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";

/**
 * @param {{ thread: string, agents: string[], threads: { id: string, name: string|null }[], holder: string|null, surface: string }} opts
 */
export function mountComposer(opts) {
  const { thread } = opts;
  let leaseTimer = null;
  const ta = h("textarea", {
    rows: 1, placeholder: "Message this session",
    "aria-label": "Message",
    oninput: e => { grow(); maybeLease(); mention(/** @type {any} */ (e.target)); },
    onkeydown: onKey,
  });
  const menu = h("div", { class: "composer-menu", hidden: true });
  const send = h("button", { class: "ibtn", "aria-label": "Send", onclick: submit }, icon("send", 16));
  const wrap = h("div", { class: "composer-wrap" }, menu,
    h("div", { class: "composer-row" }, ta, send),
  );
  const note = h("div", { class: "composer-note", role: "status" });
  const root = h("div", { class: "composer" }, note, wrap, h("div", { class: "composer-hint" }, h("span", { class: "kbd" }, "Enter"), " to send · ", h("span", { class: "kbd" }, "Shift+Enter"), " for a new line · @ to mention · / for Claude Code's commands"));

  function grow() { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; }

  function maybeLease() {
    if (leaseTimer) return;
    leaseTimer = setTimeout(() => { leaseTimer = null; }, 4000);
    attempt("threads.lease", { thread }).catch(() => {});
  }

  async function submit() {
    const text = /** @type {any} */ (ta.value).trim();
    if (!text) return;
    ta.value = ""; grow();
    send.disabled = true;
    note.textContent = "";
    const r = await attempt("threads.send", { thread, text });
    send.disabled = false;
    // One note, replaced each time, and the words go back in the box so nothing typed is lost.
    if (r.error) { note.textContent = "Could not send: " + r.error.message; if (!ta.value) { ta.value = text; grow(); } }
  }

  function onKey(e) {
    if (!menu.hidden && (e.key === "Escape")) { closeMenu(); return; }
    if (e.key === "Enter" && !e.shiftKey && menu.hidden) { e.preventDefault(); submit(); }
  }

  function mention(el) {
    const v = el.value, pos = el.selectionStart ?? v.length;
    const at = v.lastIndexOf("@", pos - 1);
    if (at === -1) { closeMenu(); return; }
    const q = v.slice(at + 1, pos);
    if (/[\s\n]/.test(q)) { closeMenu(); return; }
    const items = [
      ...opts.agents.filter(a => a.toLowerCase().startsWith(q.toLowerCase())).map(a => ({ label: "@" + a, insert: a + " " })),
      ...opts.threads.filter(t => (t.name || t.id).toLowerCase().includes(q.toLowerCase())).slice(0, 6).map(t => ({ label: "#" + (t.name || t.id.slice(0, 8)), insert: (t.name || t.id) + " " })),
    ];
    if (!items.length) { closeMenu(); return; }
    menu.hidden = false;
    menu.replaceChildren(...items.map(it => h("button", { type: "button", onclick: () => { el.value = v.slice(0, at + 1) + it.insert + v.slice(pos); closeMenu(); el.focus(); } }, it.label)));
  }
  function closeMenu() { menu.hidden = true; menu.replaceChildren(); }

  return { el: root, focus: () => ta.focus() };
}
