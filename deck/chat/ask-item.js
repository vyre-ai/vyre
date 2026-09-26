// @ts-check
// A permission question, inline: what the session wants to do, Allow or Deny. Shape matched to
// the Capsule's (capsule teammate, 2026-09-27): "<agent> asks to <summary>", a Tool/Where grid,
// ALLOW primary with a keycap, DENY a quiet ghost. threads.answer is on the floor's human-only
// list (core/presence/index.js), so the answer carries a passkey proof. Once answered, here or on
// another screen (session.js calls .answered on ask.answered), the card loses its buttons and says
// what was decided; a failure says why and gives the buttons back.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { problemLine } from "./presence.js";

/** @param {{ id: string, tool: string, summary: string, destination: string|null, reason: string|null, agent?: string|null }} ask */
export function askCard(ask) {
  const el = h("div", { class: "ask-card" });
  const state = { busy: false, decided: /** @type {string|null} */ (null), error: /** @type {any} */ (null) };
  const answer = async decision => {
    if (state.busy || state.decided) return;
    state.busy = true; state.error = null; draw();
    const r = await attempt("threads.answer", { ask: ask.id, decision, surface: "deck" }, { presence: true });
    state.busy = false;
    if (r.error) state.error = r.error; else state.decided = decision;
    draw();
  };
  function draw() {
    const title = h("div", { class: "gate-row" }, h("span", { class: "ask-title" }, `${ask.agent || "This session"} asks to ${ask.summary || ask.tool}`));
    if (state.decided) {
      put(el, title, h("div", { class: "gate-resolved" }, icon(state.decided === "allow" ? "check" : "close", 14), state.decided === "allow" ? "Allowed" : "Denied"));
      el.classList.add("answered");
      return;
    }
    put(el, title,
      h("div", { class: "ask-grid" },
        h("span", { class: "gate-key" }, "Tool"), h("span", { class: "gate-val" }, ask.tool),
        ask.destination ? h("span", { class: "gate-key" }, "Where") : null, ask.destination ? h("span", { class: "gate-val" }, ask.destination) : null,
      ),
      ask.reason ? h("div", { class: "gate-note" }, ask.reason) : null,
      h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary", disabled: state.busy, onclick: () => answer("allow") }, "Allow", h("span", { class: "kbd" }, "⏎")),
        h("button", { class: "btn btn-ghost", disabled: state.busy, onclick: () => answer("deny") }, "Deny"),
      ),
      state.error ? problemLine(state.error) : null,
    );
  }
  /** Answered, maybe on another screen: ask.answered's decision ("allow" or "deny"). */
  /** @type {any} */ (el).answered = (/** @type {string} */ decision) => { state.busy = false; state.error = null; state.decided = decision === "allow" ? "allow" : "deny"; draw(); };
  draw();
  return el;
}
