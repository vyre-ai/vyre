// @ts-check
// The composer: one textarea, Enter to send (Shift+Enter for a newline), the lease taken on the
// first keystroke (threads.send does this itself; typing also asks for it explicitly so "X is
// typing" updates promptly for other surfaces). "/" commands are not special-cased here — Claude
// Code has its own (/rename among them): whatever is typed goes to threads.send verbatim. @ opens
// a small mention menu that just inserts text; it does not resolve or validate.
//
// On a touch screen (pointer: coarse) Enter is a newline and the send button sends, since a phone
// keyboard has no Shift. A send the Switchboard did not take ({sent: false, note}: the session is
// open in a terminal, or another surface has the keyboard) is not an error: the words stay in the
// box, the note says why, and "Try again" sends them once the way is clear.

import { h, put } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { icon } from "../js/icons.js";

const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * @param {{ thread: string, agents: string[], threads: { id: string, name: string|null }[], holder: string|null, surface: string }} opts
 * @returns {{ el: HTMLElement, focus: () => void, stop: () => void }}
 */
export function mountComposer(opts) {
  const { thread } = opts;
  let leaseTimer = null;
  let sending = false;
  const ta = h("textarea", {
    rows: 1, placeholder: "Message this session",
    "aria-label": "Message", enterkeyhint: "send",
    oninput: e => { grow(); maybeLease(); mention(/** @type {any} */ (e.target)); },
    onkeydown: onKey,
  });
  const menu = h("div", { class: "composer-menu", hidden: true });
  const send = h("button", { class: "ibtn composer-send", "aria-label": "Send", onclick: submit }, icon("send", 16));
  const wrap = h("div", { class: "composer-wrap" }, menu,
    h("div", { class: "composer-row" }, ta, send),
  );
  const queued = h("div", { class: "composer-queued", role: "status", hidden: true }, icon("clock", 12), "Queued, sends when the session is free");
  const note = h("div", { class: "composer-note", role: "status" });
  const root = h("div", { class: "composer" }, queued, note, wrap, h("div", { class: "composer-hint" }, h("span", { class: "kbd" }, "Enter"), " to send · ", h("span", { class: "kbd" }, "Shift+Enter"), " for a new line · @ to mention · / for Claude Code's commands"));

  function grow() { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; }

  function maybeLease() {
    if (leaseTimer) return;
    leaseTimer = setTimeout(() => { leaseTimer = null; }, 4000);
    attempt("threads.lease", { thread }).catch(() => {});
  }

  // ---- QUEUE SEAM -------------------------------------------------------------------------------
  // What a send asks threads.send for. Once the capsule-now team ships "queue a message for a busy
  // session and deliver it on the Stop hook", threads.send takes { queue: true } and answers
  // { queued: true } instead of { sent: false, note }. Turning that on is this one line:
  //   return { thread, text, queue: true };
  // Until then the flag is left out, since the tool's input schema does not know it yet. The
  // answer side is already here: submit() shows the Queued pill for data.queued === true, and the
  // pill goes when thread.sent for this thread arrives (the queued message was delivered).
  /** @param {string} text @returns {Record<string, any>} */
  function sendInput(text) { return { thread, text }; }

  async function submit() {
    const text = /** @type {any} */ (ta.value).trim();
    if (!text || sending) return;
    sending = true;
    ta.value = ""; grow();
    send.disabled = true;
    put(note); note.classList.remove("soft");
    const r = await attempt("threads.send", sendInput(text));
    sending = false;
    send.disabled = false;
    const back = () => { if (!ta.value) { ta.value = text; grow(); } };
    // One note, replaced each time, and the words go back in the box so nothing typed is lost.
    if (r.error) { put(note, "Could not send: " + r.error.message); back(); return; }
    if (r.data?.queued === true) { queued.hidden = false; return; }
    if (r.data?.sent === false) {
      back();
      note.classList.add("soft");
      put(note, h("span", null, r.data.note || "The session did not take the message."), " ",
        h("button", { class: "btn btn-ghost btn-sm composer-retry", type: "button", onclick: () => submit() }, "Try again"));
    }
  }

  function onKey(e) {
    if (!menu.hidden && (e.key === "Escape")) { closeMenu(); return; }
    // A phone keyboard has no Shift: Enter is a newline there, and the send button sends.
    if (e.key === "Enter" && !e.shiftKey && menu.hidden && !e.isComposing && !touch()) { e.preventDefault(); submit(); }
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

  // A queued message went in: the Switchboard emits thread.sent when it types it into the session.
  const off = on("thread.sent", e => { if (e.thread === thread) queued.hidden = true; });

  return { el: root, focus: () => ta.focus(), stop: () => { off(); clearTimeout(leaseTimer); } };
}
