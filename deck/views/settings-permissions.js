// @ts-check
// Settings, Standing permissions: what Vyre may send, post or pay without asking each time, and what you asked to go
// out that has not gone yet. gate.said.list reads them (the person's own surfaces; names, addresses and amounts only);
// gate.said.add makes a standing permission yourself; gate.said.revoke takes one back at once. Taking permission away
// needs no proof and no confirmation, so Revoke is one tap. Nothing polls: it loads on open and after each change.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";
import { when, plural } from "../js/fmt.js";

export const KINDS = [["send", "Send"], ["post", "Post"], ["pay", "Pay"], ["act_out", "Do something outward"]];
const VERB = { send: "send to", post: "post to", pay: "pay", act_out: "do something outward for" };
const list = (/** @type {string} */ s) => String(s || "").split(/[,\n]/).map(x => x.trim()).filter(Boolean);

/** @param {any} d gate.said.list's answer @returns {{ id: string, kind: string, channel: string|null, to: string[], what: string, standing: boolean, agents: string[], limits: any, at: number, revoked: number|null, used: number|null, when: string|null }[]} */
export function intentsOf(d) {
  return (Array.isArray(d?.intents) ? d.intents : []).filter((/** @type {any} */ i) => i && typeof i.id === "string" && !i.revoked).map((/** @type {any} */ i) => ({
    id: String(i.id), kind: String(i.kind || ""), channel: i.channel ? String(i.channel) : null, to: Array.isArray(i.to) ? i.to.map(String) : [], what: i.what ? String(i.what) : "", standing: i.standing === true,
    agents: Array.isArray(i.agents) ? i.agents.map(String) : [], limits: i.limits && typeof i.limits === "object" ? i.limits : null, at: Number(i.at) || 0, revoked: null, used: i.used ? Number(i.used) : null, when: i.when ? String(i.when) : null }));
}

/** One permission in a sentence: who, what it may do, to what, with its limit. @param {ReturnType<typeof intentsOf>[number]} i */
export function sentence(i) {
  const who = i.agents.length ? i.agents.join(", ") : "Any of your agents";
  const to = i.to.length ? i.to.join(", ") : "";
  const via = i.channel ? ` on ${i.channel}` : "";
  const cap = i.limits && Number(i.limits.max_amount) > 0 ? `, up to ${i.limits.max_amount} ${String(i.limits.currency || "").toUpperCase()}`.trimEnd() : "";
  const what = i.what ? ` (${i.what})` : "";
  return `${who} may ${VERB[/** @type {keyof typeof VERB} */ (i.kind)] || i.kind} ${to}${via}${cap}${what}`.replace(/\s+/g, " ").trim();
}

