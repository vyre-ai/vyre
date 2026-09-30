// @ts-check
// Sites, a tab in Memory (/memory?tab=sites). What Vyre for Chrome learned about each website it works
// in: how a page is laid out, how to find its buttons, what its calls and flows do. Never a selector, a
// value or a page's text: the box sends names, counts, how sure it is and when it last checked.
//
// One screen. The list (memory.site.list), a site's rows on request (memory.site.detail), and Forget:
//   - a whole site: memory.site.forget {key}, then a line with Undo for 24 hours (memory.site.restore {key});
//     the line is kept in this browser, so Undo is still there after a reload until the day is up.
//   - Forget all: memory.site.forget {all: true}; Undo restores each site it took.
//   - one item of a site: memory.site.forget {key, part, id}, after one "Forget?" tap. It has no undo
//     (the box keeps only whole sites for a day), and the row says so before it is pressed.
// "Wrong?" on an answer about a site is the ordinary memory.correct / memory.uncorrect path on the
// answer itself; nothing here re-implements it. Nothing polls: it loads on open and after each action.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";
import { plural } from "../js/fmt.js";
import { icon } from "../js/icons.js";

const DAY = 24 * 3600_000;
const KEPT = "vyre.sites.forgotten";
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

/** Sites forgotten in this browser within the last day, for the Undo that outlives a reload. @returns {{ key: string, name: string, at: number }[]} */
function keptRead() {
  try {
    const all = JSON.parse(localStorage.getItem(KEPT) || "[]");
    return (Array.isArray(all) ? all : []).filter(x => x && typeof x.key === "string" && Date.now() - Number(x.at) < DAY);
  } catch { return []; }
}
function keptWrite(/** @type {{ key: string, name: string, at: number }[]} */ list) { try { localStorage.setItem(KEPT, JSON.stringify(list.slice(0, 50))); } catch { /* not kept: Undo lasts until this screen closes */ } }

/**
 * @param {HTMLElement} root @param {{ alive: () => boolean, on?: (t: string, fn: (e: any) => void) => void }} ctx
 * @param {{ attempt?: typeof apiAttempt }} [deps]
 */
