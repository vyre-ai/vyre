// @ts-check
// Every avatar the Deck draws, in the five families of ADR 0043 (docs/design/system/components/
// avatar.md), each with a silhouette no other family uses:
//
//   person     a true circle, a warm gradient and a calm face; at large sizes (Settings > You)
//              the Vyre code ring around it. Seeded from owner.fingerprint8 (system.info), the
//              first 8 bytes of sha256("vyre:person:v1:" + hex(owner.id)), never a device or box key.
//   assistant  its companion creature, seeded from assistant.fingerprint8 (the same with
//              "vyre:assistant:v1:"). Drawn only where the assistant itself speaks across
//              projects: its own threads, and the agent lists.
//   agent      a blob, seeded from the agent's name, agents_agents' primary key and so its stable
//              id today. Renaming an agent gives it a new blob; an immutable agent id can come later.
//   teammate   a character on a rounded-square tile, seeded from its teammate id
//              ("<role>-<project>", core/team's agentName), wearing its project's colour as a badge.
//   project    a tile with a mark and a colour, seeded from the project's stored avatar_seed
//              (projects.list; the slug when a project has none). Every session in a project shows
//              it on its replies. A chat in no project shows a DRAFT tile (dashed) seeded from the
//              chat's own id; made into a new project it keeps that seed (projects.create
//              from_thread) and turns solid; filed into an existing project it takes that tile.
//
// The default look comes from the fingerprint (defaultAvatarOption). A stored pick is 0.1.2.
// When a fingerprint is missing (a box from before owner.id), the person falls back to a face
// picked from their name and the assistant to a creature seeded from its name: no crash, and no
// Vyre code ring, because a ring must only ever encode the real fingerprint.
//
// THIS FILE IS THE ONLY IMPORTER of the generated-avatar renderers (deck/vendor/vyrecode, locked
// by app-design: 949d9e78 skin-tone floors, e84bb767 project tiles). A renderer swap is a change
// here and in the vendor folder only.
//
// Speed: each (family, seed, size band, theme) is parsed once into an SVG template and cloned after
// that, so a long chat pays one parse per distinct author, not one per row. Clones get their own
// gradient ids, so a template's gradient never resolves to a hidden copy elsewhere on the page. A
// theme switch redraws the avatars on the page in place (installAvatars).

import { userAvatar, USER_GRADIENTS, PROJECT_COLORS, defaultAvatarOption } from "../../lib/wink-code/identity.js";
import { creature } from "../vendor/vyrecode/creature.js";
import { character } from "../vendor/vyrecode/characters.js";
import { emblem } from "../vendor/vyrecode/emblem.js";
import { agentV2 } from "../vendor/vyrecode/agent2.js";
import { renderCode2, bitsToLevels } from "../../lib/wink-code/vyrecode2.js";
import { buildCodeword, bytesToBits } from "../../lib/wink-code/payload.js";
// A project tile's 8 bytes: the one shared rule (Node and the Deck load this same file; the
// Lumen ports it against its vectors). core/daemon serves it at /lib/avatar-seed/index.js.
import { projectBytes, entityBytes, fnv1a32, BASIS_A } from "../../lib/avatar-seed/index.js";

export { projectBytes };

/** @typedef {"person" | "assistant" | "agent" | "teammate" | "project"} Family */
/** @typedef {{ size?: number, label?: string|null, title?: string|null, cls?: string, ref?: string|null }} Opts */
/** @typedef {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} Attempt */

/** How many looks the person's circle has (defaultAvatarOption's modulus). */
export const PERSON_OPTIONS = USER_GRADIENTS.length;

/** At or above this size an avatar can wear its Vyre code ring (ADR 0043 section 2; design-system.md section 6: the card and the Wink screen, never a small avatar). */
export const RING_AT = 96;
/** Characters drop their badges below 32 (characters.js), so 24 and 32 are different drawings. */
const band = (/** @type {Family} */ family, /** @type {number} */ size) => family === "teammate" ? (size >= 32 ? "l" : "s") : "";

