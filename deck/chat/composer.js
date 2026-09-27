// @ts-check
// The composer: one textarea, Enter to send (Shift+Enter for a newline), the lease taken on the
// first keystroke (threads.send does this itself; typing also asks for it explicitly so "X is
// typing" updates promptly for other surfaces). "/" commands are not special-cased here: Claude
// Code has its own (/rename among them): whatever is typed goes to threads.send verbatim. @ opens
// a small mention menu that just inserts text; it does not resolve or validate.
//
// On a touch screen (pointer: coarse) Enter is a newline and the send button sends, since a phone
// keyboard has no Shift. A send the Switchboard did not take ({sent: false, note}: the session is
// open in a terminal, or another surface has the keyboard) is not an error: the words stay in the
// box, the note says why, and "Try again" sends them once the way is clear.
//
// A session busy in the user's terminal takes the message into a queue instead (capsule-now's
// contract, docs/work/capsule-now.md): threads.send answers {sent: false, queued: true, name,
// note}, thread.queued {queued, text} says it is waiting, and thread.sent {queued, via} says the
// Harness handed it over at the end of the turn. The words leave the box; the session view draws
// what waits as rows above it (session.js, from session-state's queue), and opts.onQueue hears
// how many wait and for whom.
//
// While a turn runs (setBusy(true)) a Stop button sits beside Send, and Esc in the box presses
// it (opts.onStop), unless the mention menu is open.
//
// A session on the paired Mac (opts.machine, or setMachine() once the view learns it) is sent to
// through the box: threads.send carries `machine`, the box forwards it, and the reply comes back
// on the same event stream. The lease is not forwarded, so typing asks for none. A Mac that is
// offline answers the error code mac_offline: the words stay in the box, the note says so with a
// Try again, and opts.onOffline tells the view (a chip in its header); the next send that goes
// through clears it. opts.onQueue hears the queue change (how many wait, and for whom).

import { h, put } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { icon } from "../js/icons.js";

const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * @param {{ thread: string, agents: string[], threads: { id: string, name: string|null }[], holder: string|null, surface: string,
 *   machine?: string|null, onOffline?: (machine: string|null) => void, onQueue?: (n: number, name: string) => void, onStop?: () => void }} opts
 * onOffline: called with the Mac's name when a send finds it offline, with null when a send goes through.
 * @returns {{ el: HTMLElement, focus: () => void, stop: () => void, setMachine: (m: string|null) => void, setBusy: (on: boolean) => void,
 *   setText: (text: string) => void }}
 */
export function mountComposer(opts) {
  const { thread } = opts;
  /** The paired Mac this session lives on, or null for the box's own. */
  let machine = opts.machine || null;
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
  let busy = false;
  const stopBtn = h("button", { class: "btn btn-ghost btn-sm composer-stop", type: "button", hidden: true, title: "Stop this turn (Esc)",
    onclick: () => opts.onStop?.() }, "Stop", h("span", { class: "kbd" }, "Esc"));
  const wrap = h("div", { class: "composer-wrap" }, menu,
    h("div", { class: "composer-row" }, ta, stopBtn, send),
  );
  /** Messages waiting in the session's queue, by the inbox id thread.queued gives, oldest first. */
  const waiting = new Map();
  let busyName = "";
  function drawQueued() { opts.onQueue?.(waiting.size, busyName); }
  const note = h("div", { class: "composer-note", role: "status" });
  const root = h("div", { class: "composer" }, note, wrap, h("div", { class: "composer-hint" }, h("span", { class: "kbd" }, "Enter"), " to send · ", h("span", { class: "kbd" }, "Shift+Enter"), " for a new line · @ to mention · / for commands"));

  function grow() { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; }

  function maybeLease() {
    if (leaseTimer || machine) return; // a Mac's lease is not forwarded
    leaseTimer = setTimeout(() => { leaseTimer = null; }, 4000);
    attempt("threads.lease", { thread }).catch(() => {});
  }

  /** @param {string} text @returns {Record<string, any>} */
  function sendInput(text) { return { thread, text, surface: "deck", ...(machine ? { machine } : {}) }; }
  const retry = () => h("button", { class: "btn btn-ghost btn-sm composer-retry", type: "button", onclick: () => submit() }, "Try again");

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
    if (r.error && r.error.code === "mac_offline") {
      back();
      note.classList.add("soft");
      const who = machine || "your Mac";
      put(note, h("span", null, `${who} is offline; your message was not sent`), " ", retry());
      opts.onOffline?.(who);
      return;
    }
    // The Mac did not answer in time: the message may have gone through, so say so before a resend.
    if (r.error && r.error.code === "timeout") {
      back();
      note.classList.add("soft");
      put(note, h("span", null, r.error.message || "The Mac did not answer in time; your message may not have been sent"), " ",
        h("span", { class: "faint" }, "It may have been sent. Check before sending again."), " ", retry());
      return;
    }
    if (r.error) { put(note, "Could not send: " + r.error.message); back(); return; }
    if (machine) opts.onOffline?.(null);
    if (r.data?.queued === true) {
      busyName = r.data.name || busyName;
      // The id comes with thread.queued; until then the words stand in under a temporary key.
      if (![...waiting.values()].includes(text)) waiting.set("pending:" + text, text);
      drawQueued();
      // On the Mac: say where it waits, with the Mac's own note.
      if (machine && r.data.note) { note.classList.add("soft"); put(note, `On ${machine} · ${r.data.note}`); }
      return;
    }
    if (r.data?.sent === false) {
      back();
      note.classList.add("soft");
      put(note, h("span", null, r.data.note || "The session did not take the message."), " ", retry());
    }
  }

  function onKey(e) {
    if (!menu.hidden && (e.key === "Escape")) { closeMenu(); return; }
    if (e.key === "Escape" && busy && opts.onStop) { e.preventDefault(); opts.onStop(); return; }
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

  const offs = [
    on("thread.queued", e => {
      if (e.thread !== thread || !e.payload?.queued) return;
      waiting.delete("pending:" + e.payload.text);
      waiting.set(String(e.payload.queued), String(e.payload.text || ""));
      drawQueued();
    }),
    // Handed over (or typed in directly): a queued one leaves the list, and the note goes with the last.
    on("thread.sent", e => {
      if (e.thread !== thread) return;
      const id = e.payload?.queued;
      if (id != null) { waiting.delete(String(id)); waiting.delete("pending:" + e.payload.text); }
      drawQueued();
      if (machine && id != null && !waiting.size) { put(note); note.classList.remove("soft"); }
    }),
  ];

  return { el: root, focus: () => ta.focus(), setMachine: m => { machine = m || null; },
    setBusy: on => { busy = !!on && !!opts.onStop; stopBtn.hidden = !busy; },
    setText: t => { ta.value = String(t ?? ""); grow(); ta.focus(); },
    stop: () => { for (const off of offs) off(); clearTimeout(leaseTimer); } };
}
