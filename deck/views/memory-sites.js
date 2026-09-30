// @ts-check
// Sites, a tab in Memory (/memory?tab=sites). What Vyre for Chrome learned about each website it works
// in: how a page is laid out, how to find its buttons, what its calls and flows do. Never a selector, a
// value or a page's text: the box sends names, counts, how sure it is and when it last checked.
//
// One screen. The list (memory.site.list), a site's rows on request (memory.site.detail), and Forget,
// which never asks first because every Forget can be undone for 24 hours:
//   - a whole site: memory.site.forget {key}; Undo is memory.site.restore {key}.
//   - one row of a site: memory.site.forget {key, part, id}; Undo is memory.site.restore {key, part, id}.
//   - Forget all: memory.site.forget {all: true}, after one "Forget all?" tap (the one place that asks);
//     Undo restores each site it took.
// Undo lives on the box (the tombstone), so it shows on any device and after any reload: the list answer's
// `forgotten` entries ({ key, name, part?, id?, label?, at, until }) are drawn as "Forgot X. Undo" lines at
// the top. A forget made on this screen leaves the same line in the place of the row or site it took.
// A family asks once, with the count of sites it covers, since it touches several.
// "Wrong?" on an answer about a site is the ordinary memory.correct / memory.uncorrect path on the answer
// itself; nothing here re-implements it. Nothing polls: it loads on open and after each action.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";
import { plural } from "../js/fmt.js";
import { icon } from "../js/icons.js";

/** The part names memory.site.detail answers, in the order a person thinks of them. */
export const PARTS = [["flows", "Flows"], ["controls", "Controls"], ["api", "API calls"], ["notes", "Notes"], ["frames", "Frames"]];

