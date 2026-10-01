// @ts-check
// The draft card (docs/design/system/components/draft-card.md and calendar.md's invite): a blocking
// ask of kind "email_draft" or "calendar_draft", an outbound thing the person's own agent wrote
// and the Gate holds until they say so. Every line is a field that edits in place (no Edit
// button): To/Cc/Subject/Message for mail, Title/When/People/Where/Message for an invite, and an
// attachment as a file row. Edits go with the answer as `edited` (only the fields that changed).
//
// Two ways a send is approved, decided by the ask, never by a flag the caller attaches:
//   matched   the ask carries `said` (the Gate matched it to something the person's own turn asked
//             for, "asking is approving"): Send is threads.answer allow, no passkey, no presence line.
//   unmatched no `said`: exactly the held card gate-item.js draws today. Send is gate.approve
//             (ask.gate is the held item) with presence: true, "Send with Face ID" once a proof has
//             lapsed, and the presence line says until when a proof covers sends. Discard is the
//             person's own act (presence "asked", as gate.reject).
// Without an ask.gate the unmatched path answers the ask itself with the same proof.
//
// Ask shape read: { id, kind, agent, at, said?, gate?, presence?, accounts?, draft: {...} } with the
// fields under `draft` (or on the ask). Mail: {from?, to, cc, subject, body, attach:[{name,size}]}.
// Invite: {title, start, end, tz?, attendees:[{name, availability?}], place, notes}.