export default async function sites(root, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  let stopped = false;
  const alive = () => !stopped && ctx.alive();
  const st = { list: /** @type {ReturnType<typeof sitesOf>} */ ([]), error: /** @type {any} */ (null), open: "", detail: /** @type {Record<string, any>} */ ({}), busy: "",
    sure: "", problem: /** @type {string|null} */ (null), kept: keptRead(), confirmAll: false, confirm: "",
    /** Sites forgotten on this screen, kept in their row's place until it closes: key -> { name, site, at }. */ just: /** @type {Map<string, { name: string, site: any, at: number }>} */ (new Map()) };

  const body = h("div", { class: "ml ml-pad ms" });
  put(root, body);

  async function load() {
    const r = await attempt("memory.site.list", {});
    if (!alive()) return;
    st.error = r.error || null;
    st.list = r.error ? [] : sitesOf(r.data);
    // A site forgotten on this screen stays as its one line, in the place its row was.
    for (const [key, v] of st.just) if (!st.list.some(x => x.key === key)) st.list.splice(Math.min(v.at, st.list.length), 0, v.site);
    st.kept = keptRead().filter(k => !st.list.some(s => s.key === k.key));
    draw();
  }
  async function openDetail(/** @type {string} */ key) {
    if (st.open === key) { st.open = ""; draw(); return; }
    st.open = key; st.sure = ""; draw();
    if (!st.detail[key]) {
      const r = await attempt("memory.site.detail", { key });
      if (!alive()) return;
      st.detail[key] = r.error ? { error: errWords(r.error) } : r.data;
    }
    draw();
  }
  async function forgetSite(/** @type {{ key: string, name: string }} */ s) {
    st.busy = s.key; st.problem = null; draw();
    const r = await attempt("memory.site.forget", { key: s.key });
    st.busy = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return; }
    keptWrite([{ key: s.key, name: s.name, at: Date.now() }, ...keptRead().filter(k => k.key !== s.key)]);
    st.just.set(s.key, { name: s.name, site: s, at: Math.max(0, st.list.findIndex(x => x.key === s.key)) });
    st.confirm = "";
    delete st.detail[s.key]; if (st.open === s.key) st.open = "";
    await load();
  }
  async function forgetAll() {
    const was = st.list.map(s => ({ key: s.key, name: s.name }));
    st.confirmAll = false; st.busy = "*"; st.problem = null; draw();
    const r = await attempt("memory.site.forget", { all: true });
    st.busy = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return; }
    keptWrite([...was.map(s => ({ ...s, at: Date.now() })), ...keptRead().filter(k => !was.some(w => w.key === k.key))]);
    st.list.forEach((site, at) => st.just.set(site.key, { name: site.name, site, at }));
    st.detail = {}; st.open = "";
    await load();
  }
  async function forgetItem(/** @type {string} */ key, /** @type {string} */ part, /** @type {string} */ id) {
    st.busy = key + "|" + part + "|" + id; st.problem = null; draw();
    const r = await attempt("memory.site.forget", { key, part, id });
    st.busy = ""; st.sure = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return; }
    delete st.detail[key];
    const d = await attempt("memory.site.detail", { key });
    if (!alive()) return;
    st.detail[key] = d.error ? { error: errWords(d.error) } : d.data;
    await load();
  }
  async function restore(/** @type {{ key: string, name: string }} */ k) {
    st.busy = "r" + k.key; st.problem = null; draw();
    const r = await attempt("memory.site.restore", { key: k.key });
    st.busy = "";
    st.just.delete(k.key);
    if (r.error || r.data?.restored === false) { st.problem = r.error ? errWords(r.error) : `${k.name} can no longer be brought back.`; keptWrite(keptRead().filter(x => x.key !== k.key)); await load(); return; }
    keptWrite(keptRead().filter(x => x.key !== k.key));
    await load();
  }

  /** The rows of a site's detail: a label, a line of meta, and Forget this (one tap asks, and says it has no undo). */
  function itemRow(/** @type {string} */ key, /** @type {string} */ part, /** @type {any} */ it) {
    const token = key + "|" + part + "|" + it.id;
    const asking = st.sure === token;
    const meta = it.quarantined ? `stopped working${it.verified ? ", " + ago(it.verified) : ""}`
      : part === "flows" && Number(it.runs) > 0 ? `${plural(Number(it.runs), "run")}, ${Number(it.fails) || 0} failed` : it.verified ? `checked ${ago(it.verified)}` : (typeof it.conf === "number" ? `${Math.round(it.conf * 100)}% sure` : "");
    return h("div", { class: "ms-item", "data-item": String(it.id) },
      h("span", { class: "ms-item-label" + (part === "api" ? " mono" : "") }, String(it.label || it.id)),
      meta ? h("span", { class: "small faint" + (it.quarantined ? " ms-stopped" : "") }, meta) : null,
      asking ? h("span", { class: "ms-ask" }, h("span", { class: "small muted" }, "Forget this? It cannot be undone."),
        h("button", { class: "btn btn-sm", type: "button", "data-act": "item-yes", disabled: st.busy === token, onclick: () => forgetItem(key, part, String(it.id)) }, "Forget this"),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "item-no", onclick: () => { st.sure = ""; draw(); } }, "Keep"))
        : h("button", { class: "btn btn-ghost btn-sm ms-wrong", type: "button", "data-act": "item-forget", "aria-label": `Forget ${it.label || it.id}`, onclick: () => { st.sure = token; draw(); } }, "Wrong?"));
  }
  function detailPanel(/** @type {string} */ key) {
    const d = st.detail[key];
    if (!d) return h("div", { class: "small faint ms-detail" }, "Reading…");
    if (d.error) return h("div", { class: "small muted ms-detail", role: "alert" }, d.error);
    if (d.found === false) return h("div", { class: "small muted ms-detail" }, "Vyre no longer has this site.");
    const groups = PARTS.filter(([p]) => Array.isArray(d.parts?.[p]) && d.parts[p].length);
    return h("div", { class: "ms-detail" },
      groups.length ? groups.map(([p, label]) => h("div", { class: "ms-part", "data-part": p },
        h("div", { class: "ms-part-head" }, h("h3", { class: "ms-part-name" }, label), h("span", { class: "code ms-part-n" }, String(d.parts[p].length))),
        d.parts[p].map((/** @type {any} */ it) => itemRow(key, p, it)))) : h("p", { class: "small muted" }, "Nothing is kept for this site yet."),
      groups.length ? h("p", { class: "small faint" }, "Wrong? offers Forget this, which cannot be undone. Forgetting the whole site can be undone.") : null);
  }
  /** How many sites a family covers: the origins that name it. @param {ReturnType<typeof sitesOf>[number]} s */
  const familyCount = s => st.list.filter(x => x.kind === "origin" && x.family && x.family === s.family).length;

  function siteRow(/** @type {ReturnType<typeof sitesOf>[number]} */ s) {
    // A site forgotten just now: one line where its row was, with an untimed Undo.
    if (st.just.has(s.key)) return forgotLine(s.key, st.just.get(s.key));
    const open = st.open === s.key;
    const fam = s.kind === "family";
    if (fam && st.confirm === s.key) {
      const n = familyCount(s);
      return h("div", { class: "ml-row ms-row ms-confirm", "data-site": s.key },
        h("div", { class: "ml-main" }, h("div", { class: "ml-rule" }, `Forget the ${s.name}?`),
          h("div", { class: "small muted" }, `This forgets what is shared across ${n ? plural(n, "site") : "its sites"}.`)),
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
  /** "Forgot X. Vyre will learn it again only if you use it." with an untimed Undo, in the row's place. */
  function forgotLine(/** @type {string} */ key, /** @type {{ name: string }} */ k) {
    return h("div", { class: "ml-row ms-row ms-forgot", "data-site": key, "data-kept": key, role: "status" },
      h("div", { class: "ml-main" }, h("span", { class: "small" }, `Forgot ${k.name}. Vyre will learn it again only if you use it. `)),
      h("div", { class: "ml-act" }, h("button", { class: "btn btn-ghost btn-sm ms-undo", type: "button", "data-act": "undo", disabled: st.busy === "r" + key, onclick: () => restore({ key, name: k.name }) },
        st.busy === "r" + key ? "Bringing back" : "Undo")));
  }

  function draw() {
    if (st.error) { put(body, empty(st.error?.missing ? "Sites are not on this box yet." : "Sites could not be read.", st.error)); return; }
    // Sites forgotten earlier (before a reload) and still inside their day: a line each at the top, since their rows are gone.
    const earlier = st.kept.filter(k => !st.just.has(k.key));
    put(body,
      h("p", { class: "ml-note" }, "What Vyre for Chrome learned about each site: its layout, how to find its buttons, what its pages do. Never what you typed or what a page said."),
      st.problem ? h("p", { class: "small muted", role: "alert" }, st.problem) : null,
      earlier.length ? h("div", { class: "ms-kept" }, earlier.map(k => h("div", { class: "ms-kept-row", "data-kept": k.key, role: "status" },
        h("span", { class: "small" }, `Forgot ${k.name}. Vyre will learn it again only if you use it.`),
        h("button", { class: "btn btn-ghost btn-sm ms-undo", type: "button", "data-act": "undo", disabled: st.busy === "r" + k.key, onclick: () => restore(k) }, st.busy === "r" + k.key ? "Bringing back" : "Undo")))) : null,
      h("div", { class: "ml-head" }, h("h2", { class: "lbl" }, "Sites"), h("span", { class: "ml-count" }, plural(st.list.length, "site")),
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
