// @ts-check
// Settings, the registry's keys: every setting core/settings lists gets a control here with no
// other work. Drawn into deck/views/settings.js as sections of their own, under "Sessions and
// Claude" in its rail, one section per group of settings.schema.
//
// One Level switch (Account | Project) sets where a change is written. In Project mode a key that
// is kept per account only is dimmed, and the other way round. Each row says where its value comes
// from (Project, Account, Default), whether Claude Code's own file holds it, and when a change
// takes effect.
//
// Saving is optimistic and has no Save button: a switch or a segment writes at once; a text or
// number field writes on blur or Enter, 400 ms after the last of them. A refused write puts the
// old value back and says why on that row. Typing never redraws the list: a row repaints itself,
// and settings.changed (from this device or another) refreshes only the row it names.
//
// Tools: settings.schema, settings.get, settings.set, settings.reset, projects.list.
// Light: nothing on a timer; it loads when Settings opens and follows settings.changed.

import { h, put, head, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";

/** When a change takes effect, as the row says after it. */
export const APPLY = { live: "Applied", session: "From the next session", restart: "Restart vyred to apply" };
const SOURCE = { project: "Project", account: "Account", default: "Default", unset: "Not set" };
export const MODELS = ["opus", "sonnet", "haiku"];
const OTHER = "__other";

/** A group id the page already uses for a section of its own gets a prefix, so both can be linked. */
export const domId = (/** @type {string} */ id, /** @type {Set<string>} */ taken) => (taken.has(id) ? "set-" + id : id);
const safe = (/** @type {string} */ key) => "sk-" + String(key).replace(/[^A-Za-z0-9_-]/g, "-");
const errText = (/** @type {any} */ e) => (e?.missing ? `The ${e.module} module is not running, so this cannot be changed here yet.` : String(e?.message || e));
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @typedef {{ key: string, group: string, label: string, help?: string, type: string, enum?: string[], choices?: number[],
 *   min?: number, max?: number, levels: string[], apply: "live"|"session"|"restart", owner: "V"|"C", advanced?: boolean, default?: any }} Def
 * @typedef {Def & { value?: any, source?: string, account?: any, project?: any, available?: boolean, problem?: string }} Row
 * @typedef {{ save: (v: any) => void, reset: () => void, later: (fn: () => void) => void, dirty: (on: boolean) => void, id: string, labelId: string }} Hooks
 * @typedef {{ el: HTMLElement, labelable: boolean, set: (v: any) => void, disable: (off: boolean) => void }} Control
 */

/**
 * Draw the keys into `el`. Resolves to the groups drawn (for the page's rail) and reveal(key),
 * which scrolls to one row and highlights it.
 * @param {HTMLElement} el
 * @param {{ on: Function, cleanup: Function, alive: () => boolean, query?: URLSearchParams }} ctx
 * @param {{ attempt?: typeof apiAttempt, delay?: number, taken?: Set<string>, skip?: Set<string>, css?: boolean }} [deps]
 */
export async function drawKeys(el, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const delay = deps.delay ?? 400;
  const taken = deps.taken || new Set();
  if (deps.css !== false && typeof document !== "undefined" && !document.querySelector?.('link[href="/css/views/settings-keys.css"]')) {
    document.head.append(h("link", { rel: "stylesheet", href: "/css/views/settings-keys.css" }));
  }

  const sc = await attempt("settings.schema");
  if (!ctx.alive()) return { groups: [], reveal: () => false };
  if (sc.error) {
    put(el, h("section", { class: "set-sec sk-sec", id: domId("sessions-claude", taken) }, head("Sessions and Claude"),
      empty("These settings are kept by the settings module.", sc.error)));
    return { groups: [], reveal: () => false };
  }
  /** @type {Def[]} */
  const defs = Array.isArray(sc.data?.keys) ? sc.data.keys : [];
  // A group an older section already draws in full (Notifications, with its devices) stays there.
  const skip = deps.skip || new Set();
  const groups = (Array.isArray(sc.data?.groups) ? sc.data.groups : []).filter(g => !skip.has(g.id) && defs.some(k => k.group === g.id));

  const state = { level: /** @type {"account"|"project"} */ ("account"), project: "", advanced: false, find: "" };
  /** @type {{ slug: string, name: string }[]} */
  let projects = [];

  // ---- the bar: level, project, find, advanced --------------------------------------------------
  const status = h("div", { class: "small muted sk-status", role: "status" });
  const levelSeg = h("div", { class: "seg", role: "group", "aria-label": "Level" });
  const projSel = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select sk-proj", "aria-label": "Project" }));
  const find = /** @type {HTMLInputElement} */ (h("input", { type: "search", class: "input sk-find", placeholder: "Find a setting",
    "aria-label": "Find a setting", autocomplete: "off", spellcheck: "false" }));
  const advBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm sk-adv", "aria-pressed": "false" }, "Show advanced");
  const none = h("div", { class: "empty sk-none", hidden: true });

  const drawLevel = () => {
    put(levelSeg, [["account", "Account"], ["project", "Project"]].map(([v, t]) => h("button", {
      type: "button", "aria-pressed": String(state.level === v), "data-level": v,
      disabled: v === "project" && !projects.length,
      onclick: () => setLevel(/** @type {any} */ (v), state.project || projects[0]?.slug || ""),
    }, t)));
    projSel.hidden = state.level !== "project";
  };
  const setLevel = async (/** @type {"account"|"project"} */ level, /** @type {string} */ project) => {
    if (level === "project" && !project) return;
    state.level = level;
    state.project = level === "project" ? project : "";
    if (level === "project") projSel.value = project;
    drawLevel();
    for (const r of rows.values()) { r.hint = ""; r.error = ""; }
    await loadValues();
  };
  projSel.addEventListener("change", () => setLevel("project", projSel.value));
  find.addEventListener("input", () => { state.find = find.value.trim().toLowerCase(); filter(); });
  advBtn.addEventListener("click", () => {
    state.advanced = !state.advanced;
    advBtn.setAttribute("aria-pressed", String(state.advanced));
    put(advBtn, state.advanced ? "Hide advanced" : "Show advanced");
    filter();
  });

  // ---- rows ------------------------------------------------------------------------------------
  /** @type {Map<string, ReturnType<typeof makeRow>>} */
  const rows = new Map();
  const makeRow = (/** @type {Def} */ def) => {
    const id = safe(def.key);
    const labelId = id + "-l";
    let timer = 0, seq = 0;
    const r = {
      def, /** @type {Row} */ data: { ...def }, loaded: false, hint: "", error: "", dirty: false,
      el: h("div", { class: "set-row sk-row", "data-key": def.key, id: id + "-row" }),
      /** @type {Control} */ ctl: /** @type {any} */ (null),
      meta: h("div", { class: "sk-meta small" }),
      note: h("div", { class: "sk-note small" }),
      paint: (/** @type {boolean} */ _force = false) => {},
    };
    /** @type {Hooks} */
    const hooks = {
      id, labelId,
      dirty: on => { r.dirty = on; if (on && r.error) { r.error = ""; paintNote(); } },
      later: fn => { clearTimeout(timer); timer = /** @type {any} */ (setTimeout(fn, delay)); },
      save: v => save(v),
      reset: () => reset(),
    };
    r.ctl = control(def, hooks);
    const label = h("label", { id: labelId, class: "sk-label", ...(r.ctl.labelable ? { for: id } : {}) }, def.label);
    put(r.el,
      h("div", { class: "set-k sk-k" }, label, def.help ? h("div", { class: "small faint sk-help" }, def.help) : null,
        h("code", { class: "sk-key" }, def.key)),
      h("div", { class: "set-v sk-v" }, h("div", { class: "sk-ctl" }, r.ctl.el), r.meta, r.note));
    ctx.cleanup(() => clearTimeout(timer));

    const where = () => {
      const allowed = def.levels.includes(state.level);
      const reason = r.loaded && r.data.available === false ? "Its module is off"
        : !allowed ? (state.level === "project" ? "Set for your account only" : "Set per project only") : "";
      return { allowed, reason, here: state.level === "project" ? r.data.project !== undefined : r.data.account !== undefined };
    };
    const paintNote = () => {
      const { reason } = where();
      put(r.note,
        reason ? h("div", { class: "faint sk-why" }, reason) : null,
        r.data.problem ? h("div", { class: "set-warn sk-problem" }, r.data.problem) : null,
        r.error ? h("div", { class: "set-warn sk-err", role: "alert" }, r.error) : null);
    };
    r.paint = (force = false) => {
      const { reason, here } = where();
      r.el.classList.toggle("sk-dim", !!reason);
      r.ctl.disable(!r.loaded || !!reason);
      if (force || !r.dirty) r.ctl.set(r.data.value);
      put(r.meta,
        r.loaded ? h("span", { class: "tag sk-src", "data-source": r.data.source || "unset" }, SOURCE[r.data.source || "unset"] || r.data.source) : null,
        def.owner === "C" ? h("span", { class: "tag sk-owner" }, "Claude Code file") : null,
        r.loaded && here && !reason ? h("button", { type: "button", class: "btn btn-ghost btn-sm sk-reset",
          "aria-label": `Reset ${def.label}`, onclick: () => reset() }, "Reset") : null,
        r.hint ? h("span", { class: "faint sk-hint", role: "status" }, r.hint) : null);
      paintNote();
    };

    const target = () => ({ key: def.key, level: state.level, ...(state.level === "project" ? { project: state.project } : {}) });
    const settle = async (/** @type {Row} */ guess, /** @type {string} */ tool, /** @type {Record<string, any>} */ input) => {
      const prev = r.data, mine = ++seq;
      r.data = guess; r.error = ""; r.hint = ""; r.dirty = false;
      r.paint(true);
      const x = await attempt(tool, input);
      if (!ctx.alive() || mine !== seq) return;
      if (x.error) { r.data = prev; r.error = errText(x.error); r.paint(true); return; }
      if (x.data && x.data.key === def.key) r.data = x.data;
      r.hint = APPLY[def.apply] || "";
      r.paint(true);
    };
    const save = (/** @type {any} */ v) => {
      if (where().reason) return;
      const level = state.level;
      return settle({ ...r.data, value: v, source: level, [level]: v }, "settings.set", { ...target(), value: v });
    };
    const reset = () => {
      if (where().reason) return;
      const level = state.level;
      const below = level === "project" ? r.data.account : undefined;
      const value = below !== undefined ? below : def.default;
      const guess = { ...r.data, value, source: below !== undefined ? "account" : def.default !== undefined ? "default" : "unset" };
      delete guess[level];
      return settle(guess, "settings.reset", target());
    };
    r.paint();
    return r;
  };
  for (const d of defs) rows.set(d.key, makeRow(d));

  // ---- sections --------------------------------------------------------------------------------
  const secs = groups.map(g => {
    const id = domId(g.id, taken);
    const hd = head(g.label);
    /** @type {HTMLElement} */ (hd.firstChild).id = id + "-h";
    return { g, id, el: h("section", { class: "set-sec sk-sec", id, "aria-labelledby": id + "-h", "data-group": g.id },
      hd, h("div", { class: "rows" }, defs.filter(k => k.group === g.id).map(k => rows.get(k.key)?.el))) };
  });

  const filter = () => {
    let shown = 0;
    for (const r of rows.values()) {
      const q = state.find;
      const hit = !q || r.def.label.toLowerCase().includes(q) || r.def.key.toLowerCase().includes(q);
      r.el.hidden = !hit || (!!r.def.advanced && !state.advanced);
      if (!r.el.hidden) shown++;
    }
    for (const s of secs) s.el.hidden = !defs.some(k => k.group === s.g.id && !rows.get(k.key)?.el.hidden);
    none.hidden = shown > 0;
    put(none, shown ? null : `No setting matches "${find.value.trim()}".`);
  };

  const loadValues = async () => {
    put(status, "Loading.");
    const x = await attempt("settings.get", state.level === "project" ? { project: state.project } : {});
    if (!ctx.alive()) return;
    if (x.error) { put(status, errText(x.error)); return; }
    put(status);
    for (const s of x.data?.settings || []) {
      const r = rows.get(s.key);
      if (!r) continue;
      r.data = s; r.loaded = true;
      r.paint();
    }
  };

  /** One row, fresh from the box, after a change made here or elsewhere. */
  const refresh = async (/** @type {string} */ key) => {
    const r = rows.get(key);
    if (!r) return;
    const x = await attempt("settings.get", { key, ...(state.level === "project" ? { project: state.project } : {}) });
    if (!ctx.alive() || x.error || !x.data || x.data.key !== key) return;
    r.data = x.data; r.loaded = true;
    r.paint();
  };
  ctx.on("settings.changed", (/** @type {any} */ e) => {
    const p = e?.payload || {};
    if (!rows.has(p.key)) return;
    // A project's value matters only while that project is the one shown.
    if (p.level === "project" && (state.level !== "project" || p.project !== state.project)) return;
    refresh(p.key);
  });

  put(el,
    h("div", { class: "sk-top" },
      h("h2", { class: "lbl" }, "Sessions and Claude"),
      h("p", { class: "small muted sk-intro" }, "Saved as you go. A project's value beats your account's, which beats the default. A session's own model and mode beat all three."),
      h("div", { class: "sk-bar" }, levelSeg, projSel, find, advBtn),
      status),
    none,
    secs.map(s => s.el));

  // Projects for the Level switch. With none, Project stays off.
  const p = await attempt("projects.list");
  if (!ctx.alive()) return { groups: [], reveal: () => false };
  projects = (Array.isArray(p.data) ? p.data : p.data?.projects || []).filter((/** @type {any} */ x) => x && x.slug)
    .map((/** @type {any} */ x) => ({ slug: String(x.slug), name: String(x.name || x.slug) }));
  put(projSel, projects.map(x => h("option", { value: x.slug }, x.name)));
  const want = ctx.query?.get("project") || "";
  if (want && projects.some(x => x.slug === want)) { state.level = "project"; state.project = want; projSel.value = want; }
  drawLevel();
  filter();
  await loadValues();

  /** Scroll to one key's row and highlight it. False when there is no such key. @param {string} key */
  const reveal = key => {
    const r = rows.get(key);
    if (!r) return false;
    if (r.def.advanced && !state.advanced) advBtn.click();
    if (state.find) { find.value = ""; state.find = ""; filter(); }
    r.el.scrollIntoView({ block: "center" });
    r.el.classList.add("sk-hi");
    const t = setTimeout(() => r.el.classList.remove("sk-hi"), 2500);
    ctx.cleanup(() => clearTimeout(t));
    return true;
  };
  return { groups: secs.map(s => ({ id: s.id, label: s.g.label })), reveal, setLevel };
}

// ---- controls ------------------------------------------------------------------------------------

/**
 * The control for one key, by its type.
 * @param {Def} def @param {Hooks} k @returns {Control}
 */
export function control(def, k) {
  if (def.type === "bool") return toggle(k);
  if (def.type === "enum") return (def.enum || []).length <= 4 ? segment(def.enum || [], k) : select(def, def.enum || [], k);
  if ((def.type === "int" || def.type === "number") && def.choices) return segment(def.choices, k);
  if (def.type === "int" || def.type === "number") return field(def, k, "number");
  if (def.type === "model") return model(def, k);
  if (def.type === "list") return list(def, k);
  if (def.type === "object") return json(def, k);
  return field(def, k, "text");
}

/** @param {Hooks} k */
function toggle(k) {
  let cur = false;
  const b = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "sw", role: "switch", id: k.id, "aria-checked": "false",
    onclick: () => k.save(!cur) }));
  return { el: b, labelable: true, set: v => { cur = v === true; b.setAttribute("aria-checked", String(cur)); }, disable: off => { b.disabled = off; } };
}

