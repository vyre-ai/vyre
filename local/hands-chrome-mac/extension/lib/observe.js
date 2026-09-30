// @ts-check
// observe: what a finished op teaches about a site, as a patch fragment for the site record (shared/sk/site-knowledge.js).
//
// Pure. It reads SHAPES from results Vyre already holds: how a control was found (strategy, identifier, role), the API shapes api.learn found,
// which frames a page has. It never reads a value a person typed or a row's text: the control's label is passed on only for roles that are
// fixed UI (a button, a tab, a menu item ...) and only together with the two-visit evidence the cache kept; the store's allowlist decides the rest.
// team/0.2/chrome-learning-plan.md, section 3 and 10.2.

import { isGhlHost } from "../shared/ghlhosts.js";

/** Roles whose label is a fixed UI string, not a person's data. A link's label is not (a link can be "Robin Ellis"). */
export const FIXED_UI_ROLES = new Set(["button", "tab", "menuitem", "checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const STRATEGIES = new Set(["identifier", "role+name", "name", "name-ci", "aria", "nearby-label", "text", "structure"]);

/** A short stable hash (FNV-1a), for ids. @param {string} s */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The shape of an id-like path segment: numeric, uuid, hex, or a long mixed token. @param {string} s */
const looksLikeId = s => /^\d+$/.test(s) || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{12,}$/i.test(s)
  || (/^[A-Za-z0-9_-]{16,}$/.test(s) && !/^[a-z]+([-_][a-z]+)+$/.test(s) && (/\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s))));

/** A page's path as a template: ids become {id}, no query, no fragment. "/v2/location/ab12.../automation/workflows/x" -> "/v2/location/{id}/automation/workflows/{id}". @param {string} url */
export function pageTemplate(url) {
  let p = "/";
  try { p = new URL(url).pathname || "/"; } catch { return "/"; }
  const segs = p.split("/").map(s => (!s ? s : looksLikeId(s) ? "{id}" : /^[A-Za-z0-9_.~:@=,+-]{1,48}$/.test(s) ? s : "{id}"));
  const t = segs.join("/") || "/";
  return t.length > 200 ? "/" : t;
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
      const name = fixed && typeof c.name === "string" && c.name ? c.name : undefined;
      const visits = name && o.nameVisits ? o.nameVisits(origin, `${page}|${role}|${name}`, name) : [];
      if (!identifier && !(name && visits.length >= 2)) continue; // nothing stable to find it by, and nothing that may be stored
      items.push({
        id: `c_${hash(`${page}|${role}|${identifier || name}`)}`, page, role,
        ...(name ? { name, nameVisits: visits } : {}),
        selector: { strategy: identifier ? "identifier" : strategy, ...(identifier ? { identifier } : {}), ...(name && !identifier ? { role, name } : {}) },
        ...(r.trace.fallback === true ? { outcome: "ok", seen: 1 } : { outcome: "ok" }),
      });
    }
    if (items.length) patch.controls = items;
  }

  if (o.op === "api.learn" && Array.isArray(r.entries)) {
    patch.api = r.entries.slice(0, 100).map((/** @type {any} */ e) => ({ ...e, outcome: "ok" }));
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
