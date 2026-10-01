// @ts-check
// The watcher card (app-design chat-components.html section 16): before a watcher runs on its own, the person reads
// what it will do and turns it on. Three plain sentences (When, Check, Then) say it, in the author's words when it has
// them; the facts underneath are the runtime's own claims from the code and are drawn exactly as given: Reads (readsText
// first, then the list), Uses (one chip per credential: host and item name, names only), Acts, Cost, Runs. Nothing is
// reworded or trimmed, and the author's text is never put where a fact goes.
//
// Reads `watchers.card {name}`. Turn on is `watchers.create {name, hash}` with the card's own hash; the box refuses it
// when the code changed after the card was shown, and the card says so and offers "Show the new card": it never turns on
// a different version than the one read. Turn off is `watchers.pause {name}`, on again `watchers.resume {name}`. A duty a
// teammate proposed passes its own `turnOn` (team.duties.enable with the instruction shown), since that is how a duty starts.
// Not on a person's surface (untrusted output): no buttons, the card only reads.

import { h, put } from "../../js/dom.js";
import { attempt } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { ensureCss, shell, problemText } from "./kit.js";

/** @param {any} d watchers.card's answer @returns {any|null} */
export function cardOf(d) {
  if (!d || typeof d.name !== "string") return null;
  const f = d.facts && typeof d.facts === "object" ? d.facts : {};
  const l = d.lines && typeof d.lines === "object" ? d.lines : {};
  return { name: d.name, hash: String(d.hash || ""), state: String(d.state || "draft"), owner: d.owner && typeof d.owner === "object" ? d.owner : null, described: d.described === "by its author" ? "by its author" : "by Vyre",
    lines: { when: l.when ? String(l.when) : "", check: l.check ? String(l.check) : "", do: l.do ? String(l.do) : "" },
    facts: { reads: Array.isArray(f.reads) ? f.reads.map(String) : [], readsText: f.readsText ? String(f.readsText) : "", credentials: (Array.isArray(f.credentials) ? f.credentials : []).filter((/** @type {any} */ c) => c && (c.item || c.host)).map((/** @type {any} */ c) => ({ host: String(c.host || ""), item: String(c.item || "") })),
      acts: f.acts ? String(f.acts) : "", cost: f.cost ? String(f.cost) : "", schedule: f.schedule ? String(f.schedule) : "" } };
}

/** "Owned by the intake project" / "Owned by kit". @param {any} o */
export const ownerWords = o => (!o ? "" : o.kind === "teammate" ? `Owned by ${o.teammate}` : `Owned by the ${o.project} project`);

/**
 * @param {{ name: string, card?: any }} data
 * @param {{ readOnly?: boolean, turnOn?: (card: any) => Promise<{ data?: any, error?: any }>, onDone?: () => void }} [ctx]
 * @returns {HTMLElement & { update: (d: any) => void, reload: () => Promise<void> }}
 */
