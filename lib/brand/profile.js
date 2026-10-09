// @ts-check
// The brand profile (0.3.1, R031-60): a space's identity, used as the default for every artifact, preview, document, signing page and screen unless told otherwise.
//
// All of it is optional: a logo (light, dark, a small mark), a primary colour, fonts, density, the company's name, legal name, address and phone, and a letterhead. A colour is never used raw:
// the theme pulls it to the nearest one that keeps text readable (lib/theme nearestPassing), and says so. Logos are small raster images held as data (no network, nothing to run).
import { isHex, nearestPassing } from "../theme/contrast.js";

export const FONTS = ["system", "serif"];
export const DENSITIES = ["compact", "default", "comfortable"];
export const LIMITS = { name: 80, legalName: 120, address: 200, phone: 32, letterhead: 400, logoBytes: 150 * 1024 };
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Check a profile and return it cleaned, or the problems. Unknown keys are refused, so a typo is told, not silently dropped.
 * @param {any} input @returns {{ ok: true, profile: Record<string, any> } | { ok: false, problems: string[] }}
 */
export function normalizeBrand(input) {
  /** @type {string[]} */ const problems = [];
  /** @type {Record<string, any>} */ const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, problems: ["the profile must be an object"] };
  const known = ["name", "legalName", "address", "phone", "colors", "fonts", "density", "logos", "letterhead"];
  for (const k of Object.keys(input)) if (!known.includes(k)) problems.push(`${k} is not part of a brand profile (${known.join(", ")})`);
  for (const k of /** @type {const} */ (["name", "legalName", "address", "phone"])) {
    if (input[k] === undefined || input[k] === null || input[k] === "") continue;
    if (typeof input[k] !== "string" || input[k].length > LIMITS[k]) problems.push(`${k} must be text up to ${LIMITS[k]} characters`);
    else if (/[<>]/.test(input[k])) problems.push(`${k} is plain text, with no markup`);
    else out[k] = input[k].trim();
  }
  if (input.colors !== undefined) {
    const c = input.colors;
    if (!c || typeof c !== "object") problems.push("colors must be { primary, secondary? }");
    else {
      /** @type {Record<string, string>} */ const colors = {};
      for (const k of ["primary", "secondary"]) if (c[k] !== undefined) { if (!isHex(c[k])) problems.push(`colors.${k} must be a hex colour like #3A5BA0`); else colors[k] = String(c[k]).toUpperCase(); }
      for (const k of Object.keys(c)) if (!["primary", "secondary"].includes(k)) problems.push(`colors.${k} is not a colour role (primary, secondary)`);
      if (Object.keys(colors).length) out.colors = colors;
    }
  }
  if (input.fonts !== undefined) {
    const f = input.fonts;
    if (!f || typeof f !== "object") problems.push("fonts must be { heading?, body? }");
    else {
      /** @type {Record<string, string>} */ const fonts = {};
      for (const k of ["heading", "body"]) if (f[k] !== undefined) { if (!FONTS.includes(f[k])) problems.push(`fonts.${k} must be one of ${FONTS.join(", ")}`); else fonts[k] = f[k]; }
      if (Object.keys(fonts).length) out.fonts = fonts;
    }
  }
  if (input.density !== undefined) { if (!DENSITIES.includes(input.density)) problems.push(`density must be one of ${DENSITIES.join(", ")}`); else out.density = input.density; }
  if (input.logos !== undefined) {
    const l = input.logos;
    if (!l || typeof l !== "object") problems.push("logos must be { light?, dark?, mark? }");
    else {
      /** @type {Record<string, string>} */ const logos = {};
      for (const k of ["light", "dark", "mark"]) if (l[k] !== undefined && l[k] !== null) {
        if (typeof l[k] !== "string" || !DATA_IMAGE.test(l[k])) problems.push(`logos.${k} must be a png, jpeg or webp image as a data: URL (no svg, no web address)`);
        else if (l[k].length > LIMITS.logoBytes * 1.4) problems.push(`logos.${k} is larger than ${LIMITS.logoBytes / 1024} KB`);
        else logos[k] = l[k];
      }
      for (const k of Object.keys(l)) if (!["light", "dark", "mark"].includes(k)) problems.push(`logos.${k} is not a logo (light, dark, mark)`);
      if (Object.keys(logos).length) out.logos = logos;
    }
  }
  if (input.letterhead !== undefined) {
    const h = input.letterhead;
    if (!h || typeof h !== "object" || typeof h.on !== "boolean" || (h.text !== undefined && (typeof h.text !== "string" || h.text.length > LIMITS.letterhead || /[<>]/.test(h.text)))) problems.push(`letterhead must be { on: true|false, text?: plain text up to ${LIMITS.letterhead} characters }`);
    else out.letterhead = { on: h.on, ...(h.text ? { text: h.text.trim() } : {}) };
  }
  return problems.length ? { ok: false, problems } : { ok: true, profile: out };
}