/** @param {(string|number)[]} opts @param {Hooks} k */
function segment(opts, k) {
  let cur = /** @type {any} */ (undefined);
  const btns = opts.map(v => h("button", { type: "button", "aria-pressed": "false", "data-value": String(v), onclick: () => { if (v !== cur) k.save(v); } }, String(v)));
  const seg = h("div", { class: "seg", role: "group", id: k.id, "aria-labelledby": k.labelId }, btns);
  return {
    el: seg, labelable: false,
    set: v => { cur = v; opts.forEach((o, i) => btns[i].setAttribute("aria-pressed", String(o === v))); },
    disable: off => { for (const b of btns) /** @type {HTMLButtonElement} */ (b).disabled = off; },
  };
}

/** @param {Def} def @param {string[]} opts @param {Hooks} k */
function select(def, opts, k) {
  const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", id: k.id },
    h("option", { value: "" }, def.default !== undefined ? `Default (${def.default})` : "Not set"),
    opts.map(v => h("option", { value: v }, v))));
  let cur = /** @type {any} */ (undefined);
  sel.addEventListener("change", () => (sel.value === "" ? k.reset() : sel.value !== cur ? k.save(sel.value) : null));
  return { el: sel, labelable: true, set: v => { cur = v; sel.value = v == null ? "" : String(v); }, disable: off => { sel.disabled = off; } };
}