/** The teammate id core/team gives a role in a project (core/team/index.js agentName). */
export const teammateId = (/** @type {string} */ role, /** @type {string|null|undefined} */ project) =>
  project ? `${role}-${project}`.slice(0, 31).replace(/-+$/, "") : String(role || "");

// ---- who is who ----------------------------------------------------------------------------

/** @type {{ owner: { name: string|null, fp: number[]|null }, assistant: { name: string|null, fp: number[]|null }, host: string|null }} */
const who = { owner: { name: null, fp: null }, assistant: { name: null, fp: null }, host: null };
/** Teammate id to its project's slug (team.list), so a teammate's thread draws a character with its project's colour. */
/** @type {Map<string, string|null>} */ const teammates = new Map();
/** Project slug to its avatar_seed (projects.list). */
/** @type {Map<string, string>} */ const projects = new Map();

/**
 * A fingerprint as system.info sends it: base64url, 11 characters, 8 bytes (lib/identity.js's
 * toBase64url). lib/identity.js itself is Node-only (node:crypto, Buffer), so the Deck decodes
 * here; avatars.test.js checks this against lib/identity's own encoding. Anything else is null.
 * @param {unknown} s @returns {number[]|null}
 */
export function fpBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=");
    return bin.length === 8 ? Array.from(bin, c => c.charCodeAt(0)) : null;
  } catch { return null; }
}

/**
 * What system.info says about the person and the assistant. Safe to call again (a rename, the
 * fingerprint landing after an upgrade); drawings made earlier keep their look until redrawn.
 * @param {{ owner?: { name?: string|null, fingerprint8?: string|null }|null, assistant?: { name?: string|null, fingerprint8?: string|null }|null, host?: string|null }} info
 */
export function setIdentity(info) {
  who.owner = { name: info?.owner?.name || null, fp: fpBytes(info?.owner?.fingerprint8) };
  who.assistant = { name: info?.assistant?.name || null, fp: fpBytes(info?.assistant?.fingerprint8) };
  who.host = info?.host || null;
}

/** team.list's rows ({agent, project}), or bare teammate ids. @param {Iterable<any>} rows */
export function setTeammates(rows) {
  teammates.clear();
  for (const r of rows) {
    const id = typeof r === "string" ? r : r?.agent;
    if (id) teammates.set(String(id), typeof r === "string" ? null : r.project || null);
  }
}
export const isTeammate = (/** @type {string} */ id) => teammates.has(String(id || ""));

/** projects.list's rows ({slug, avatar_seed}). @param {Iterable<any>} rows */
export function setProjects(rows) {
  for (const p of rows) if (p?.slug) projects.set(String(p.slug), String(p.avatar_seed || p.slug));
}
/** A project's tile seed: its stored avatar_seed, else its slug (never its name). */
export const projectSeed = (/** @type {string} */ slug) => projects.get(String(slug)) || String(slug || "");

/** @type {Promise<void>|null} */ let reading = null;
/** @type {Promise<void>|null} */ let readingTeam = null;
/** @type {Promise<void>|null} */ let readingProjects = null;
/** team.list, once per page load (asked again after a failure; without it every agent is a blob). @param {Attempt} attempt */
export function readTeammates(attempt) {
  if (!readingTeam) {
    readingTeam = attempt("team.list", {}).then(t => {
      if (t.error) { readingTeam = null; return; }
      setTeammates(Array.isArray(t.data) ? t.data : t.data?.teammates || []);
    });
  }
  return readingTeam;
}
/**
 * projects.list's seeds, once per page load (a view that reads projects.list itself calls
 * setProjects). `again`: read afresh (a project was just made or a chat filed).
 * @param {Attempt} attempt @param {{ again?: boolean }} [o]
 */
export function readProjects(attempt, o = {}) {
  if (!readingProjects || o.again) {
    readingProjects = attempt("projects.list", {}, { share: true }).then(r => { if (r.error) readingProjects = null; else setProjects(r.data?.projects || []); });
  }
  return readingProjects;
}
/** system.info, once per page load, for a view that has not read it itself (chat's readNames passes its own read to setIdentity). @param {Attempt} attempt */
export function readSystem(attempt) {
  if (!reading) reading = attempt("system.info").then(s => { if (s.error) reading = null; else setIdentity(s.data || {}); });
  return reading;
}
/** system.info, team.list and projects.list together. Any may be missing; the avatars then use their fallbacks. @param {Attempt} attempt */
export const readIdentity = attempt => Promise.all([readSystem(attempt), readTeammates(attempt), readProjects(attempt)]).then(() => {});

