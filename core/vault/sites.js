// @ts-check
// sites: the origins a login of a member's own vault is saved for, as bare https origins (https://host, no path, no login in it, never a value). The address fields of a login are url, website, origin and urls
// (several, split on spaces, commas or lines). Used to list them for the # picker (vault.me.list) and to pick the site a turn lend signs in to.

const KEYS = ["url", "website", "origin", "urls"];
const MAX = 10;

/** @param {Record<string, any> | undefined} fields @returns {string[]} */
export function sitesOf(fields) {
  /** @type {string[]} */ const out = [];
  for (const k of KEYS) {
    const v = fields && typeof fields[k] === "string" ? fields[k] : "";
    for (const part of v.split(/[\s,;]+/)) {
      if (!part) continue;
      let u; try { u = new URL(part); } catch { continue; }
      if (u.protocol !== "https:" || u.username || u.password) continue;
      if (!out.includes(u.origin)) out.push(u.origin);
      if (out.length >= MAX) return out;
    }
  }
  return out;
}