/**
 * A text or number field: saves on blur or Enter, after the delay, when it changed. Emptying it
 * removes the value at this level.
 * @param {Def} def @param {Hooks} k @param {"text"|"number"} kind
 */
function field(def, k, kind) {
  let cur = /** @type {any} */ (undefined);
  const num = kind === "number";
  const inp = /** @type {HTMLInputElement} */ (h("input", { type: num ? "number" : "text", class: "input sk-input" + (num ? " sk-num" : ""), id: k.id,
    autocomplete: "off", spellcheck: "false",
    ...(num ? { inputmode: def.type === "int" ? "numeric" : "decimal", step: def.type === "int" ? "1" : "any" } : {}),
    ...(num && def.min !== undefined ? { min: String(def.min) } : {}), ...(num && def.max !== undefined ? { max: String(def.max) } : {}),
    ...(def.default !== undefined ? { placeholder: String(def.default) } : {}) }));
  const commit = () => k.later(() => {
    const raw = inp.value.trim();
    if (raw === "") { if (cur !== undefined && cur !== def.default) k.reset(); else k.dirty(false); return; }
    const v = num ? Number(raw) : inp.value;
    if (same(v, cur)) { k.dirty(false); return; }
    k.save(v);
  });
  inp.addEventListener("input", () => k.dirty(true));
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  return { el: inp, labelable: true, set: v => { cur = v; inp.value = v == null ? "" : String(v); }, disable: off => { inp.disabled = off; } };
}

