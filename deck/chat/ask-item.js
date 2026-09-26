// @ts-check
// A permission question, inline: what the session wants to do, Allow or Deny. Shape matched to
// the Capsule's (capsule teammate, 2026-09-27): "<agent> asks to <summary>", a Tool/Where grid,
// ALLOW primary with a keycap, DENY a quiet ghost. Answered asks disappear from threads.asks and
// the card is dropped by session.js when ask.answered arrives.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";

/** @param {{ id: string, tool: string, summary: string, destination: string|null, reason: string|null, agent?: string|null }} ask */
export function askCard(ask) {
  const el = h("div", { class: "ask-card" });
  let busy = false;
  const answer = async decision => {
    busy = true; draw();
    await attempt("threads.answer", { ask: ask.id, decision });
  };
  function draw() {
    put(el,
      h("div", { class: "gate-row" }, h("span", { class: "ask-title" }, `${ask.agent || "This session"} asks to ${ask.summary || ask.tool}`)),
      h("div", { class: "ask-grid" },
        h("span", { class: "gate-key" }, "Tool"), h("span", { class: "gate-val" }, ask.tool),
        ask.destination ? h("span", { class: "gate-key" }, "Where") : null, ask.destination ? h("span", { class: "gate-val" }, ask.destination) : null,
      ),
      ask.reason ? h("div", { class: "gate-note" }, ask.reason) : null,
      h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary", disabled: busy, onclick: () => answer("allow") }, "Allow", h("span", { class: "kbd" }, "⏎")),
        h("button", { class: "btn btn-ghost", disabled: busy, onclick: () => answer("deny") }, "Deny"),
      ),
    );
  }
  draw();
  return el;
}
