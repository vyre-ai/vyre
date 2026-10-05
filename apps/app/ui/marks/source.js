// @ts-check
// The SVG source of every mark in the app, pure (no DOM, no React): one function, markSource(), from (kind, seed, size band, scheme)
// to markup. The generators are the Deck's own (deck/vendor/vyrecode: assistant creature, agent, teammate character, project and space emblem),
// plus the person face v2 ported from the prototype (team/0.2.2/prototype-src/p3o.js personV2) and the device marks of team/0.3/assets.
// Same seed, same mark, on every surface. A mark never falls back to a letter.

import { creature } from "../../src/vendor/deck/vendor/vyrecode/creature.js";
import { character } from "../../src/vendor/deck/vendor/vyrecode/characters.js";
import { emblem } from "../../src/vendor/deck/vendor/vyrecode/emblem.js";
import { agentV2 } from "../../src/vendor/deck/vendor/vyrecode/agent2.js";
import { PROJECT_COLORS } from "../../../../lib/wink-code/identity.js";
import { projectBytes } from "../../../../lib/avatar-seed/index.js";

/** @typedef {"person" | "assistant" | "teammate" | "agent" | "project" | "space" | "device"} MarkKind */
/** @typedef {"dark" | "paper"} Scheme */
/** @typedef {"phone" | "computer" | "server" | "storage"} DeviceType */

export const KINDS = /** @type {const} */ (["person", "assistant", "teammate", "agent", "project", "space", "device"]);
/** The sizes a mark is drawn at. */
export const SIZES = /** @type {const} */ ([16, 20, 24, 28, 32, 40, 44, 56]);

