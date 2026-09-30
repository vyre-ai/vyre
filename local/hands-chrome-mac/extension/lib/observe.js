// @ts-check
// observe: what a finished op teaches about a site, as a patch fragment for the site record (shared/sk/site-knowledge.js).
//
// Pure. It reads SHAPES from results Vyre already holds: how a control was found (strategy, identifier, role), the API shapes api.learn found,
// which frames a page has. It never reads a value a person typed or a row's text: the control's label is passed on only for roles that are
// fixed UI (a button, a tab, a menu item ...) and only together with the two-visit evidence the cache kept; the store's allowlist decides the rest.
// team/0.2/chrome-learning-plan.md, section 3 and 10.2.

import { isGhlHost } from "../shared/ghlhosts.js";
import { canonTemplate } from "../shared/sk/site-knowledge.js";

/** Roles whose label is a fixed UI string, not a person's data. A link's label is not (a link can be "Robin Ellis"). */
export const FIXED_UI_ROLES = new Set(["button", "tab", "menuitem", "checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const STRATEGIES = new Set(["identifier", "role+name", "name", "name-ci", "aria", "nearby-label", "text", "structure"]);

/** A short stable hash (FNV-1a), for ids. @param {string} s */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A page's path as the store's own canonical template (canonTemplate): only known route words survive, every other segment (an id, a slug, a name) is {id}, {id2}, ...
 * No query, no fragment. The same function runs on both sides, so a lookup and a stored page always agree. "/" when the path cannot be made one.
 * @param {string} url
 */
export function pageTemplate(url) {
  let p = "/";
  try { p = new URL(url).pathname || "/"; } catch { return "/"; }
  return canonTemplate(p) || "/";
}

/** @param {string} url @returns {string} the origin, or "" for a page that is not http(s) */
export function originOf(url) { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch { return ""; } }

/** @param {string} origin */
function hostOf(origin) { try { return new URL(origin).host; } catch { return ""; } }

/**
 * The family a host belongs to, recognised without the store. GoHighLevel, by its own hosts and the person's configured white-label hosts (isGhlHost).
 * @param {string} origin @returns {{ family: string, names: string[] } | null}
 */
export function familyOf(origin) {
  const host = hostOf(origin).replace(/:\d+$/, "");
  if (host && isGhlHost(host)) return { family: "ghl", names: ["GoHighLevel"] };
  return null;
}

/**
 * @param {{ op: string, args?: any, result?: any, tabUrl?: string, nameVisits?: (origin: string, key: string, text: string) => string[] }} o
 * @returns {{ origin: string, patch: Record<string, any> } | null}
 */
export function observeOp(o) {
  const tabUrl = String(o.tabUrl || "");
  const origin = originOf(tabUrl);
  const r = o.result;
  if (!origin || !r || typeof r !== "object" || r.ok === false || r.held) return null;
  /** @type {Record<string, any>} */ const patch = { key: origin };
  const fam = familyOf(origin);
  if (fam) { patch.family = fam.family; patch.names = fam.names; }

  if ((o.op === "page.act" || o.op === "page.fill") && r.trace && typeof r.trace === "object") {
    const items = [];
    const ctls = o.op === "page.act" ? [r.control] : [];
    for (const c of ctls) {
      if (!c || typeof c !== "object") continue;
      const strategy = STRATEGIES.has(String(r.trace.strategy)) ? String(r.trace.strategy) : "";
      if (!strategy) continue;
      const role = String(c.role || "").toLowerCase();
      if (!/^[a-z][a-z0-9+_-]*$/.test(role)) continue;
      const page = pageTemplate(tabUrl);
      const identifier = typeof c.identifier === "string" && c.identifier ? c.identifier : undefined;
      const fixed = FIXED_UI_ROLES.has(role);
      // A label travels only for a fixed UI role AND with its full evidence: the container's role, how many controls of the kind share it, and the two visits that saw it.
      const evd = r.evidence && typeof r.evidence === "object" && typeof r.evidence.container === "string" && Number.isFinite(r.evidence.siblings) ? r.evidence : null;
      const name = fixed && evd && typeof c.name === "string" && c.name ? c.name : undefined;
      const visits = name && o.nameVisits ? o.nameVisits(origin, `${page}|${role}|${name}`, name) : [];
      if (!identifier && !(name && visits.length >= 2)) continue; // nothing stable to find it by, and nothing that may be stored
      items.push({
        id: `c_${hash(`${page}|${role}|${identifier || name}`)}`, page, role,
        ...(evd ? { container: evd.container, siblings: evd.siblings } : {}),
        ...(name ? { name, nameVisits: visits } : {}),
        selector: { strategy: identifier ? "identifier" : strategy, ...(identifier ? { identifier } : {}), ...(name && !identifier ? { role, name } : {}) },
        ...(r.trace.fallback === true ? { outcome: "ok", seen: 1 } : { outcome: "ok" }),
      });
    }
    if (items.length) patch.controls = items;
  }

  if (o.op === "api.learn" && Array.isArray(r.entries)) {
    patch.api = r.entries.slice(0, 100).map((/** @type {any} */ e) => { const pt = canonTemplate(String(e && e.pathTemplate || "")); return pt ? { ...e, pathTemplate: pt, outcome: "ok" } : null; }).filter(Boolean);
    if (!patch.api.length) delete patch.api;
  }

  if ((o.op === "frames.list" || o.op === "frames.probe") && Array.isArray(r.frames ?? r)) {
    const list = /** @type {any[]} */ (r.frames ?? r);
    const fr = [];
    for (const f of list.slice(0, 16)) {
      if (!f || !f.origin) continue;
      const fo = originOf(String(f.url || f.origin));
      const pt = pageTemplate(String(f.url || f.origin));
      const builder = /leadconnectorhq\.com$/i.test(hostOf(fo)) && /automation|workflow/i.test(hostOf(fo) + pt);
      const role = f.index === 0 ? "shell" : builder ? "builder" : "app";
      fr.push({ id: `f_${hash(`${hostOf(fo)}|${pt}|${f.name || ""}`)}`, match: { originPart: hostOf(fo), pathTemplate: pt, ...(f.name ? { name: String(f.name) } : {}) }, role, readable: f.readable !== false, outcome: "ok" });
    }
    if (fr.length) patch.frames = fr;
    const related = [...new Set(list.map(f => originOf(String(f.url || f.origin || ""))).filter(x => x && x !== origin))].slice(0, 8);
    if (related.length) patch.related = related;
  }

  return Object.keys(patch).some(k => !["key", "family", "names"].includes(k)) ? { origin, patch } : null;
}

/** Widgets whose option names are fixed UI vocabulary. A list that holds data (an "Assigned to" select of people) is a listbox or combobox and is never one of these. */
export const CHOICE_WIDGETS = new Set(["menu", "menubar", "radiogroup", "tablist", "toolbar"]);

/**
 * A flow parameter that picks from options, with the evidence the store needs before it keeps the option names: the widget's role and the visits that saw the same
 * options. Without both, the parameter goes out as a plain parameter with no choices.
 * @param {{ name: string, type?: string }} param @param {{ options?: string[], container?: string, visits?: string[] }} [ev]
 */
export function paramWithChoices(param, ev = {}) {
  const base = { name: param.name, type: param.type || "string" };
  const opts = Array.isArray(ev.options) ? ev.options.map(x => String(x)).filter(Boolean) : [];
  if (!opts.length || opts.length > 8 || !ev.container || !CHOICE_WIDGETS.has(String(ev.container).toLowerCase()) || !Array.isArray(ev.visits) || new Set(ev.visits).size < 2) return base;
  return { ...base, type: "choice", choices: opts, choicesContainer: String(ev.container).toLowerCase(), choicesVisits: [...new Set(ev.visits)].slice(0, 4) };
}