// ---- drawing -------------------------------------------------------------------------------

/** A small stable number from a string (FNV-1a), for a fallback option only. */
const small = (/** @type {string} */ s) => fnv1a32(s, BASIS_A);

/** A project's colour (the teammate badge), from its seed. */
export const projectColor = (/** @type {string} */ seed) => PROJECT_COLORS[projectBytes(seed)[0] % PROJECT_COLORS.length];

/** The theme the palettes follow (theme-live.js sets data-theme="paper" or nothing). */
const theme = () => (typeof document !== "undefined" && document.documentElement?.dataset?.theme === "paper") ? "paper" : "dark";

/**
 * The SVG source for one avatar. Pure; exported for tests and the cache below.
 * @param {Family} family @param {string} seed @param {number} size
 * @param {{ fp?: number[]|null, ring?: boolean, theme?: "dark"|"paper", option?: number, draft?: boolean, color?: string|null }} [o]
 *   `option`: a person's look chosen by the caller (pair-avatar.js's stopgap), over the fingerprint's
 *   default; `draft`: a project tile's dashed style; `color`: a teammate's project colour
 */
export function avatarSource(family, seed, size, o = {}) {
  const th = o.theme || "dark";
  if (family === "person") {
    const option = Number.isInteger(o.option) ? /** @type {number} */ (o.option) % PERSON_OPTIONS
      : o.fp ? defaultAvatarOption(o.fp, PERSON_OPTIONS) : small(seed) % PERSON_OPTIONS;
    if (o.ring && o.fp) return renderCode2(bitsToLevels(bytesToBits(buildCodeword(o.fp))), { userOption: option, style: "ticksSunburst", theme: th, size });
    return userAvatar(option, size);
  }
  const bytes = o.ring ? ringBytes(family, seed, o) : null;
  if (bytes) {
    // The same mark inside the same ring: the family's own drawing is the ring's centre (the faceSvg hook).
    return renderCode2(bitsToLevels(bytesToBits(buildCodeword(bytes))), {
      userOption: bytes[0] % PERSON_OPTIONS, style: "ticksSunburst", theme: th, size,
      faceSvg: d => inClearCentre(mark(family, seed, d, o)),
    });
  }
  return mark(family, seed, size, o);
}

/** A non-person family's own mark. @param {Family} family @param {string} seed @param {number} size @param {{ theme?: "dark"|"paper", draft?: boolean, color?: string|null }} o */
function mark(family, seed, size, o) {
  const th = o.theme || "dark";
  if (family === "assistant") return creature(seed, size);
  if (family === "teammate") return character(seed, size, th, o.color || null);
  if (family === "project") return emblem(projectBytes(seed), { draft: !!o.draft, theme: th, size });
  return agentV2(seed, size, th);
}

/**
 * The 8 bytes a ring carries, or null where it must not draw one. The person's and the assistant's are
 * their real fingerprint8 (no fingerprint, no ring); a project's are the bytes its emblem is drawn from;
 * an agent's and a teammate's come from lib/avatar-seed entityBytes. A draft tile is no identity yet.
 * @param {Family} family @param {string} seed @param {{ fp?: number[]|null, draft?: boolean }} o @returns {number[]|null}
 */
export function ringBytes(family, seed, o = {}) {
  if (family === "person" || family === "assistant") return o.fp && o.fp.length === 8 ? o.fp : null;
  if (family === "project") return o.draft ? null : projectBytes(seed);
  return seed ? entityBytes(family, seed) : null;
}

/**
 * A mark drawn at 120 units, kept inside the ring's clear centre: scaled to 0.86 (a rounded tile's
 * corners reach 1.16 times the centre's radius) and clipped to the centre circle, so no mark can
 * touch the ticks. @param {string} svg a mark's own SVG, viewBox 0 0 120 120
 */