/** A lowercase, hyphenated slug: "Doe estate plan" is "doe-estate-plan". */
export const slug = (/** @type {string} */ s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The seed a mark is drawn from: the entity's own seed when it has one (an actor's `seed`, a project's avatar_seed), else its id, else the slug of its name.
 * A record with no seed gets its emblem from its id bytes (projectBytes); a contact with no photo gets a face from its id.
 * @param {{ id?: string, name?: string, seed?: string }} of
 */
export function seedOf(of) {
  return String(of.seed || of.id || slug(of.name || "") || "vyre");
}

/** Teammates draw one of two bands: below 32 the character drops its badge (characters.js), so 24 and 32 are different drawings. Everything else is one drawing at any size. */
export function sizeBand(/** @type {MarkKind} */ kind, /** @type {number} */ size) {
  return kind === "teammate" ? (size >= 32 ? "l" : "s") : "";
}

/** The cache key: one parse per (kind, seed, band, scheme, device type). Dark and paper only differ for the families that draw their rim or palette by scheme. */
export function markKey(/** @type {MarkKind} */ kind, /** @type {string} */ seed, /** @type {number} */ size, /** @type {Scheme} */ scheme, /** @type {string} */ type = "") {
  const themed = kind === "teammate" || kind === "project" || kind === "space" || kind === "device" || kind === "person";
  return [kind, seed, sizeBand(kind, size), themed ? scheme : "", type].join("|");
}

/** The kind of device a name suggests, when the caller does not say. @param {string} name @returns {DeviceType} */
export function deviceTypeOf(name) {
  const n = String(name || "").toLowerCase();
  if (/phone|pixel|galaxy|android|ipad|tablet/.test(n)) return "phone";
  if (/server|nova|box|droplet|vps/.test(n)) return "server";
  if (/storage|archive|drive|disk|s3|bucket/.test(n)) return "storage";
  return "computer";
}

const DEVICES = {
  phone: '<rect x="40" y="24" width="40" height="72" rx="9"/><path d="M54 84h12" stroke-width="5"/>',
  computer: '<rect x="28" y="34" width="64" height="40" rx="7"/><path d="M20 86h80"/>',
  server: '<rect x="28" y="28" width="64" height="26" rx="7"/><rect x="28" y="66" width="64" height="26" rx="7"/><path d="M42 41h.1M42 79h.1" stroke-width="8"/>',
  storage: '<ellipse cx="60" cy="38" rx="30" ry="12"/><path d="M30 38v44c0 6.6 13.4 12 30 12s30-5.4 30-12V38M30 60c0 6.6 13.4 12 30 12s30-5.4 30-12"/>',
};

function device(/** @type {DeviceType} */ type, /** @type {Scheme} */ scheme) {
  const bg = scheme === "paper" ? "#DDD6C8" : "#2A2825", fg = scheme === "paper" ? "#141311" : "#F1EEE6";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="2" y="2" width="116" height="116" rx="30" fill="${bg}"/><g fill="none" stroke="${fg}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${DEVICES[type] || DEVICES.computer}</g></svg>`;
}

/** Person faces v2: hair, face shape, accessories, so six colleagues read as six people at 24. A straight port of the prototype's personV2. @param {string} seed @param {Scheme} th */
export function person(seed, th) {
  let h = 2166136261;
  const s = "person2:" + seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const pick = (/** @type {string[]} */ a) => a[Math.floor(rnd() * a.length)];
  const BG = ["#F2A58C", "#F3C970", "#86D0BB", "#E39A5B", "#E897C0", "#CDBF9B", "#9CC3E6", "#B9A7E8"];
  const SK = ["#F6D5BC", "#EBBF98", "#D9A173", "#B87F55", "#8D5A3B", "#5E3A26"];
  const HC = ["#2B2118", "#4A3022", "#7A4A2A", "#B5792F", "#C9A24A", "#8E8C8A"];
  const CL = ["#2F3E52", "#7C5A4A", "#4D7A68", "#8A4F5E", "#3D3B44", "#5B6FA8"];
  const bg = pick(BG), skin = pick(SK), hair = pick(HC), cloth = pick(CL);
  const style = Math.floor(rnd() * 7), shape = Math.floor(rnd() * 3), acc = Math.floor(rnd() * 4), eye = Math.floor(rnd() * 3), mouth = Math.floor(rnd() * 3);
  const ink = "#2A1F1A", rx = [25, 22, 27][shape], ry = [26, 28, 24][shape], cy = 56, ex = [9, 8, 10][shape];
  const id = "p2" + String(seed).replace(/[^a-z0-9]/gi, "");
  const back = style === 2 ? `<path d="M33 58 C28 26 48 20 60 20 C74 20 92 28 87 58 L91 96 L29 96Z" fill="${hair}"/>` : "";
  const front = /** @type {Record<number, string>} */ ({
    0: `<path d="M35 50 C35 31 49 25 60 25 C71 25 85 31 85 50 C79 41 41 41 35 50Z" fill="${hair}"/>`,
    1: `<path d="M34 56 C31 29 52 22 67 25 C83 28 89 41 86 56 C81 41 70 37 56 39 C46 41 40 47 34 56Z" fill="${hair}"/>`,
    2: `<path d="M34 54 C34 32 48 26 60 26 C72 26 86 32 86 54 C80 43 70 38 60 38 C50 38 40 43 34 54Z" fill="${hair}"/>`,
    3: [[40, 38, 9], [50, 30, 10], [62, 27, 10], [74, 31, 10], [83, 41, 9], [35, 50, 8], [87, 52, 8]].map((c) => `<circle cx="${c[0]}" cy="${c[1]}" r="${c[2]}" fill="${hair}"/>`).join(""),
    4: `<path d="M36 50 C36 31 50 26 60 26 C70 26 84 31 84 50 C78 41 42 41 36 50Z" fill="${hair}"/><circle cx="60" cy="20" r="10" fill="${hair}"/>`,
    5: `<path d="M33 46 C33 24 87 24 87 46Z" fill="${cloth}"/><rect x="31" y="43" width="58" height="7" rx="3.5" fill="${hair}"/>`,
    6: "",
  })[style];
  const eyes = (/** @type {number} */ x) => eye === 0 ? `<ellipse cx="${x}" cy="${cy + 2}" rx="2.8" ry="3.4" fill="${ink}"/>`
    : eye === 1 ? `<path d="M${x - 4} ${cy + 3} Q${x} ${cy - 3} ${x + 4} ${cy + 3}" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`
    : `<path d="M${x - 4} ${cy + 1} Q${x} ${cy + 5} ${x + 4} ${cy + 1}" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
  const my = cy + 16;
  const m = mouth === 0 ? `<path d="M52 ${my} Q60 ${my + 6} 68 ${my}" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`
    : mouth === 1 ? `<path d="M53 ${my + 1} Q61 ${my + 1} 67 ${my - 3}" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`
    : `<path d="M52 ${my - 2} Q60 ${my + 9} 68 ${my - 2}Z" fill="${ink}"/>`;
  const ac = acc === 1 ? `<circle cx="${60 - ex}" cy="${cy + 2}" r="7.5" fill="none" stroke="${ink}" stroke-width="2.2"/><circle cx="${60 + ex}" cy="${cy + 2}" r="7.5" fill="none" stroke="${ink}" stroke-width="2.2"/><path d="M${60 - ex + 7.5} ${cy + 2}h${2 * ex - 15}" stroke="${ink}" stroke-width="2.2"/>`
    : acc === 2 ? `<rect x="${60 - ex - 8}" y="${cy - 4}" width="16" height="12" rx="3" fill="none" stroke="${ink}" stroke-width="2.2"/><rect x="${60 + ex - 8}" y="${cy - 4}" width="16" height="12" rx="3" fill="none" stroke="${ink}" stroke-width="2.2"/><path d="M${60 - ex + 8} ${cy + 2}h${2 * ex - 16}" stroke="${ink}" stroke-width="2.2"/>`
    : acc === 3 ? [[48, 64], [52, 67], [56, 65], [64, 65], [68, 67], [72, 64]].map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="1.2" fill="#7A4A2A" opacity=".55"/>`).join("") : "";
  const rim = th === "paper" ? "rgba(20,19,17,.18)" : "rgba(241,238,230,.2)";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><clipPath id="${id}"><circle cx="60" cy="60" r="58"/></clipPath></defs><g clip-path="url(#${id})"><rect width="120" height="120" fill="${bg}"/>${back}<path d="M12 124 C12 94 36 86 60 86 C84 86 108 94 108 124Z" fill="${cloth}"/><rect x="52" y="72" width="16" height="18" rx="6" fill="${skin}"/><ellipse cx="60" cy="${cy}" rx="${rx}" ry="${ry}" fill="${skin}"/>${front}${eyes(60 - ex)}${eyes(60 + ex)}${m}${ac}</g><circle cx="60" cy="60" r="57" fill="none" stroke="${rim}" stroke-width="2.4"/></svg>`;
}

/** A teammate's badge colour, from its own id (the prototype's rule: the project colour of the "role-project" seed). */
export const badgeColor = (/** @type {string} */ seed) => PROJECT_COLORS[projectBytes(seed)[0] % PROJECT_COLORS.length];

/** Make every id in a drawing unique to its seed, so two marks on one page never share a clipPath or gradient with another's content. */
export function scopeIds(/** @type {string} */ svg, /** @type {string} */ tag) {
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  let out = svg;
  for (const id of new Set(ids)) out = out.split(`id="${id}"`).join(`id="${id}-${tag}"`).split(`url(#${id})`).join(`url(#${id}-${tag})`);
  return out;
}

const tagOf = (/** @type {string} */ s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };

/**
 * The SVG markup for one mark, on a 120 unit canvas, with no width or height (the caller sizes it). Pure.
 * @param {MarkKind} kind @param {string} seed @param {Scheme} scheme
 * @param {{ size?: number, device?: DeviceType }} [o] size picks the teammate's band; device the device drawing
 */
export function markSource(kind, seed, scheme, o = {}) {
  const size = o.size ?? 32;
  const px = kind === "teammate" ? (size >= 32 ? 40 : 24) : 120;
  let svg;
  switch (kind) {
    case "person": svg = person(seed, scheme); break;
    case "assistant": svg = creature(seed, px); break;
    case "agent": svg = agentV2(seed, px, scheme); break;
    case "teammate": svg = character(seed, px, scheme, /** @type {any} */ (badgeColor(seed))); break;
    case "project":
    case "space": svg = emblem(projectBytes(seed), { theme: scheme, size: 120 }); break;
    case "device": svg = device(o.device || deviceTypeOf(seed), scheme); break;
    default: svg = emblem(projectBytes(seed), { theme: scheme, size: 120 });
  }
  svg = svg.replace(/<svg([^>]*?)\s+width="\d+"\s+height="\d+"/, "<svg$1");
  if (!/viewBox=/.test(svg)) svg = svg.replace("<svg", `<svg viewBox="0 0 ${px} ${px}"`);
  return scopeIds(svg, tagOf(`${kind === "space" ? "project" : kind}|${seed}|${scheme}`));
}