/** @param {HTMLElement} el @param {{ alive: () => boolean, on?: (t: string, fn: (e: any) => void) => void }} ctx @param {{ attempt?: typeof apiAttempt }} [deps] */
export async function drawPermissions(el, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const st = { items: /** @type {ReturnType<typeof intentsOf>} */ ([]), error: /** @type {any} */ (null), adding: false, busy: "", problem: /** @type {string|null} */ (null), agents: /** @type {string[]} */ ([]) };

  async function load() {
    const r = await attempt("gate.said.list", {});
    if (!ctx.alive()) return;
    st.error = r.error || null;
    st.items = r.error ? [] : intentsOf(r.data);
    draw();
  }
  async function revoke(/** @type {string} */ id) {
    st.busy = id; complain(null); draw();
    const r = await attempt("gate.said.revoke", { id });
    st.busy = "";
    if (r.error) { complain(String(r.error.message || "That did not go through.")); draw(); return; }
    await load();
  }
  async function openForm() {
    st.adding = true; draw();
    if (!st.agents.length) { const a = await attempt("agents.list", {}); if (ctx.alive()) { st.agents = (Array.isArray(a.data) ? a.data : a.data?.agents || []).filter((/** @type {any} */ x) => x && x.kind !== "assistant").map((/** @type {any} */ x) => String(x.name)); draw(); } }
  }

  // One alert line that outlives redraws, so a form complaint does not wipe what was typed.
  const note = h("p", { class: "small muted", role: "alert", "data-note": "1" });
  const complain = (/** @type {string|null} */ msg) => { st.problem = msg; note.replaceChildren(); if (msg) note.append(msg); };

  const row = (/** @type {ReturnType<typeof intentsOf>[number]} */ i) => h("div", { class: "set-row", "data-intent": i.id },
    h("div", { class: "set-k" }, i.standing ? "Always" : "Once"),
    h("div", { class: "set-v tm-col" }, h("span", null, sentence(i)),
      h("span", { class: "small faint" }, [i.standing ? "Standing permission" : i.when ? `Asked for ${i.when}` : "Asked for", i.at ? `added ${when(i.at)}` : "", i.used ? `used ${when(i.used)}` : ""].filter(Boolean).join(" · ")),
      h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "revoke", disabled: st.busy === i.id, "aria-label": `Take back: ${sentence(i)}`, onclick: () => revoke(i.id) }, st.busy === i.id ? "Taking back" : "Take back")));

  function form() {
    const kind = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", "aria-label": "What it may do", "data-f": "kind" }, KINDS.map(([v, t]) => h("option", { value: v }, t))));
    const channel = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "Where", placeholder: "Where, like slack (optional)", autocomplete: "off", "data-f": "channel" }));
    const to = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "To", placeholder: "Exact addresses or channels, separated by commas", autocomplete: "off", "data-f": "to" }));
    const what = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "What for", placeholder: "What for (optional)", autocomplete: "off", "data-f": "what" }));
    const agents = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "Which agents", placeholder: st.agents.length ? `Which of your agents, like ${st.agents.slice(0, 2).join(", ")} (blank means any)` : "Which agents (blank means any of yours)", autocomplete: "off", "data-f": "agents" }));
    const amount = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "Most per payment", placeholder: "Most per payment (pay only)", inputmode: "decimal", autocomplete: "off", "data-f": "amount" }));
    const currency = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "Currency", placeholder: "USD", autocomplete: "off", "data-f": "currency" }));
    return h("form", { class: "set-form tm-add", "data-form": "permission", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const recipients = list(to.value);
      if (!recipients.length) { complain("Name who or where it may go: at least one exact address or channel."); return; }
      /** @type {any} */ const input = { kind: kind.value, to: recipients };
      if (channel.value.trim()) input.channel = channel.value.trim();
      if (what.value.trim()) input.what = what.value.trim();
      if (list(agents.value).length) input.agents = list(agents.value);
      if (kind.value === "pay") {
        const n = Number(amount.value);
        if (!(n > 0 && Number.isFinite(n))) { complain("A payment permission needs a most-per-payment amount above zero."); return; }
        input.limits = { max_amount: n, ...(currency.value.trim() ? { currency: currency.value.trim().toUpperCase() } : {}) };
      }
      st.busy = "add"; complain(null); draw();
      // A pay permission, or one with no named agent, opens a path the charter puts proof on: ask for it as a send does.
      const r = await attempt("gate.said.add", input, kind.value === "pay" || !input.agents ? { presence: true } : { presence: "asked" });
      st.busy = "";
      if (r.error) { complain(String(r.error.message || "That did not go through.")); draw(); return; }
      st.adding = false; await load();
    } },
      h("div", { class: "rows" }, ...[["What it may do", kind], ["Where", channel], ["To", to], ["What for", what], ["Which agents", agents], ["Most per payment", amount], ["Currency", currency]].map(([k, c]) => h("div", { class: "set-row" }, h("div", { class: "set-k" }, String(k)), h("div", { class: "set-v" }, /** @type {any} */ (c))))),
      h("div", { class: "set-actions" }, h("button", { class: "btn btn-primary", type: "submit", "data-act": "add-go", disabled: st.busy === "add" }, "Allow it"),
        h("button", { class: "btn btn-ghost", type: "button", "data-act": "add-cancel", onclick: () => { st.adding = false; complain(null); draw(); } }, "Cancel")));
  }

  function draw() {
    if (st.error) { put(el, empty(st.error?.missing ? "Standing permissions are not on your server yet." : "Permissions could not be read.", st.error)); return; }
    const standing = st.items.filter(i => i.standing), once = st.items.filter(i => !i.standing);
    put(el,
      h("p", { class: "small muted" }, "What Vyre may send, post or pay without asking each time. A send or payment you did not ask for always asks you first. Taking permission back works at once."),
      note,
      standing.length ? h("div", { class: "rows" }, standing.map(row)) : h("div", { class: "empty" }, "No standing permissions. Vyre asks each time."),
      once.length ? h("div", null, h("p", { class: "lbl" }, `${plural(once.length, "thing")} you asked for that has not gone yet`), h("div", { class: "rows" }, once.map(row))) : null,
      st.adding ? form() : h("div", { class: "set-actions" }, h("button", { class: "btn btn-sm", type: "button", "data-act": "add", onclick: openForm }, "Add a permission")));
  }

  for (const t of ["gate.said", "gate.said-added", "gate.said-revoked", "said.recorded", "said.revoked"]) ctx.on?.(t, () => { void load(); });
  await load();
}
