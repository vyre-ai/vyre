// @ts-check
// A held Gate item, inline: exactly what Send will send, editable in place, never behind a
// separate Edit surface (docs/work/gate-chat.md's pivot note; this carries the Mattermost-era
// rule forward). Shape matched to the Capsule's (capsule teammate, 2026-09-27): a HELD FOR YOU
// badge, a To/Subject grid, a hairline, the body, everything contenteditable plaintext-only with
// a Signal underline on focus, SEND primary with a keycap, DISCARD a ghost button, no Edit button.
// Edits stay on the card until Send, which passes them as gate.approve's `edited` (only the fields
// that changed). They are not saved one keystroke at a time through gate.revise: gate.revise,
// gate.approve and gate.reject are all on the floor's human-only list (core/presence/index.js,
// ADR 0004), so each would ask for a passkey. Send and Discard carry that proof. Once resolved
// (sent/rejected), the card loses every control and just says what happened; a failed send or a
// refused proof says why and leaves the buttons. While a presence session covers this device
// (js/api.js), one quiet line under the buttons says until when, and Send asks for no passkey.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when } from "../js/fmt.js";
import { renderDiff } from "./lib/diff.js";
import { problemLine } from "./presence.js";
import { presenceWord } from "../js/need-rows.js";
import { coverLine } from "../js/need-sheet.js";

// "to" and "subject" get the grid + mono treatment (email-shaped); anything else short goes in
// the same grid in field order; "body" (or the one remaining long field) sits under the hairline.
const GRID_ORDER = ["to", "cc", "bcc", "subject", "url", "method"];

/**
 * @param {{ id: string }} held minimal: {id} from a gate.held row or a gate.held/gate.revised event
 * @returns {HTMLElement} a live element; call .refresh() on it (attached) to reload from gate.get
 */
export function gateCard(held) {
  const el = h("div", { class: "gate-card" });
  const state = { item: /** @type {any} */ (null), dirty: /** @type {Record<string, string>} */ ({}), busy: false, problem: /** @type {any} */ (null) };

  async function load() {
    const r = await attempt("gate.get", { id: held.id });
    if (r.error) { put(el, h("div", { class: "empty" }, "This item is gone.")); return; }
    state.item = r.data;
    draw();
  }

  function fieldValue(key) {
    if (key in state.dirty) return state.dirty[key];
    const content = state.item.final || state.item.draft || {};
    if (key === "to") return Array.isArray(state.item.to) ? state.item.to.join(", ") : (state.item.to || "");
    return content[key] ?? "";
  }

  function edited(key, value) { state.dirty[key] = value; }

  /** The changed fields as gate.approve takes them: `to` as a list, as js/editable.js sends it. */
  function changes() {
    const out = /** @type {Record<string, any>} */ ({ ...state.dirty });
    if ("to" in out) out.to = String(out.to).split(",").map(s => s.trim()).filter(Boolean);
    return Object.keys(out).length ? out : undefined;
  }

  async function send() {
    if (state.busy) return;
    state.busy = true; state.problem = null; draw();
    const edits = changes();
    const r = await attempt("gate.approve", edits ? { id: held.id, edited: edits } : { id: held.id }, { presence: true });
    state.busy = false;
    // Refused (no proof, a cancelled passkey, a bad edit): nothing was sent, the edits stay.
    if (r.error) { state.problem = r.error; draw(); return; }
    // Approved but the sender failed: gate.js keeps it held with the edit as `final`, so reload it.
    state.dirty = {};
    await load();
    // gate.get carries the sender's error, which draw() shows; say it here only if it did not.
    if (r.data?.state === "failed" && state.item && !state.item.error) { state.problem = { message: "Not sent: " + (r.data.error || "the sender failed") + ". It is still held; Send tries again." }; draw(); }
  }

  async function discard() {
    if (state.busy) return;
    state.busy = true; state.problem = null; draw();
    const r = await attempt("gate.reject", { id: held.id }, { presence: "asked" });
    state.busy = false;
    if (r.error) { state.problem = r.error; draw(); return; }
    await load();
  }

  function draw() {
    if (!state.item) return;
    const it = state.item;
    if (it.state === "sent" || it.state === "rejected") {
      put(el,
        h("div", { class: "gate-row" }, h("span", { class: "who" }, it.summary || it.via), h("span", { style: { flexGrow: "1" } }), h("span", { class: "when" }, when(it.at))),
        h("div", { class: "gate-resolved" }, icon(it.state === "sent" ? "check" : "close", 14), it.state === "sent" ? "Sent" : "Discarded"),
      );
      return;
    }
    const content = it.final || it.draft || {};
    const gridKeys = GRID_ORDER.filter(k => k in content || k === "to");
    const longKeys = Object.keys(content).filter(k => !GRID_ORDER.includes(k));
    put(el,
      h("div", { class: "gate-row" },
        h("span", { class: "gate-title" }, it.summary || `${it.kind} via ${it.via}`),
        h("span", { class: "gate-badge" }, h("span", { class: "dot beacon" }), "Held for you"),
      ),
      gridKeys.length ? h("div", { class: "gate-grid" }, gridKeys.map(k => gridField(k))) : null,
      gridKeys.length && longKeys.length ? h("div", { class: "gate-rule" }) : null,
      ...longKeys.map(k => longField(k)),
      it.why ? h("div", { class: "gate-note" }, it.why) : null,
      it.diff && (it.diff.removed?.length || it.diff.added?.length) ? h("div", null, h("div", { class: "code", style: { marginBottom: "4px" } }, "changed from the draft"), renderDiff(String(it.draft?.body ?? ""), String(it.final?.body ?? content.body ?? ""))) : null,
      it.error ? h("div", { class: "gate-note" }, h("span", { class: "code" }, "failed: " + it.error), " Send tries again.") : null,
      h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary", disabled: state.busy, onclick: send }, "Send", h("span", { class: "kbd" }, "⌘⏎")),
        h("button", { class: "btn btn-ghost", disabled: state.busy, onclick: discard }, "Discard"),
        state.busy ? h("span", { class: "code" }, "…") : null,
      ),
      cover(it),
      state.problem ? problemLine(state.problem) : null,
    );
  }

  /** "Touch ID covers sends until 14:32" while this device's presence session covers Send, else nothing. */
  function cover(/** @type {any} */ it) {
    const t = coverLine(it.presence, presenceWord(navigator.userAgent, navigator.maxTouchPoints || 0));
    return t ? h("div", { class: "gate-note gate-cover" }, t) : null;
  }

  function editableProps(key) {
    return {
      contenteditable: "plaintext-only", spellcheck: "false",
      oninput: e => edited(key, /** @type {any} */ (e.target).textContent || ""),
      onkeydown: e => { if (key !== "body" && /** @type {KeyboardEvent} */ (e).key === "Enter") e.preventDefault(); },
    };
  }

  function gridField(key) {
    const val = fieldValue(key);
    return h("div", { class: "gate-grid-row" },
      h("span", { class: "gate-key" }, key),
      h("span", { class: "gate-val" + (key === "to" ? " mono" : ""), ...editableProps(key) }, val),
    );
  }

  function longField(key) {
    return h("div", { class: "gate-body", ...editableProps(key) }, fieldValue(key));
  }

  // A presence session opened or ended (a Send elsewhere, or this one): redraw the cover line.
  let shown = false;
  const onPresence = () => {
    if (el.isConnected) { shown = true; draw(); }
    else if (shown) window.removeEventListener("deck:presence", onPresence);
  };
  window.addEventListener("deck:presence", onPresence);

  el.refresh = load;
  load();
  return el;
}
