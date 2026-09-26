// @ts-check
// A held Gate item, inline: exactly what Send will send, editable in place, never behind a
// separate Edit surface (docs/work/gate-chat.md's pivot note — this carries the Mattermost-era
// rule forward). Editing a field debounces into gate.revise; Send calls gate.approve with the
// current fields; Discard calls gate.reject. Once resolved (sent/rejected/failed-and-retried),
// the card loses every control and just says what happened.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when } from "../js/fmt.js";
import { renderDiff } from "./lib/diff.js";

const FIELD_ORDER = ["to", "cc", "bcc", "subject", "url", "method", "body"];
const LONG = new Set(["body"]);

/**
 * @param {{ id: string }} held minimal: {id} from a gate.held row or a gate.held/gate.revised event
 * @returns {HTMLElement} a live element; call .refresh() on it (attached) to reload from gate.get
 */
export function gateCard(held) {
  const el = h("div", { class: "gate-card" });
  let timer = null;
  const state = { item: null, dirty: {}, busy: false };

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

  function scheduleRevise() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!Object.keys(state.dirty).length) return;
      const edited = { ...state.dirty };
      state.busy = true; draw();
      const r = await attempt("gate.revise", { id: held.id, edited });
      state.busy = false;
      if (!r.error) { state.item = r.data; state.dirty = {}; }
      draw();
    }, 500);
  }

  async function send() {
    state.busy = true; draw();
    const edited = Object.keys(state.dirty).length ? { ...state.dirty } : undefined;
    const r = await attempt("gate.approve", edited ? { id: held.id, edited } : { id: held.id });
    state.busy = false;
    if (r.error) { state.item = { ...state.item, error: r.error.message }; draw(); return; }
    state.item = r.data.result || state.item; await load();
  }

  async function discard() {
    state.busy = true; draw();
    await attempt("gate.reject", { id: held.id });
    await load();
  }

  function draw() {
    if (!state.item) return;
    const it = state.item;
    if (it.state === "sent" || it.state === "rejected") {
      put(el,
        h("div", { class: "gate-row" }, kindBadge(it.kind), h("span", { class: "code" }, it.via), h("span", { style: { flexGrow: "1" } }), h("span", { class: "when" }, when(it.at))),
        h("div", { class: "gate-resolved" }, icon(it.state === "sent" ? "check" : "close", 14), it.state === "sent" ? "Sent" : "Discarded"),
      );
      return;
    }
    const content = it.final || it.draft || {};
    const keys = [...FIELD_ORDER.filter(k => k in content || k === "to"), ...Object.keys(content).filter(k => !FIELD_ORDER.includes(k))];
    put(el,
      h("div", { class: "gate-row" }, kindBadge(it.kind), h("span", { class: "code" }, it.via), it.why ? h("span", { class: "code" }, "· " + it.why) : null),
      ...keys.map(k => field(k)),
      it.diff && (it.diff.removed?.length || it.diff.added?.length) ? h("div", null, h("div", { class: "code", style: { marginBottom: "4px" } }, "changed from the draft"), renderDiff(String(it.draft?.body ?? ""), String(it.final?.body ?? content.body ?? ""))) : null,
      it.error ? h("div", { class: "gate-note" }, h("span", { class: "code" }, "failed: " + it.error), " Send tries again.") : null,
      h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary btn-sm", disabled: state.busy, onclick: send }, icon("send", 13), "Send"),
        h("button", { class: "btn btn-ghost btn-sm", disabled: state.busy, onclick: discard }, "Discard"),
        state.busy ? h("span", { class: "code" }, "…") : null,
      ),
    );
  }

  function field(key) {
    const val = fieldValue(key);
    const input = LONG.has(key)
      ? h("textarea", { class: "input", value: val, oninput: e => { state.dirty[key] = /** @type {any} */ (e.target).value; scheduleRevise(); } })
      : h("input", { class: "input", type: "text", value: val, oninput: e => { state.dirty[key] = /** @type {any} */ (e.target).value; scheduleRevise(); } });
    return h("div", { class: "gate-field" }, h("label", null, key), input);
  }

  el.refresh = load;
  load();
  return el;
}

function kindBadge(kind) {
  return h("span", { class: "tag" }, kind === "send" ? "SEND" : kind === "spend" ? "SPEND" : "DELETE");
}