function inClearCentre(svg) {
  const inner = svg.replace(/<svg[^>]*>|<\/svg>/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><clipPath id="vy-cc"><circle cx="60" cy="60" r="60"/></clipPath></defs><g clip-path="url(#vy-cc)"><g transform="translate(60 60) scale(0.86) translate(-60 -60)">${inner}</g></g></svg>`;
}

const MAX = 256;
/** @type {Map<string, Element>} */ const cache = new Map();
/** Each template's source, for a DOM whose importNode hands back the same node (the test fakes). */
/** @type {WeakMap<Element, string>} */ const sources = new WeakMap();
let uid = 0;
/** @type {DOMParser|null} */ let parser = null;

/** A parsed SVG for `src`, from the cache when it has been drawn before. Null without a DOM parser. */
function template(/** @type {string} */ key, /** @type {() => string} */ src) {
  let t = cache.get(key);
  if (t) { cache.delete(key); cache.set(key, t); return t; }
  if (typeof DOMParser === "undefined") return null;
  const text = src();
  t = parse(text);
  if (!t) return null;
  sources.set(t, text);
  cache.set(key, t);
  if (cache.size > MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
  return t;
}

function parse(/** @type {string} */ text) {
  const t = /** @type {Element} */ ((parser ||= new DOMParser()).parseFromString(text, "image/svg+xml").documentElement);
  if (!t || t.nodeName === "parsererror") return null;
  t.setAttribute("width", "100%"); t.setAttribute("height", "100%");
  t.setAttribute("aria-hidden", "true"); t.setAttribute("focusable", "false");
  return t;
}

/** A copy of a template, its gradient ids made unique to it. */
function copy(/** @type {Element} */ t) {
  let n = /** @type {Element} */ (typeof document.importNode === "function" ? document.importNode(t, true) : t.cloneNode(true));
  if (n === t) n = parse(/** @type {string} */ (sources.get(t))) || t;
  const ids = typeof n.querySelectorAll === "function" ? n.querySelectorAll("[id]") : [];
  if (ids.length) {
    const tag = `-a${++uid}`;
    /** @type {Map<string, string>} */ const moved = new Map();
    for (const el of ids) { const old = /** @type {string} */ (el.getAttribute("id")); moved.set(`url(#${old})`, `url(#${old}${tag})`); el.setAttribute("id", old + tag); }
    const walk = (/** @type {any} */ el) => {
      for (const attr of ["fill", "stroke"]) { const v = el.getAttribute(attr); if (v && moved.has(v)) el.setAttribute(attr, /** @type {string} */ (moved.get(v))); }
      for (const c of el.childNodes || []) if (typeof c.getAttribute === "function") walk(c);
    };
    walk(n);
  }
  return n;
}

/** The drawing inside an avatar's span, for its spec, in the current theme. */
function drawing(/** @type {{ family: Family, seed: string, size: number, fp: number[]|null, ring: boolean, draft: boolean, color: string|null, fallback: string }} */ s) {
  // Only these families change with the theme (rims and the ring's palette); the rest share one template.
  const themed = s.ring || s.family === "teammate" || s.family === "project";
  const th = themed ? theme() : "dark";
  const key = [s.family, s.seed, s.fp ? s.fp.join(".") : "", band(s.family, s.size), s.ring ? "r" : "", s.draft ? "d" : "", s.color || "", themed ? th : ""].join("|");
  let t = null;
  const px = s.family === "teammate" ? (s.size >= 32 ? 40 : 24) : 120;
  try { t = template(key, () => avatarSource(s.family, s.seed, px, { fp: s.fp, ring: s.ring, theme: th, draft: s.draft, color: s.color })); } catch { t = null; }
  return t ? copy(t) : s.fallback;
}

/**
 * One avatar as an element: a span sized by --av, holding the family's inline SVG. Decorative by
 * default (the name sits beside it); `label` makes it an image with that name.
 * @param {Family} family @param {string} seed
 * @param {Opts & { fp?: number[]|null, ring?: boolean, draft?: boolean, color?: string|null }} [o]
 */
export function avatar(family, seed, o = {}) {
  const size = o.size || 24;
  const draftTile = family === "project" && !!o.draft;
  const ring = !!(o.ring && size >= RING_AT && ringBytes(family, seed, { fp: o.fp, draft: draftTile }));
  const draft = draftTile;
  const el = document.createElement("span");
  el.setAttribute("class", `vy-av vy-av-${family}${ring ? " vy-av-ring" : ""}${draft ? " vy-av-draft" : ""}${o.cls ? " " + o.cls : ""}`);
  el.setAttribute("style", `--av:${size}px`);
  el.setAttribute("data-family", family);
  if (draft) el.setAttribute("data-draft", "");
  if (o.ref) el.setAttribute("data-ref", String(o.ref));
  if (o.title) el.setAttribute("title", o.title);
  if (o.label) { el.setAttribute("role", "img"); el.setAttribute("aria-label", o.label); } else el.setAttribute("aria-hidden", "true");
  const spec = { family, seed: String(seed), size, fp: o.fp || null, ring, draft, color: o.color || null,
    fallback: String(o.label || o.title || seed || "?").trim().charAt(0).toLowerCase() };
  /** @type {any} */ (el)._av = spec;
  el.append(drawing(spec));
  return el;
}

/** The owner's and the assistant's names and fingerprints (system.info), for the avatar card. */
export function whoIs() { return who; }

/** The person (the owner of this Vyre). `ring` draws the Vyre code at RING_AT and above. */
export function personAvatar(/** @type {Opts & { ring?: boolean }} */ o = {}) {
  const seed = "vyre:person:fallback:" + (who.owner.name || who.host || "you");
  return avatar("person", seed, { ...o, fp: who.owner.fp });
}

/** The person's assistant: its creature. */
export function assistantAvatar(/** @type {Opts} */ o = {}) {
  const fp = who.assistant.fp;
  const seed = fp ? fp.map(b => b.toString(16).padStart(2, "0")).join("") : "vyre:assistant:fallback:" + (who.assistant.name || "vyre");
  return avatar("assistant", seed, { ...o, fp });
}

/** An agent by its stable id (its name): a blob, or a character when team.list says it is a teammate. */
export function agentAvatar(/** @type {string} */ id, /** @type {Opts} */ o = {}) {
  return isTeammate(id) ? teammateAvatar(id, o) : avatar("agent", String(id || ""), { ref: String(id || ""), ...o });
}

/**
 * A teammate by its teammate id ("<role>-<project>", see teammateId): its character, with its
 * project's colour as a badge. `project`: its project's slug when the caller knows it (the
 * handoff card), else team.list's.
 */
export function teammateAvatar(/** @type {string} */ id, /** @type {Opts & { project?: string|null }} */ o = {}) {
  const slug = o.project || teammates.get(String(id)) || null;
  return avatar("teammate", String(id || ""), { ref: String(id || ""), ...o, color: slug ? projectColor(projectSeed(slug)) : null });
}

/** A project's tile by its slug (its stored avatar_seed, else the slug). */
export function projectAvatar(/** @type {string} */ slug, /** @type {Opts} */ o = {}) {
  return avatar("project", projectSeed(slug), { ref: String(slug || ""), ...o });
}

/** A chat in no project: the draft tile, seeded from the chat's id (carried over if it becomes a project). */
export function draftAvatar(/** @type {string} */ thread, /** @type {Opts} */ o = {}) {
  return avatar("project", String(thread || ""), { ...o, draft: true });
}

/**
 * Whoever is asking when the record does not say: a neutral silhouette, not a seeded face, so no one is credited with it. The caller
 * labels it "An agent".
 * @param {Opts} [o]
 */
export function unknownActorAvatar(o = {}) {
  const size = o.size || 24;
  const el = document.createElement("span");
  el.setAttribute("class", `vy-av vy-av-unknown${o.cls ? " " + o.cls : ""}`);
  el.setAttribute("style", `--av:${size}px`);
  el.setAttribute("data-family", "unknown");
  if (o.label) { el.setAttribute("role", "img"); el.setAttribute("aria-label", o.label); } else el.setAttribute("aria-hidden", "true");
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}"><circle cx="60" cy="60" r="58" fill="currentColor" fill-opacity=".14"/><circle cx="60" cy="48" r="18" fill="currentColor" fill-opacity=".45"/><path d="M26 100c4-22 17-32 34-32s30 10 34 32a58 58 0 0 1-68 0z" fill="currentColor" fill-opacity=".45"/></svg>`;
  const parsed = parse(src);
  if (parsed) el.append(document.importNode(parsed, true));
  return el;
}