/** "today", "2 days ago", "12 days ago" from a date (ISO text or ms); "" when there is none. @param {any} at */
export function ago(at, now = Date.now()) {
  const t = typeof at === "number" ? at : Date.parse(String(at || ""));
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, Math.floor((now - t) / 86400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
/** A site's host for the line under its name: an origin's host, else the key as it is. @param {string} key */
export function hostOf(key) { try { return new URL(key).host; } catch { return key.replace(/^family:/, ""); } }

/** @param {any} d memory.site.list's answer @returns {{ key: string, name: string, kind: string, family: string|null, updated: number, verified: string|null, counts: Record<string, number>, usedToWork: number }[]} */
export function sitesOf(d) {
  return (Array.isArray(d?.sites) ? d.sites : []).filter((/** @type {any} */ s) => s && typeof s.key === "string").map((/** @type {any} */ s) => ({
    key: String(s.key), name: String((Array.isArray(s.names) && s.names[0]) || s.key), kind: s.kind === "family" ? "family" : "origin", family: s.family ? String(s.family) : null,
    updated: Number(s.updated) || 0, verified: s.verified ? String(s.verified) : null, counts: s.counts && typeof s.counts === "object" ? s.counts : {}, usedToWork: Number(s.used_to_work) || 0 }));
}

/** "12 buttons, 3 things it can do, 2 notes" from a site's counts; nothing when it has none. @param {Record<string, number>} c */
export function countsLine(c) {
  const bits = [[c.controls, "control", "controls"], [c.flows, "flow", "flows"], [c.api, "API call", "API calls"], [c.notes, "note", "notes"]]
    .filter(([n]) => Number(n) > 0).map(([n, one, many]) => plural(Number(n), String(one), String(many)));
  return bits.length ? bits.join(", ") : "Nothing kept yet";
}

const errWords = (/** @type {any} */ e) => (e?.missing ? "Vyre Memory is not running on this box." : String(e?.message || e || "That did not go through."));
const pct = (/** @type {any} */ n) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "");

/** The box's own list of what can still be brought back: [{ key, name, part?, id?, label?, at, until }], newest first. @param {any} d */
export function forgottenOf(d) {
  return (Array.isArray(d?.forgotten) ? d.forgotten : []).filter((/** @type {any} */ f) => f && typeof f.key === "string").map((/** @type {any} */ f) => ({
    key: String(f.key), name: String(f.name || f.key), part: f.part ? String(f.part) : null, id: f.id != null ? String(f.id) : null, label: f.label ? String(f.label) : null, at: Number(f.at) || 0, until: Number(f.until) || 0 }));
}

/**
 * @param {HTMLElement} root @param {{ alive: () => boolean, on?: (t: string, fn: (e: any) => void) => void }} ctx
 * @param {{ attempt?: typeof apiAttempt }} [deps]
 */
export default async function sites(root, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  let stopped = false;
  const alive = () => !stopped && ctx.alive();
  const st = { list: /** @type {ReturnType<typeof sitesOf>} */ ([]), error: /** @type {any} */ (null), open: "", detail: /** @type {Record<string, any>} */ ({}), busy: "",
    problem: /** @type {string|null} */ (null), box: /** @type {ReturnType<typeof forgottenOf>} */ ([]), confirmAll: false, confirm: "",
    /** Sites forgotten on this screen, held in their row's place: key -> { name, site, at }. */ just: /** @type {Map<string, { name: string, site: any, at: number }>} */ (new Map()),
    /** Rows forgotten on this screen, held in their place in a site's detail: "key|part|id" -> { label, item, at }. */ justItem: /** @type {Map<string, { key: string, part: string, id: string, label: string, item: any, at: number }>} */ (new Map()) };

  const body = h("div", { class: "ml ml-pad ms" });
  put(root, body);

  async function load() {
    const r = await attempt("memory.site.list", {});
    if (!alive()) return;
    st.error = r.error || null;
    st.list = r.error ? [] : sitesOf(r.data);
    st.box = r.error ? [] : forgottenOf(r.data);
    // A site forgotten on this screen stays as its one line, in the place its row was.
    for (const [key, v] of st.just) if (!st.list.some(x => x.key === key)) st.list.splice(Math.min(v.at, st.list.length), 0, v.site);
    draw();
  }
  async function loadDetail(/** @type {string} */ key) {
    const r = await attempt("memory.site.detail", { key });
    if (!alive()) return;
    const d = r.error ? { error: errWords(r.error) } : r.data;
    // A row forgotten on this screen stays as its one line, in the place it was.
    if (d && d.parts) for (const v of st.justItem.values()) if (v.key === key && Array.isArray(d.parts[v.part]) && !d.parts[v.part].some((/** @type {any} */ x) => String(x.id) === v.id)) {
      d.parts[v.part].splice(Math.min(v.at, d.parts[v.part].length), 0, { ...v.item, _forgot: true });
    }
    st.detail[key] = d;
  }
  async function openDetail(/** @type {string} */ key) {
    if (st.open === key) { st.open = ""; draw(); return; }
    st.open = key; draw();
    if (!st.detail[key]) { await loadDetail(key); draw(); }
  }
  async function forgetSite(/** @type {{ key: string, name: string }} */ s) {
    st.busy = s.key; st.problem = null; draw();
    const r = await attempt("memory.site.forget", { key: s.key });
    st.busy = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return; }
    st.just.set(s.key, { name: s.name, site: s, at: Math.max(0, st.list.findIndex(x => x.key === s.key)) });
    st.confirm = "";
    delete st.detail[s.key]; if (st.open === s.key) st.open = "";
    await load();
  }
  async function forgetAll() {
    st.confirmAll = false; st.busy = "*"; st.problem = null; draw();
    const r = await attempt("memory.site.forget", { all: true });
    st.busy = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return; }
    st.list.forEach((site, at) => st.just.set(site.key, { name: site.name, site, at }));
    st.detail = {}; st.open = "";
    await load();
  }
  async function forgetItem(/** @type {string} */ key, /** @type {string} */ part, /** @type {any} */ it) {
    const token = key + "|" + part + "|" + it.id;
    st.busy = token; st.problem = null; draw();
    const at = Math.max(0, (st.detail[key]?.parts?.[part] || []).findIndex((/** @type {any} */ x) => String(x.id) === String(it.id)));
    const r = await attempt("memory.site.forget", { key, part, id: String(it.id) });
    st.busy = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return; }
    st.justItem.set(token, { key, part, id: String(it.id), label: String(it.label || it.id), item: it, at });
    await loadDetail(key);
    await load();
  }
  /** Bring one thing back: a whole site ({ key }), or a row ({ key, part, id }). memory.site.restore answers { restored: 1 | 0 }. @param {{ key: string, name?: string, part?: string|null, id?: string|null, label?: string|null }} k */
  async function restore(k) {
    const token = k.part ? `${k.key}|${k.part}|${k.id}` : k.key;
    st.busy = "r" + token; st.problem = null; draw();
    const r = await attempt("memory.site.restore", k.part ? { key: k.key, part: k.part, id: k.id } : { key: k.key });
    st.busy = "";
    if (k.part) st.justItem.delete(token); else st.just.delete(k.key);
    if (r.error) st.problem = errWords(r.error);
    else if (!r.data || !Number(r.data.restored)) st.problem = `${k.label || k.name || "That"} can no longer be brought back.`;
    delete st.detail[k.key];
    if (st.open === k.key) await loadDetail(k.key);
    await load();
  }

  /** "Forgot X. Undo", the same line for a site, a row and the box's own list. @param {{ text: string, busy: boolean, onUndo: () => void, attrs?: Record<string, string> }} o */
  function forgotBlock(o) {
    return h("div", { class: "ms-forgot-line", role: "status", ...(o.attrs || {}) },
      h("span", { class: "small" }, o.text + " "),
      h("button", { class: "btn btn-ghost btn-sm ms-undo", type: "button", "data-act": "undo", disabled: o.busy, onclick: o.onUndo }, o.busy ? "Bringing back" : "Undo"));
  }

  /** The rows of a site's detail: a label, a line of meta, and Forget (no confirmation: Undo follows). */
  function itemRow(/** @type {string} */ key, /** @type {string} */ part, /** @type {any} */ it) {
    const token = key + "|" + part + "|" + it.id;
    if (it._forgot || st.justItem.has(token)) {
      return h("div", { class: "ms-item ms-item-forgot", "data-item": String(it.id), "data-kept": token },
        forgotBlock({ text: `Forgot ${it.label || it.id}.`, busy: st.busy === "r" + token, onUndo: () => restore({ key, part, id: String(it.id), label: String(it.label || it.id) }) }));
    }
    const meta = it.quarantined ? `stopped working${it.verified ? ", " + ago(it.verified) : ""}`
      : part === "flows" && Number(it.runs) > 0 ? `${plural(Number(it.runs), "run")}, ${Number(it.fails) || 0} failed` : it.verified ? `checked ${ago(it.verified)}` : (typeof it.conf === "number" ? `${Math.round(it.conf * 100)}% sure` : "");
    return h("div", { class: "ms-item", "data-item": String(it.id) },
      h("span", { class: "ms-item-label" + (part === "api" ? " mono" : "") }, String(it.label || it.id)),
      meta ? h("span", { class: "small faint" + (it.quarantined ? " ms-stopped" : "") }, meta) : null,
      h("button", { class: "btn btn-ghost btn-sm ms-wrong", type: "button", "data-act": "item-forget", disabled: st.busy === token, "aria-label": `Forget ${it.label || it.id}`, onclick: () => forgetItem(key, part, it) }, "Forget"));
  }
  function detailPanel(/** @type {string} */ key) {
    const d = st.detail[key];
    if (!d) return h("div", { class: "small faint ms-detail" }, "Reading…");
    if (d.error) return h("div", { class: "small muted ms-detail", role: "alert" }, d.error);
    if (d.found === false) return h("div", { class: "small muted ms-detail" }, "Vyre no longer has this site.");
    const groups = PARTS.filter(([p]) => Array.isArray(d.parts?.[p]) && d.parts[p].length);
    return h("div", { class: "ms-detail" },
      groups.length ? groups.map(([p, label]) => h("div", { class: "ms-part", "data-part": p },
        h("div", { class: "ms-part-head" }, h("h3", { class: "ms-part-name" }, label), h("span", { class: "code ms-part-n" }, String(d.parts[p].filter((/** @type {any} */ x) => !x._forgot).length))),
        d.parts[p].map((/** @type {any} */ it) => itemRow(key, p, it)))) : h("p", { class: "small muted" }, "Nothing is kept for this site yet."));
  }
  /** How many sites a family covers: the origins that name it. @param {ReturnType<typeof sitesOf>[number]} s */
  const familyCount = s => st.list.filter(x => x.kind === "origin" && x.family && x.family === s.family).length;

  function siteRow(/** @type {ReturnType<typeof sitesOf>[number]} */ s) {
    // A site forgotten just now: one line where its row was, with an untimed Undo.
    if (st.just.has(s.key)) {
      const k = /** @type {any} */ (st.just.get(s.key));
      return h("div", { class: "ml-row ms-row ms-forgot", "data-site": s.key, "data-kept": s.key },
        h("div", { class: "ml-main" }, forgotBlock({ text: `Forgot ${k.name}. Vyre will learn it again only if you use it.`, busy: st.busy === "r" + s.key, onUndo: () => restore({ key: s.key, name: k.name }) })));
    }
    const open = st.open === s.key;
    const fam = s.kind === "family";
    if (fam && st.confirm === s.key) {
      const n = familyCount(s);
      return h("div", { class: "ml-row ms-row ms-confirm", "data-site": s.key },
        h("div", { class: "ml-main" }, h("div", { class: "ml-rule" }, `Forget the ${s.name}?`),
          h("div", { class: "small muted" }, `This forgets what is shared across ${n ? plural(n, "site") : "its sites"}. You can undo it for a day.`)),
        h("div", { class: "ml-act" },
          h("button", { class: "btn btn-sm", type: "button", "data-act": "family-yes", disabled: st.busy === s.key, onclick: () => forgetSite(s) }, n ? `Forget ${plural(n, "site")}` : "Forget"),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "family-no", onclick: () => { st.confirm = ""; draw(); } }, "Cancel")));
    }
    return h("div", { class: "ml-row ms-row", "data-site": s.key },
      h("div", { class: "ml-main" },
        h("div", { class: "ml-rule" }, s.name),
        h("div", { class: "code ms-host" }, fam ? "" : hostOf(s.key)),
        h("div", { class: "ml-meta small" },
          fam ? h("span", { class: "tag ml-quiet" }, `Family of ${plural(familyCount(s), "site")}`) : null,
          s.usedToWork ? h("span", { class: "tag ml-quiet" }, `${s.usedToWork} used to work`) : null,
          h("span", { class: "faint" }, countsLine(s.counts)),
          s.verified ? h("span", { class: "faint" }, `checked ${ago(s.verified)}`) : null),
        open ? detailPanel(s.key) : null),
      h("div", { class: "ml-act" },
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "forget", disabled: st.busy === s.key, "aria-label": `Forget ${s.name}`,
          onclick: () => { if (fam) { st.confirm = s.key; draw(); } else void forgetSite(s); } }, st.busy === s.key ? "Forgetting" : "Forget"),
        h("button", { class: "ibtn ms-chev", type: "button", "data-act": "details", "aria-expanded": String(open), "aria-label": open ? `Hide what Vyre knows about ${s.name}` : `What Vyre knows about ${s.name}`,
          onclick: () => openDetail(s.key) }, icon("chevron", 16))));
  }

  function draw() {
    if (st.error) { put(body, empty(st.error?.missing ? "Sites are not on this box yet." : "Sites could not be read.", st.error)); return; }
    // What the box can still bring back (from any device, any reload), apart from what this screen shows in place.
    const earlier = st.box.filter(f => (f.part ? !st.justItem.has(`${f.key}|${f.part}|${f.id}`) : !st.just.has(f.key)));
    put(body,
      h("p", { class: "ml-note" }, "What Vyre for Chrome learned about each site: its layout, how to find its buttons, what its pages do. Never what you typed or what a page said. Forget anything and you can bring it back for a day."),
      st.problem ? h("p", { class: "small muted", role: "alert" }, st.problem) : null,
      earlier.length ? h("div", { class: "ms-kept" }, earlier.map(f => h("div", { class: "ms-kept-row", "data-kept": f.part ? `${f.key}|${f.part}|${f.id}` : f.key },
        forgotBlock({ text: f.part ? `Forgot ${f.label || f.id} from ${f.name}.` : `Forgot ${f.name}. Vyre will learn it again only if you use it.`, busy: st.busy === "r" + (f.part ? `${f.key}|${f.part}|${f.id}` : f.key),
          onUndo: () => restore(f) })))) : null,
      h("div", { class: "ml-head" }, h("h2", { class: "lbl" }, "Sites"), h("span", { class: "ml-count" }, plural(st.list.filter(x => !st.just.has(x.key)).length, "site")),
        st.list.length > 1 ? (st.confirmAll
          ? h("span", { class: "ms-ask" }, h("span", { class: "small muted" }, `Forget all ${st.list.length}?`),
            h("button", { class: "btn btn-sm", type: "button", "data-act": "all-yes", onclick: forgetAll }, "Forget all"),
            h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "all-no", onclick: () => { st.confirmAll = false; draw(); } }, "Keep"))
          : h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "all", disabled: !!st.busy, onclick: () => { st.confirmAll = true; draw(); } }, "Forget all")) : null),
      st.list.length ? h("div", { class: "ml-rows" }, st.list.map(siteRow))
        : h("div", { class: "ml-none empty" }, h("strong", null, "No sites yet"), h("p", { class: "small muted" }, "Vyre for Chrome learns a site as you and your agents use it. Nothing is learned from pages you have not opened with Vyre.")));
  }

  await load();
  return { stop() { stopped = true; } };
}