export function watcherCard(data, ctx = {}) {
  ensureCss("watcher");
  const el = /** @type {any} */ (shell("cv-watcher", "Watcher"));
  /** @type {any} */ let card = data?.card ? cardOf(data.card) : null;
  const st = { loading: !card, error: /** @type {any} */ (null), busy: false, changed: false, note: /** @type {string|null} */ (null) };
  const name = String(data?.name || card?.name || "");

  async function reload() {
    st.loading = true; st.error = null; st.changed = false; draw();
    const r = await attempt("watchers.card", { name });
    st.loading = false;
    if (r.error) st.error = r.error; else card = cardOf(r.data);
    if (!card && !r.error) st.error = "There is no card for that watcher.";
    draw();
  }
  async function turnOn() {
    if (!card || st.busy) return;
    st.busy = true; st.error = null; st.note = null; draw();
    const r = await (ctx.turnOn ? ctx.turnOn(card) : attempt("watchers.create", { name: card.name, hash: card.hash }));
    st.busy = false;
    if (r.error) {
      // The code moved since the card was shown: never turn on the other version; offer the new card.
      if (/changed after its card was shown/i.test(String(r.error.message || ""))) st.changed = true; else st.error = r.error;
      draw(); return;
    }
    card = { ...card, state: "on" }; ctx.onDone?.(); draw();
  }
  async function toggle(/** @type {"pause"|"resume"} */ verb) {
    if (!card || st.busy) return;
    st.busy = true; st.error = null; draw();
    // Back on carries the hash of the card that was read, like Turn on: a paused watcher whose code changed never restarts on unseen code.
    const r = await attempt("watchers." + verb, verb === "resume" ? { name: card.name, hash: card.hash } : { name: card.name });
    st.busy = false;
    if (r.error) { if (/changed after its card was shown/i.test(String(r.error.message || ""))) st.changed = true; else st.error = r.error; }
    else card = { ...card, state: verb === "pause" ? "paused" : "on" };
    draw();
  }

  const lineRow = (/** @type {string} */ label, /** @type {string} */ text) => (text ? h("div", { class: "cv-wc-line" }, h("span", { class: "cv-wc-k" }, label), h("span", { class: "cv-wc-v" }, text)) : null);
  const factRow = (/** @type {string} */ label, /** @type {any} */ body) => (body ? h("div", { class: "cv-wc-fact" }, h("span", { class: "cv-wc-k" }, label), h("span", { class: "cv-wc-v" }, body)) : null);

  function draw() {
    if (st.loading) { put(el, h("div", { class: "cv-wc-head" }, h("span", { class: "cv-wc-name" }, name)), h("p", { class: "small faint cv-wc-pad" }, "Reading what it will do…")); return; }
    if (!card) { put(el, h("div", { class: "cv-wc-head" }, h("span", { class: "cv-wc-name" }, name)), h("p", { class: "small muted cv-wc-pad", role: "alert" }, st.error ? problemText(st.error) : "There is no card for that watcher.")); return; }
    const on = card.state === "on", paused = card.state === "paused";
    if (st.changed) {
      put(el, h("div", { class: "cv-wc-head" }, h("span", { class: "cv-wc-name" }, `${card.name} changed`)),
        h("p", { class: "small cv-wc-pad", role: "alert" }, "The watcher's code changed since you read it, so it was not turned on. Read the new card and turn it on again."),
        h("div", { class: "cv-wc-actions" }, h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "reload", onclick: () => reload() }, "Show the new card")));
      return;
    }
    const f = card.facts;
    const hasFacts = f.readsText || f.reads.length || f.credentials.length || f.acts || f.cost || f.schedule;
    put(el,
      h("div", { class: "cv-wc-head" }, h("span", { class: "cv-wc-name" }, card.name),
        card.owner ? h("span", { class: "tag ml-quiet cv-wc-owner" }, ownerWords(card.owner)) : null,
        h("span", { class: "cv-wc-sp" }), h("span", { class: "small cv-wc-state", "data-state": card.state }, on ? h("span", { class: "cv-wc-dot", "aria-hidden": "true" }) : null, on ? "on" : paused ? "paused" : "off")),
      h("div", { class: "cv-wc-lines" }, lineRow("When", card.lines.when), lineRow("Check", card.lines.check), lineRow(card.lines.check ? "Then" : "Do", card.lines.do)),
      hasFacts ? h("div", { class: "cv-wc-facts" }, h("div", { class: "cv-wc-facts-h" }, "What it will do, as Vyre reads its code"),
        factRow("Reads", [f.readsText, f.reads.length ? f.reads.join(", ") : ""].filter(Boolean).join(" · ") || null),
        factRow("Uses", f.credentials.length ? h("span", { class: "cv-wc-chips" }, f.credentials.map((/** @type {any} */ c) => h("span", { class: "code cv-wc-chip" }, icon("key", 12), [c.host, c.item].filter(Boolean).join(" · ")))) : null),
        factRow("Acts", f.acts), factRow("Cost", f.cost), factRow("Runs", f.schedule)) : null,
      h("p", { class: "small faint cv-wc-prov" }, card.described === "by its author" ? "These three sentences are the author's words. The facts above are what Vyre found in the code." : "Described by Vyre from its code."),
      ctx.readOnly ? null : on
        ? h("div", { class: "cv-wc-actions" }, h("span", { class: "small" }, "On."), h("button", { class: "btn btn-sm", type: "button", "data-act": "off", disabled: st.busy, onclick: () => toggle("pause") }, "Turn off"))
        : paused ? h("div", { class: "cv-wc-actions" }, h("span", { class: "small muted" }, "Paused."), h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "resume", disabled: st.busy, onclick: () => toggle("resume") }, "Turn back on"))
        : h("div", { class: "cv-wc-actions" }, h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "on", disabled: st.busy, onclick: turnOn }, st.busy ? "Turning on" : "Turn on"),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "later", onclick: () => { el.remove?.(); ctx.onDone?.(); } }, "Not now")),
      st.error ? h("p", { class: "small muted cv-wc-pad", role: "alert" }, typeof st.error === "string" ? st.error : "That did not go through. " + problemText(st.error)) : null);
  }
  el.update = (/** @type {any} */ d) => { if (d?.card) card = cardOf(d.card); draw(); };
  el.reload = reload;
  if (card) draw(); else { draw(); void reload(); }
  return el;
}