/** Whether `agent` names the assistant: no agent, a Claude label, or the assistant's own name (chat/lib/names.js's rule). */
const isAssistantName = (/** @type {string} */ a) => !a || /claude/i.test(a) || a === who.assistant.name;

/**
 * Whoever an agent list's row names: the assistant's creature, a teammate, or an agent.
 * @param {string|null|undefined} agent @param {Opts} [o]
 */
export function whoAvatar(agent, o = {}) {
  const a = String(agent ?? "").trim();
  return isAssistantName(a) ? assistantAvatar(o) : agentAvatar(a, o);
}

/**
 * Who a session's replies are from, as its rows and header draw it (ADR 0043 section 6): a
 * teammate's character or an agent's blob when an agent runs the thread; the assistant's creature
 * when the assistant itself speaks (its own thread, across projects); otherwise the session's
 * project tile, or the draft tile of a chat in no project, seeded from the chat's id.
 * @param {{ agent?: string|null, project?: string|null, thread?: string|null }} t @param {Opts} [o]
 */
export function threadAvatar(t, o = {}) {
  const a = String(t.agent ?? "").trim();
  if (a && who.assistant.name && a === who.assistant.name) return assistantAvatar(o);
  if (a && !/claude/i.test(a)) return agentAvatar(a, o);
  if (t.project) return projectAvatar(t.project, o);
  // A chat in no project is the assistant's own to answer: its creature, never the dashed draft tile (it read as a warning, #33).
  return assistantAvatar(o);
}