import { failureLine } from "../gate-lines.js";
import { kbd } from "../../js/platform.js";
import { h, put, isPhone } from "../../js/dom.js";
import { queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { presenceWord } from "../../js/need-rows.js";
import { coverLine } from "../../js/need-sheet.js";
import { cardHead, keyHint, busyLabel, widthOf, fromLine } from "../ask-item.js";
import { problemLine } from "../presence.js";
import { ensureCss, shell, untrusted } from "./kit.js";
import { timeRange } from "./calendar-event.js";

const AVAIL = { free: "free", busy: "busy" };
const list = (/** @type {any} */ v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map(x => String(x?.name ?? x).trim()).filter(Boolean);
/** The local `YYYY-MM-DDTHH:mm` a datetime-local input takes. @param {any} t */
function localInput(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const size = (/** @type {any} */ n) => typeof n === "number" ? (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`) : n ? String(n) : "";

/** The fields of a draft, whichever way the ask nests them. @param {any} ask */
function content(ask) { return { ...ask, ...(ask.draft && typeof ask.draft === "object" ? ask.draft : {}) }; }

/**
 * @param {any} ask
 * @param {{ thread?: string|null, phone?: boolean, open?: (href: string) => void }} [ctx]
 * @returns {HTMLElement & { update: (a: any) => void, answered: (decision: string, answers?: any, from?: { where: string, at?: number|null }|null) => void,
 *   onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 */
export function draftCard(ask, ctx = {}) {
  ensureCss("draft");
  const invite = ask?.kind === "calendar_draft";
  const label = invite ? "Invite to send" : "Draft to send";
  const el = /** @type {any} */ (shell("cv-draft ask-card cv-ask", label));
  el.setAttribute("tabindex", "0");
  const phone = ctx.phone ?? isPhone();
  const state = { dirty: /** @type {Record<string, any>} */ ({}), busy: /** @type {string|null} */ (null), width: 0, problem: /** @type {any} */ (null),
    done: /** @type {"sent"|"discarded"|"withdrawn"|null} */ (null), failed: /** @type {string|null} */ (null), editingTime: false,
    from: /** @type {{ where: string, at?: number|null }|null} */ (null) };

  /** Was this send matched to what the person's own turn asked for? Only the ask says so. */
  const matched = () => !!ask.said || ask.matched === true;
  const held = () => ask.gate ?? ask.held ?? null;
  const value = (/** @type {string} */ k) => (k in state.dirty ? state.dirty[k] : null);

  /** Text as shown for a field: the edit if there is one, else the draft's own. @param {string} k */
  function shown(k) {
    const c = content(ask);
    if (k in state.dirty) return String(state.dirty[k]);
    if (k === "to" || k === "cc") return list(c[k]).join(", ");
    if (k === "attendees") return list(c.attendees).join(", ");
    if (k === "notes") return String(c.notes ?? c.body ?? "");
    return String(c[k] ?? "");
  }
  /** Only a real change stays an edit; typing the original back removes it. @param {string} k @param {string} v @param {string} original */
  function edit(k, v, original) { if (v === original) delete state.dirty[k]; else state.dirty[k] = v; label_(); }

  /** The edits as the answer takes them: the address and people lists as lists. */
  function changes() {
    const out = /** @type {Record<string, any>} */ ({ ...state.dirty });
    for (const k of ["to", "cc", "attendees"]) if (k in out) out[k] = String(out[k]).split(",").map(s => s.trim()).filter(Boolean);
    return Object.keys(out).length ? out : undefined;
  }

  const word = () => presenceWord(typeof navigator !== "undefined" ? navigator.userAgent || "" : "", (typeof navigator !== "undefined" && navigator.maxTouchPoints) || 0);
  const covered = () => !!coverLine(ask.presence, word());

  /** The name Sent says: the first person it went to. */
  function toWhom() {
    const c = content(ask);
    const first = list(invite ? c.attendees : c.to)[0] || "";
    return String(first).replace(/<.*$/, "").trim() || first;
  }

  async function send() {
    if (state.busy || state.done) return;
    state.width = widthOf(el, "send");
    state.busy = "send"; state.problem = null; state.failed = null; draw();
    const edited = changes();
    const gate = !matched() && held();
    const r = gate
      ? await queued("gate.approve", edited ? { id: gate, edited } : { id: gate }, { presence: true })
      : await queued("threads.answer", { ask: ask.id, decision: "allow", surface: "deck", ...(edited ? { edited } : {}) }, matched() ? { presence: false } : { presence: true });
    state.busy = null;
    // Refused (no proof, a cancelled passkey, a bad edit): nothing left, the edits stay.
    if (r.error) { state.problem = r.error; draw(); return; }
    // Approved but the sender failed: it stays held with the edit, and the card says why.
    if (r.data?.state === "failed") { state.failed = failureLine(r.data.error, r.data.reached); draw(); return; }
    state.done = "sent"; draw();
  }

  async function discard() {
    if (state.busy || state.done) return;
    state.busy = "discard"; state.problem = null; draw();
    const gate = !matched() && held();
    const r = gate ? await queued("gate.reject", { id: gate }, { presence: "asked" })
      : await queued("threads.answer", { ask: ask.id, decision: "deny", surface: "deck" }, { presence: "asked" });
    state.busy = null;
    if (r.error) { state.problem = r.error; draw(); return; }
    state.done = "discarded"; draw();
  }

  // ---- fields --------------------------------------------------------------------------------

  /** A value that reads as text and edits in place, one line unless `multi`. @param {string} k @param {string} name @param {{ multi?: boolean, mono?: boolean }} [o] */
  function field(k, name, o = {}) {
    const orig = originalOf(k);
    return h("div", { class: "cv-dr-row" },
      h("span", { class: "cv-dr-key" }, name),
      h("span", { class: "cv-dr-val" + (o.mono ? " mono" : "") + (o.multi ? " cv-dr-multi" : ""), role: "textbox", "aria-multiline": o.multi ? "true" : "false", "aria-label": name,
        contenteditable: state.busy ? "false" : "plaintext-only", spellcheck: "false", tabindex: "0", "data-field": k, "data-ph": `Add ${name.toLowerCase()}`,
        oninput: (/** @type {any} */ e) => edit(k, e.target.textContent || "", orig),
        onkeydown: (/** @type {any} */ e) => {
          if (e.key === "Escape") { e.preventDefault(); e.target.blur?.(); el.focus?.(); return; }
          if (e.key === "Enter" && !o.multi && !(e.metaKey || e.ctrlKey)) e.preventDefault();
        } }, shown(k)));
  }
  /** The draft's own text of a field, before any edit. @param {string} k */
  function originalOf(k) {
    const c = content(ask);
    if (k === "to" || k === "cc" || k === "attendees") return list(c[k]).join(", ");
    if (k === "notes") return String(c.notes ?? c.body ?? "");
    return String(c[k] ?? "");
  }

  function when_() {
    const c = content(ask);
    const start = value("start") ?? c.start, end = value("end") ?? c.end;
    const text = timeRange(start, end, c.tz);
    const day = Number.isFinite(new Date(start).getTime()) ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(start)) : "";
    if (state.editingTime) {
      const one = (/** @type {string} */ k, /** @type {any} */ t, /** @type {string} */ name) => h("input", { class: "cv-dr-time", type: "datetime-local", "aria-label": name, value: localInput(t), "data-field": k, disabled: !!state.busy,
        onchange: (/** @type {any} */ e) => { const d = new Date(e.target.value); if (Number.isFinite(d.getTime())) { state.dirty[k] = d.toISOString(); label_(); } } });
      return h("div", { class: "cv-dr-row" }, h("span", { class: "cv-dr-key" }, "When"),
        h("span", { class: "cv-dr-times" }, one("start", start, "Starts"), one("end", end, "Ends"),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { state.editingTime = false; draw(); } }, "Done")));
    }
    return h("div", { class: "cv-dr-row" }, h("span", { class: "cv-dr-key" }, "When"),
      h("button", { class: "cv-dr-val cv-dr-when", type: "button", "aria-label": "When", "data-field": "when", disabled: !!state.busy, onclick: () => { state.editingTime = true; draw(); } },
        [day, text].filter(Boolean).join(", ") || "Add a time"));
  }

  /** Free, busy or no answer beside each person, as a mark and a word; nothing when the connector could not say. */
  function availability() {
    const c = content(ask);
    const p = (Array.isArray(c.attendees) ? c.attendees : []).filter((/** @type {any} */ a) => a && typeof a === "object" && a.availability);
    if (!p.length || "attendees" in state.dirty) return null;
    return h("ul", { class: "cv-dr-avail", role: "list" }, p.map((/** @type {any} */ a) => {
      const w = AVAIL[/** @type {"free"|"busy"} */ (String(a.availability).toLowerCase())] || "no answer yet";
      return h("li", { class: "cv-dr-person" }, h("span", { class: "cv-dr-pname ellipsis" }, untrusted(a.name, 120)),
        h("span", { class: "cv-dr-presp" }, h("span", { class: `cv-mark cv-mark-${w === "free" ? "done" : w === "busy" ? "needs" : "neutral"}`, "aria-hidden": "true" }), w));
    }));
  }

  function attachments() {
    const a = /** @type {any[]} */ (content(ask).attach || content(ask).attachments || []);
    if (invite || !a.length) return null;
    return h("div", { class: "cv-dr-row" }, h("span", { class: "cv-dr-key" }, "Attach"),
      h("span", { class: "cv-dr-files" }, a.map(f => h("span", { class: "cv-dr-file" }, icon("file", 14),
        h("span", { class: "cv-dr-fname ellipsis" }, untrusted(f?.name ?? f, 120)), f?.size ? h("span", { class: "cv-dr-fsize" }, size(f.size)) : null))));
  }

  // ---- the card ------------------------------------------------------------------------------

  const edited_ = () => Object.keys(state.dirty).length > 0;
  /** The Send label: plain when covered or matched, with the person's proof once it lapsed. */
  function sendLabel() {
    const proof = !matched() && !covered();
    return `${edited_() ? "Send edited" : invite ? "Send invite" : "Send"}${proof ? ` with ${word()}` : ""}`;
  }
  /** Only the Send label changes on an edit: no full redraw, so the caret stays where it is. */
  function label_() {
    const b = /** @type {any} */ (el.querySelector?.("[data-act=send]"));
    if (b && !state.busy) put(b, sendLabel(), keyHint(kbd("Enter")));
  }

  function draw() {
    const c = content(ask);
    if (state.done) {
      const words = state.done === "sent" ? `${invite ? "Invite sent" : "Sent"}${toWhom() ? ` to ${toWhom()}` : ""}` : state.done === "discarded" ? "Discarded" : "Withdrawn";
      put(el, cardHead({ kind: label, who: ask.agent || "Vyre", at: ask.at ?? ask.created_at, open: false }),
        h("div", { class: "gate-resolved" }, icon(state.done === "sent" ? "check" : "close", 14), words), fromLine(state.from));
      el.classList.add("answered");
      return;
    }
    const gateLabel = invite ? "Gate · outbound invite" : "Gate · outbound email";
    const cover = !matched() ? coverLine(ask.presence, word()) : "";
    const primary = h("button", { class: "btn btn-primary cv-ask-btn cv-dr-send" + (state.busy === "send" ? " cv-ask-busy" : ""), type: "button", "data-act": "send", disabled: !!state.busy,
      "aria-busy": state.busy === "send" ? "true" : null, "aria-keyshortcuts": "Meta+Enter Control+Enter", onclick: send,
      style: state.busy === "send" && state.width ? { minWidth: `${state.width}px` } : null },
    state.busy === "send" ? busyLabel("Sending") : [sendLabel(), keyHint(kbd("Enter"))]);
    put(el,
      cardHead({ kind: label, who: ask.agent || "Vyre", at: ask.at ?? ask.created_at, open: true, extra: h("span", { class: "cv-dr-gate" }, gateLabel) }),
      h("div", { class: "cv-dr-fields" },
        ...(invite
          ? [field("title", "Title"), when_(), field("attendees", "People"), availability(), field("place", "Where"), field("notes", "Message", { multi: true })]
          : [Array.isArray(ask.accounts) && ask.accounts.length > 1 && c.from ? h("div", { class: "cv-dr-row" }, h("span", { class: "cv-dr-key" }, "From"), h("span", { class: "cv-dr-val mono" }, untrusted(c.from, 200))) : null,
            field("to", "To", { mono: true }), field("cc", "Cc", { mono: true }), field("subject", "Subject"), field("body", "Message", { multi: true }), attachments()])),
      state.failed ? h("div", { class: "cv-dr-note" }, h("span", { class: "cv-mark cv-mark-failed", "aria-hidden": "true" }), state.failed) : null,
      h("div", { class: "gate-actions cv-ask-actions cv-dr-actions" }, primary,
        cover ? h("span", { class: "cv-dr-cover", "aria-live": "polite" }, cover) : h("span", { class: "cv-dr-cover", "aria-live": "polite" }),
        h("button", { class: "btn btn-ghost cv-ask-btn cv-dr-discard", type: "button", "data-act": "discard", disabled: !!state.busy, "aria-keyshortcuts": "D", onclick: discard },
          state.busy === "discard" ? busyLabel("Discarding") : ["Discard", keyHint("D")])),
      h("div", { class: "cv-dr-hint" }, phone ? "Tap a line to change it. Nothing leaves until you press Send." : "Every line is a field: click to change it. Nothing leaves until you press Send."),
      state.problem ? problemLine(state.problem) : null);
  }

  el.update = (/** @type {any} */ a) => { Object.assign(ask, a); if (!state.done && !state.busy && !el.querySelector?.("[data-field]:focus")) draw(); };
  el.answered = (/** @type {string} */ decision, /** @type {any} */ _answers, /** @type {any} */ from) => {
    if (!state.done && from) state.from = from;
    if (!state.done) state.done = decision === "allow" || decision === "always" ? "sent" : decision === "deny" ? "discarded" : "withdrawn";
    state.busy = null; state.problem = null; draw();
  };
  el.isOpen = () => !state.done;
  /** A key routed here by the session (focus not in a text field). */
  el.onKey = (/** @type {KeyboardEvent} */ e) => {
    if (state.done || state.busy) return false;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { send(); return true; }
    if ((e.key === "d" || e.key === "D") && !e.metaKey && !e.ctrlKey && !e.altKey) { discard(); return true; }
    return false;
  };
  // A presence session opened or ended: redraw the line and the Send label, unless a field is being typed in.
  const onPresence = () => { if (state.done) window.removeEventListener("deck:presence", onPresence); else if (el.isConnected && !state.busy) label_(), refreshCover(); };
  function refreshCover() { const c = /** @type {any} */ (el.querySelector?.(".cv-dr-cover")); if (c && !matched()) put(c, coverLine(ask.presence, word())); }
  window.addEventListener("deck:presence", onPresence);
  draw();
  return el;
}
