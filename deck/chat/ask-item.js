// @ts-check
// A permission question, inline: what the session wants to do, Allow or Deny. Answered asks
// disappear from threads.asks and the card is dropped by session.js when ask.answered arrives.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";

/** @param {{ id: string, tool: string, summary: string, destination: string|null, reason: string|null }} ask */
export function askCard(ask) {
  const el = h("div", { class: "ask-card" });
  let busy = false;
  const answer = async decision => {
    busy = true; draw();
    await attempt("threads.answer", { ask: ask.id, decision });
  };
  function draw() {
    put(el,
      h("div", { class: "gate-row" }, h("span", { class: "lbl", style: { color: "var(--beacon-ink)" } }, "Needs you"), h("span", { class: "code" }, ask.tool)),
      h("p", { class: "body", style: { margin: 0 } }, ask.summary || ask.tool),
      ask.destination ? h("div", { class: "code" }, "→ " + ask.destination) : null,
      ask.reason ? h("div", { class: "gate-note" }, ask.reason) : null,
      h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary btn-sm", disabled: busy, onclick: () => answer("allow") }, icon("check", 13), "Allow"),
        h("button", { class: "btn btn-ghost btn-sm", disabled: busy, onclick: () => answer("deny") }, "Deny"),
      ),
    );
  }
  draw();
  return el;
}
