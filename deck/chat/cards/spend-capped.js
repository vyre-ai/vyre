// @ts-check
// The line under a paused thread when a provider reached its daily cap (iq's spend.capped event):
// the words the box wrote, and "Raise it", which opens one small amount field. Raise calls spend.raise
// {provider, to} (the person's own surface; the provider comes from the event, the amount from the field,
// the tool is fixed here and never the one the event names). A quiet row, not a card: nothing is held on it,
// and the thread goes on when it is resumed. Data, from the event: { provider, day, spent, cap, line, thread?, agent?, action? }.

import { h, put } from "../../js/dom.js";
import { attempt } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { ensureCss, problemText } from "./kit.js";

const usd = (/** @type {number} */ n) => `$${Number(n).toFixed(2)}`;

/** @param {any} data @param {{ onRaised?: (cap: number|null) => void }} [ctx] @returns {HTMLElement} */
export function spendCapped(data, ctx = {}) {
  ensureCss("spend-capped");
  const provider = String(data?.provider || "claude");
  const el = /** @type {any} */ (h("div", { class: "cv-row cv-spend", role: "status", "aria-live": "polite" }));
  el._kind = "assistant";
  el._ts = data?.at ?? null;
  const suggested = Number(data?.action?.input?.to) > 0 ? Number(data.action.input.to) : Math.ceil(Number(data?.cap || 0) * 2) || 10;
  const st = { open: false, busy: false, error: /** @type {any} */ (null), raised: /** @type {number|null|undefined} */ (undefined) };

  async function raise(/** @type {string} */ raw, off = false) {
    const n = Number(String(raw).replace(/^\$/, "").trim());
    if (!off && !(n > 0 && Number.isFinite(n))) { st.error = "Enter an amount in dollars, more than zero."; draw(); return; }
    st.busy = true; st.error = null; draw();
    const r = await attempt("spend.raise", off ? { provider, off: true } : { provider, to: Math.round(n * 100) / 100 });
    st.busy = false;
    if (r.error) st.error = r.error.missing ? "Spend caps are not on this box." : r.error;
    else { st.raised = r.data?.cap ?? null; st.open = false; ctx.onRaised?.(st.raised); }
    draw();
  }

  function draw() {
    const line = st.raised !== undefined ? (st.raised === null ? `${provider[0].toUpperCase()}${provider.slice(1)} has no daily cap now.` : `${provider[0].toUpperCase()}${provider.slice(1)} daily cap is ${usd(st.raised)}. Resume the thread to go on.`) : String(data?.line || "This thread is paused: the daily spend cap was reached.");
    const amount = /** @type {HTMLInputElement} */ (h("input", { class: "input cv-spend-amount", inputmode: "decimal", autocomplete: "off", "aria-label": "New daily cap in dollars", value: String(suggested) }));
    put(el,
      h("div", { class: "cv-spend-row" },
        h("span", { class: "cv-spend-ico", "aria-hidden": "true" }, icon(st.raised !== undefined ? "check" : "clock", 16)),
        h("span", { class: "cv-spend-line", title: line }, line),
        st.raised === undefined && !st.open ? h("button", { class: "btn btn-sm cv-spend-raise", type: "button", "data-act": "raise", onclick: () => { st.open = true; draw(); } }, String(data?.action?.label || "Raise it")) : null),
      st.open ? h("form", { class: "cv-spend-form", onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); void raise(amount.value); } },
        h("span", { class: "small muted" }, "Daily cap, dollars"), h("span", { class: "cv-spend-usd", "aria-hidden": "true" }, "$"), amount,
        h("button", { class: "btn btn-primary btn-sm", type: "submit", "data-act": "set", disabled: st.busy }, st.busy ? "Raising" : "Raise"),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "off", disabled: st.busy, onclick: () => raise("", true) }, "No cap"),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "cancel", onclick: () => { st.open = false; st.error = null; draw(); } }, "Cancel")) : null,
      st.error ? h("div", { class: "cv-spend-problem" }, typeof st.error === "string" ? st.error : "That did not go through. " + problemText(st.error)) : null);
    if (st.open) queueMicrotask?.(() => amount.focus?.());
  }
  draw();
  return el;
}