/** An alias from the list, or Other with a model id typed in. @param {Def} def @param {Hooks} k */
function model(def, k) {
  let cur = /** @type {any} */ (undefined);
  const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", id: k.id },
    h("option", { value: "" }, def.default !== undefined ? `Default (${def.default})` : "Not set"),
    MODELS.map(m => h("option", { value: m }, m[0].toUpperCase() + m.slice(1))),
    h("option", { value: OTHER }, "Other…")));
  const other = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input sk-input sk-other", hidden: true,
    "aria-label": `${def.label}, model id`, placeholder: "A model id", autocomplete: "off", spellcheck: "false" }));
  const commit = () => k.later(() => {
    const v = other.value.trim();
    if (!v || v === cur) { k.dirty(false); return; }
    k.save(v);
  });
  sel.addEventListener("change", () => {
    other.hidden = sel.value !== OTHER;
    if (sel.value === OTHER) { k.dirty(true); other.focus(); return; }
    k.dirty(false);
    if (sel.value === "") k.reset(); else if (sel.value !== cur) k.save(sel.value);
  });
  other.addEventListener("input", () => k.dirty(true));
  other.addEventListener("blur", commit);
  other.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  return {
    el: h("div", { class: "sk-model" }, sel, other), labelable: true,
    set: v => {
      cur = v;
      const alias = v == null || v === "" ? "" : MODELS.includes(String(v)) ? String(v) : OTHER;
      sel.value = alias;
      other.hidden = alias !== OTHER;
      other.value = alias === OTHER ? String(v) : "";
    },
    disable: off => { sel.disabled = off; other.disabled = off; },
  };
}