// ---- the page ------------------------------------------------------------------------------

/**
 * Redraw every avatar under `root` from its own spec, in the current theme (a theme switch). The
 * spans stay; only the drawing inside is swapped, so nothing around them moves.
 * @param {ParentNode} [root]
 */
export function redrawAvatars(root = document) {
  if (typeof root.querySelectorAll !== "function") return;
  for (const el of /** @type {any} */ (root.querySelectorAll(".vy-av"))) {
    if (!el._av) continue;
    el.replaceChildren(drawing(el._av));
  }
}

/**
 * Installed once for the page: a tap on any avatar plays a small hop (deck.css .vy-av-play),
 * restarted by each tap and nothing under prefers-reduced-motion; and a theme switch redraws the
 * avatars on the page. Document-level, so avatars drawn later need no listener of their own.
 * @param {Document} [doc]
 */
export function installAvatars(doc = document) {
  const still = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  doc.addEventListener("click", e => {
    const t = /** @type {any} */ (e.target);
    const av = t && typeof t.closest === "function" ? t.closest(".vy-av") : null;
    if (!av || still?.matches) return;
    av.classList.remove("vy-av-play");
    void av.offsetWidth; // restart the animation on a second tap
    av.classList.add("vy-av-play");
  }, true);
  doc.addEventListener("animationend", e => {
    const t = /** @type {any} */ (e.target);
    if (t?.classList?.contains("vy-av-play")) t.classList.remove("vy-av-play");
  }, true);
  if (typeof MutationObserver === "function" && doc.documentElement) {
    let last = theme();
    new MutationObserver(() => { const now = theme(); if (now !== last) { last = now; redrawAvatars(doc); } })
      .observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
}
/** The earlier name, kept for callers of the first cut. */
export const installAvatarMotion = installAvatars;

/** For tests: forget the cache and who is who. */
export function _reset() {
  cache.clear(); teammates.clear(); projects.clear();
  reading = null; readingTeam = null; readingProjects = null; setIdentity({});
}
