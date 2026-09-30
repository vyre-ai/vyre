// @ts-check
// Settings, Spend: today's spend (UTC) per provider against its daily cap, and a way to change the cap.
// spend.summary reads it; spend.raise {provider, to | off: true} changes it (the person's own surfaces;
// the change takes effect at once). Nothing polls: it loads on open and after spend.capped and
// spend.raised. On a box with no spend module one plain line says so.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";

const usd = (/** @type {number} */ n) => `$${Number(n).toFixed(2)}`;
export const EVENTS = ["spend.capped", "spend.raised"];

/** @param {any} d spend.summary's answer @returns {{ provider: string, spent: number, cap: number|null, capped: boolean, calls: number, estimated: boolean }[]} */
export function providersOf(d) {
  const all = d?.all && typeof d.all === "object" ? [{ provider: "all", spent: d.all.spent, cap: d.all.cap, capped: d.all.capped, calls: 0, estimated: false }] : [];
  return [...all, ...(Array.isArray(d?.providers) ? d.providers : [])].filter((/** @type {any} */ p) => p && typeof p.provider === "string").map((/** @type {any} */ p) => ({
    provider: String(p.provider), spent: Number(p.spent) || 0, cap: typeof p.cap === "number" && p.cap > 0 ? p.cap : null, capped: p.capped === true, calls: Number(p.calls) || 0, estimated: p.estimated === true }));
}

/** @param {HTMLElement} el @param {{ alive: () => boolean, on: (t: string, fn: (e: any) => void) => void }} ctx @param {{ attempt?: typeof apiAttempt }} [deps] */
export async function drawSpend(el, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const st = { rows: /** @type {ReturnType<typeof providersOf>} */ ([]), day: "", error: /** @type {any} */ (null), editing: "", busy: false, problem: /** @type {string|null} */ (null) };

  async function load() {
    const r = await attempt("spend.summary", {});
    if (!ctx.alive()) return;
    st.error = r.error || null;
    st.rows = r.error ? [] : providersOf(r.data);
    st.day = r.error ? "" : String(r.data?.day || "");
    draw();
  }
  async function save(/** @type {string} */ provider, /** @type {string} */ raw, off = false) {
    const n = Number(String(raw).replace(/^\$/, "").trim());
    if (!off && !(n > 0 && Number.isFinite(n))) { st.problem = "Enter an amount in dollars, more than zero, or choose No cap."; draw(); return; }
    st.busy = true; st.problem = null; draw();
    const r = await attempt("spend.raise", off ? { provider, off: true } : { provider, to: Math.round(n * 100) / 100 });
    st.busy = false;
    if (r.error) { st.problem = r.error.missing ? "Spend caps are not on this box." : String(r.error.message || "That did not go through."); draw(); return; }
    st.editing = ""; await load();
  }

  function row(/** @type {ReturnType<typeof providersOf>[number]} */ p) {
    const name = p.provider === "all" ? "All providers together" : p.provider[0].toUpperCase() + p.provider.slice(1);
    const words = p.cap == null ? `${usd(p.spent)} today, no cap` : `${usd(p.spent)} of ${usd(p.cap)} today${p.capped ? ", paused" : ""}`;
    if (st.editing === p.provider) {
      const amount = /** @type {HTMLInputElement} */ (h("input", { class: "input", inputmode: "decimal", autocomplete: "off", "aria-label": `${name} daily cap in dollars`, value: p.cap == null ? "" : String(p.cap), placeholder: "Dollars a day" }));
      return h("form", { class: "set-row", "data-provider": p.provider, onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); void save(p.provider, amount.value); } },
        h("div", { class: "set-k" }, name), h("div", { class: "set-v" }, amount,
          h("button", { class: "btn btn-primary btn-sm", type: "submit", "data-act": "set", disabled: st.busy }, "Set cap"),
          h("button", { class: "btn btn-sm", type: "button", "data-act": "off", disabled: st.busy, onclick: () => save(p.provider, "", true) }, "No cap"),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "cancel", onclick: () => { st.editing = ""; st.problem = null; draw(); } }, "Cancel"),
          st.problem ? h("span", { class: "small muted", role: "alert" }, st.problem) : null));
    }
    return h("div", { class: "set-row", "data-provider": p.provider },
      h("div", { class: "set-k" }, name),
      h("div", { class: "set-v" }, h("span", null, words), p.estimated ? h("span", { class: "small faint" }, " · estimated from tokens") : null,
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "edit", onclick: () => { st.editing = p.provider; st.problem = null; draw(); } }, "Change cap")));
  }

  function draw() {
    if (st.error) { put(el, empty(st.error?.missing ? "Spend is not tracked on this box yet." : "Spend could not be read.", st.error)); return; }
    put(el,
      h("p", { class: "small muted" }, `Today, ${st.day || "UTC"} (UTC). At a provider's daily cap its work pauses with one line saying how to raise it; nothing asks first.`),
      st.rows.length ? st.rows.map(row) : h("div", { class: "empty" }, "Nothing spent today."));
  }

  for (const type of EVENTS) ctx.on(type, () => { void load(); });
  await load();
}