/** Chips with remove, and a field to add one. Each change saves the whole list. @param {Def} def @param {Hooks} k */
function list(def, k) {
  /** @type {string[]} */ let cur = [];
  let off = false;
  const chips = h("div", { class: "sk-chips", role: "list" });
  const inp = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input sk-input", id: k.id, placeholder: "Add one",
    autocomplete: "off", spellcheck: "false" }));
  const addBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm sk-add" }, "Add"));
  const add = () => {
    const v = inp.value.trim();
    if (!v) return;
    inp.value = "";
    k.dirty(false);
    if (!cur.includes(v)) k.save([...cur, v]);
  };
  inp.addEventListener("input", () => k.dirty(!!inp.value));
  inp.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  addBtn.addEventListener("click", add);
  const draw = () => put(chips, cur.length ? cur.map(x => h("span", { class: "chip sk-chip", role: "listitem" }, h("span", { class: "mono" }, x),
    h("button", { type: "button", class: "sk-x", "aria-label": `Remove ${x}`, disabled: off, onclick: () => k.save(cur.filter(y => y !== x)) }, "×")))
    : h("span", { class: "small faint" }, "None"));
  draw();
  return {
    el: h("div", { class: "sk-list" }, chips, h("div", { class: "sk-add-row" }, inp, addBtn)), labelable: true,
    set: v => { cur = Array.isArray(v) ? v.map(String) : []; draw(); },
    disable: o => { off = o; inp.disabled = o; addBtn.disabled = o; draw(); },
  };
}