/**
 * What every surface reads. The theme part is the space theme the app already takes ({ accent: "custom", hex }), so the guard that keeps text readable applies; `accent` here is the colour
 * as it will be drawn in each scheme, with a note when it moved.
 * @param {Record<string, any>} profile
 */
export function resolveBrand(profile) {
  const primary = profile.colors && profile.colors.primary;
  /** @type {{ dark: string, paper: string, note: string | null } | null} */
  let accent = null;
  if (primary) {
    const dark = nearestPassing(primary, "dark", {}), paper = nearestPassing(primary, "paper", {});
    const where = [paper.changed ? `${paper.hex} on light` : "", dark.changed ? `${dark.hex} on dark` : ""].filter(Boolean);
    accent = { dark: dark.hex, paper: paper.hex, note: where.length ? `${primary} is too low in contrast to read as text on every background; the nearest readable colour is used where it has to be (${where.join(", ")}).` : null };
  }
  return {
    names: { name: profile.name || null, legalName: profile.legalName || null, address: profile.address || null, phone: profile.phone || null },
    theme: { ...(primary ? { accent: "custom", hex: primary } : {}), ...(profile.density ? { density: profile.density } : {}), ...(profile.fonts && profile.fonts.body === "serif" ? { font: "serif" } : {}) },
    accent, fonts: profile.fonts || {}, logos: profile.logos || {}, letterhead: profile.letterhead || { on: false },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- from a website

/** @param {string} s */
const decode = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
/** @param {string} html @param {RegExp} re */
const attr = (html, re) => { const m = re.exec(html); return m ? decode(m[1]) : ""; };

/**
 * A draft profile from a page's HTML: the site name, the theme colour, an icon or logo address (not fetched), a phone and an address from the page's own structured data. The caller fetched the
 * page (a box module has no network of its own); nothing is saved: the person sees the draft and says yes.
 * @param {string} html @param {string} [url]
 * @returns {{ draft: Record<string, any>, found: string[], logoUrl: string }}
 */
export function brandFromHtml(html, url = "") {
  const h = String(html).slice(0, 400_000);
  /** @type {Record<string, any>} */ const draft = {};
  /** @type {string[]} */ const found = [];
  const meta = (/** @type {string} */ name) => attr(h, new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i")) || attr(h, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"));
  const name = meta("og:site_name") || attr(h, /<title[^>]*>([^<]{1,120})<\/title>/i).split(/[|–—\-]/)[0].trim();
  if (name) { draft.name = name.slice(0, LIMITS.name); found.push("name"); }
  const theme = meta("theme-color");
  if (isHex(theme)) { draft.colors = { primary: theme.toUpperCase() }; found.push("colour"); }
  /** @type {any[]} */ const ld = [];
  for (const m of h.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { const j = JSON.parse(m[1]); ld.push(...(Array.isArray(j) ? j : j["@graph"] || [j])); } catch { /* not JSON */ } }
  const org = ld.find(x => x && /Organization|LocalBusiness|LegalService|Attorney|ProfessionalService/.test(String(x["@type"])));
  if (org) {
    if (org.legalName) { draft.legalName = String(org.legalName).slice(0, LIMITS.legalName); found.push("legal name"); }
    if (!draft.name && org.name) { draft.name = String(org.name).slice(0, LIMITS.name); found.push("name"); }
    if (org.telephone) { draft.phone = String(org.telephone).slice(0, LIMITS.phone); found.push("phone"); }
    const a = org.address;
    if (a && typeof a === "object") { const line = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(", "); if (line) { draft.address = line.slice(0, LIMITS.address); found.push("address"); } }
  }
  if (!draft.phone) { const tel = attr(h, /href=["']tel:([^"']{5,32})["']/i); if (tel) { draft.phone = tel; found.push("phone"); } }
  let logo = (org && typeof org.logo === "string" && org.logo) || meta("og:image") || attr(h, /<link[^>]+rel=["'](?:apple-touch-icon|icon)["'][^>]*href=["']([^"']+)["']/i);
  if (logo && url) { try { logo = new URL(logo, url).href; } catch { logo = ""; } }
  if (logo && !/^https:\/\//.test(logo)) logo = "";
  if (logo) found.push("logo address");
  return { draft, found, logoUrl: logo };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- signing pages

/** A hex colour as the "h s% l%" triple the signing page's palette variables take. @param {string} hex */
function hslOf(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, sat = 0;
  if (d) {
    sat = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(((h * 60) + 360) % 360);
  }
  return `${h} ${Math.round(sat * 100)}% ${Math.round(l * 100)}%`;
}
/** Text for a CSS string: quotes, backslashes and line ends made harmless. @param {string} t */
const cssText = t => String(t).replace(/[\\"]/g, c => "\\" + c).replace(/[\r\n\u2028\u2029]/g, " ").replace(/[<>]/g, "");

/**
 * What a public signing page takes from the brand: the space's colour for the page's buttons and links (readable on the page's own paper), and a quiet band at the top with the logo and the company's
 * name. Pure CSS: a stylesheet served from the page's own origin, no script, no markup from the profile (the name is plain text, a logo is the profile's own data: image).
 * @param {ReturnType<typeof resolveBrand>} b @returns {string}
 */
export function signingBrand(b) {
  const out = [];
  if (b.accent) {
    const light = hslOf(b.accent.paper), dark = hslOf(b.accent.dark);
    out.push(`:root,[data-theme]{--p:${light};--pf:${light};--a:${light}}@media (prefers-color-scheme:dark){:root,[data-theme]{--p:${dark};--pf:${dark};--a:${dark}}}`);
    out.push(`a:not(.btn){color:hsl(${light})}@media (prefers-color-scheme:dark){a:not(.btn){color:hsl(${dark})}}`);
  }
  if (b.fonts.body === "serif") out.push('body{font-family:Georgia,"Times New Roman",serif}');
  const logo = b.logos.light || b.logos.mark || "";
  const name = b.names.name || b.names.legalName || "";
  if (logo || name) {
    out.push(`body::before{content:"${cssText(name)}";display:flex;align-items:center;gap:12px;box-sizing:border-box;min-height:48px;padding:8px 16px;font:600 15px/1.2 system-ui,sans-serif;${logo ? `background:url("${logo}") no-repeat 16px center/auto 32px;padding-left:${name ? 64 : 16}px;` : ""}border-bottom:1px solid rgba(128,128,128,.25)}`);
    if (b.logos.dark && logo) out.push(`@media (prefers-color-scheme:dark){body::before{background-image:url("${b.logos.dark}")}}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- artifacts

const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"']/g, c => /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * What an artifact page takes from the brand by default: custom properties the page's own stylesheet already reads (--font, --hfont) plus the accent, and a quiet letterhead when the profile
 * turns it on. A document's own theme comes after, so a document that says otherwise wins. Public share snapshots take none of it: they are stripped of who and where.
 * @param {ReturnType<typeof resolveBrand>} b
 * @returns {{ css: string, header: string }}
 */
export function artifactBrand(b) {
  /** @type {string[]} */ const light = [], dark = [];
  if (b.accent) { light.push(`--accent:${b.accent.paper}`); dark.push(`--accent:${b.accent.dark}`); }
  const serif = 'Georgia,"Times New Roman",serif';
  const root = [];
  if (b.fonts.body === "serif") root.push(`--font:${serif}`);
  if (b.fonts.heading === "serif") root.push(`--hfont:${serif}`);
  const css = [
    (light.length || root.length) ? `:root{${[...root, ...light].join(";")}}` : "",
    dark.length ? `@media (prefers-color-scheme:dark){:root{${dark.join(";")}}}` : "",
    b.accent ? "a{color:var(--accent)}blockquote{border-left-color:var(--accent)}.letterhead{border-bottom:2px solid var(--accent)}" : "",
    b.letterhead.on ? ".letterhead{display:flex;gap:12px;align-items:center;padding-bottom:12px;margin-bottom:24px;border-bottom:1px solid var(--rule)}.letterhead img{height:40px;width:auto}.letterhead b{display:block}.letterhead small{color:var(--t2);display:block;line-height:1.4}" : "",
  ].filter(Boolean).join("");
  let header = "";
  if (b.letterhead.on) {
    const logo = b.logos.light || b.logos.mark || "";
    const lines = [b.names.legalName || b.names.name, b.names.address, b.names.phone].filter(Boolean);
    header = `<header class="letterhead">${logo ? `<picture>${b.logos.dark ? `<source media="(prefers-color-scheme:dark)" srcset="${esc(b.logos.dark)}">` : ""}<img alt="" src="${esc(logo)}"></picture>` : ""}<div>${b.names.name ? `<b>${esc(b.names.name)}</b>` : ""}${lines.map(l => `<small>${esc(String(l))}</small>`).join("")}${b.letterhead.text ? `<small>${esc(b.letterhead.text)}</small>` : ""}</div></header>`;
  }
  return { css, header };
}