/** JSON behind an Advanced disclosure; saved on blur when it parses. @param {Def} def @param {Hooks} k */
function json(def, k) {
  let cur = /** @type {any} */ (undefined);
  const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input sk-json", id: k.id, rows: "6", spellcheck: "false", hidden: true }));
  const bad = h("div", { class: "small set-warn sk-bad", role: "alert" });
  const btn = h("button", { type: "button", class: "btn btn-ghost btn-sm sk-disc", "aria-expanded": "false", "aria-controls": k.id }, "Advanced");
  const summary = h("span", { class: "small faint sk-sum" });
  btn.addEventListener("click", () => {
    const open = ta.hidden;
    ta.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) ta.focus();
  });
  ta.addEventListener("input", () => { k.dirty(true); put(bad); });
  ta.addEventListener("blur", () => k.later(() => {
    const raw = ta.value.trim();
    if (!raw) { if (cur !== undefined) k.reset(); else k.dirty(false); return; }
    let v;
    try { v = JSON.parse(raw); } catch (e) { put(bad, `Not valid JSON: ${/** @type {Error} */ (e).message}`); return; }
    if (!v || typeof v !== "object" || Array.isArray(v)) { put(bad, "Expected a JSON object, like {\"NAME\": \"value\"}."); return; }
    if (same(v, cur)) { k.dirty(false); return; }
    k.save(v);
  }));
  return {
    el: h("div", { class: "sk-obj" }, h("div", { class: "set-inline" }, btn, summary), ta, bad), labelable: true,
    set: v => {
      cur = v;
      ta.value = v == null ? "" : JSON.stringify(v, null, 2);
      const n = v && typeof v === "object" ? Object.keys(v).length : 0;
      put(summary, n ? `${n} ${n === 1 ? "entry" : "entries"}` : "Empty");
      put(bad);
    },
    disable: off => { ta.disabled = off; },
  };
}
