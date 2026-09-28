// @ts-check
// Every avatar the Deck draws, in the four families of ADR 0043 (docs/design/system/components/
// avatar.md), each with a silhouette no other family uses:
//
//   person     a true circle, a warm gradient and a calm face; at large sizes (Settings > You)
//              the Vyre code ring around it. Seeded from owner.fingerprint8 (system.info), which
//              is sha256("vyre:person:v1:" + hex(owner.id))[0:8], never a device or box key.
//   assistant  its companion creature, seeded from assistant.fingerprint8
//              (sha256("vyre:assistant:v1:" + hex(owner.id))[0:8]).
//   agent      a blob, seeded from the agent's stable id (agents_agents.name, its primary key).
//   teammate   a character on a rounded-square tile, seeded from its teammate id
//              ("<role>-<project>", core/team's agentName).
//
// The default look comes from the fingerprint (defaultAvatarOption). A stored pick is 0.1.2.
// When a fingerprint is missing (a box from before owner.id), the person falls back to a face
// picked from their name and the assistant to a creature seeded from its name: no crash, and no
// Vyre code ring, because a ring must only ever encode the real fingerprint.
//
// THIS FILE IS THE ONLY IMPORTER of the generated-avatar renderers (deck/vendor/vyrecode). When
// app-design sends the locked files, swapping them is a change here and in the vendor folder only.
//
// Speed: each (family, seed, size band) is parsed once into an SVG template and cloned after that,
// so a long chat pays one parse per distinct author, not one per row. Clones get their own
// gradient ids, so a template's gradient never resolves to a hidden copy elsewhere on the page.

import { userAvatar, USER_GRADIENTS, defaultAvatarOption } from "../vendor/vyrecode/identity.js";
import { creature } from "../vendor/vyrecode/creature.js";
import { blob, character } from "../vendor/vyrecode/characters.js";
import { renderCode2, bitsToLevels } from "../vendor/vyrecode/vyrecode2.js";
import { buildCodeword, bytesToBits } from "../vyrecode/payload.js";

/** @typedef {"person" | "assistant" | "agent" | "teammate"} Family */

/** How many looks the person's circle has (defaultAvatarOption's modulus). */
export const PERSON_OPTIONS = USER_GRADIENTS.length;

/** At or above this size the person's circle wears its Vyre code ring (ADR 0043 section 2). */
export const RING_AT = 96;
/** Characters drop their role badge below 32 (characters.js), so 24 and 32 are different drawings. */
const band = (/** @type {Family} */ family, /** @type {number} */ size) => family === "teammate" ? (size >= 32 ? "l" : "s") : "";

/** The teammate id core/team gives a role in a project (core/team/index.js agentName). */
export const teammateId = (/** @type {string} */ role, /** @type {string|null|undefined} */ project) =>
  project ? `${role}-${project}`.slice(0, 31).replace(/-+$/, "") : String(role || "");

// ---- who is who ----------------------------------------------------------------------------

/** @type {{ owner: { name: string|null, fp: number[]|null }, assistant: { name: string|null, fp: number[]|null }, host: string|null }} */
const who = { owner: { name: null, fp: null }, assistant: { name: null, fp: null }, host: null };
/** Teammate ids (team.list), so a thread by a teammate draws a character, not a blob. */
const teammates = new Set();

/** 16 hex chars (8 bytes) to bytes; anything else (missing, short, not hex) is null. */
export function fpBytes(/** @type {unknown} */ hex) {
  const s = typeof hex === "string" ? hex.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{16,}$/.test(s)) return null;
  return Array.from({ length: 8 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
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

/** @param {Iterable<string>} ids teammate ids */
export function setTeammates(ids) { teammates.clear(); for (const id of ids) if (id) teammates.add(String(id)); }
export const isTeammate = (/** @type {string} */ id) => teammates.has(String(id || ""));

/** @type {Promise<void>|null} */ let reading = null;
/** @type {Promise<void>|null} */ let readingTeam = null;
/**
 * team.list, read once per page load (a failure is asked again next time; with no team module
 * every agent draws as a blob).
 * @param {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} attempt
 */
export function readTeammates(attempt) {
  if (!readingTeam) {
    readingTeam = attempt("team.list", {}).then(t => {
      if (t.error) { readingTeam = null; return; }
      const rows = Array.isArray(t.data) ? t.data : t.data?.teammates || [];
      setTeammates(rows.map((/** @type {any} */ r) => r.agent));
    });
  }
  return readingTeam;
}

/**
 * system.info, read once per page load (a failure is asked again next time), for a view that
 * has not read it itself (chat's readNames passes its own read to setIdentity).
 * @param {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} attempt
 */
export function readSystem(attempt) {
  if (!reading) reading = attempt("system.info").then(s => { if (s.error) reading = null; else setIdentity(s.data || {}); });
  return reading;
}

/** system.info and team.list together. Either may be missing; the avatars then use their fallbacks. */
export const readIdentity = (/** @type {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} */ attempt) =>
  Promise.all([readSystem(attempt), readTeammates(attempt)]).then(() => {});

// ---- drawing -------------------------------------------------------------------------------

/** A small stable number from a string (FNV-1a), for a fallback option only. */
function small(/** @type {string} */ s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The theme the ring's palette follows (theme-live.js sets data-theme="paper" or nothing). */
const theme = () => (typeof document !== "undefined" && document.documentElement?.dataset?.theme === "paper") ? "paper" : "dark";

/**
 * The SVG source for one avatar. Pure; exported for tests and the cache below.
 * @param {Family} family @param {string} seed @param {number} size
 * @param {{ fp?: number[]|null, ring?: boolean, theme?: "dark"|"paper", option?: number }} [o] `option`: a
 *   person's look chosen by the caller (pair-avatar.js's stopgap), over the fingerprint's default
 */
export function avatarSource(family, seed, size, o = {}) {
  if (family === "person") {
    const option = Number.isInteger(o.option) ? /** @type {number} */ (o.option) % PERSON_OPTIONS
      : o.fp ? defaultAvatarOption(o.fp, PERSON_OPTIONS) : small(seed) % PERSON_OPTIONS;
    if (o.ring && o.fp) return renderCode2(bitsToLevels(bytesToBits(buildCodeword(o.fp))), { userOption: option, style: "ticksSunburst", theme: o.theme || "dark", size });
    return userAvatar(option, size);
  }
  if (family === "assistant") return creature(seed, size);
  if (family === "teammate") return character(seed, size);
  return blob(seed, size);
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

/**
 * One avatar as an element: a span sized by --av, holding the family's inline SVG. Decorative by
 * default (the name sits beside it); `label` makes it an image with that name.
 * @param {Family} family @param {string} seed
 * @param {{ size?: number, label?: string|null, title?: string|null, cls?: string, fp?: number[]|null, ring?: boolean }} [o]
 */
export function avatar(family, seed, o = {}) {
  const size = o.size || 24;
  const ring = !!(o.ring && o.fp && family === "person" && size >= RING_AT);
  const th = ring ? theme() : "";
  const fpKey = o.fp ? o.fp.join(".") : "";
  const key = `${family}|${seed}|${fpKey}|${band(family, size)}|${ring ? "r" + th : ""}`;
  const el = document.createElement("span");
  el.setAttribute("class", `vy-av vy-av-${family}${ring ? " vy-av-ring" : ""}${o.cls ? " " + o.cls : ""}`);
  el.setAttribute("style", `--av:${size}px`);
  el.setAttribute("data-family", family);
  if (o.title) el.setAttribute("title", o.title);
  if (o.label) { el.setAttribute("role", "img"); el.setAttribute("aria-label", o.label); } else el.setAttribute("aria-hidden", "true");
  let t = null;
  try { t = template(key, () => avatarSource(family, seed, family === "teammate" ? (size >= 32 ? 40 : 24) : 120, { fp: o.fp, ring, theme: /** @type {any} */ (th) })); } catch { t = null; }
  if (t) el.append(copy(t));
  else el.append(String(o.label || o.title || seed || "?").trim().charAt(0).toLowerCase());
  return el;
}

/** The person (the owner of this Vyre). `ring` draws the Vyre code at RING_AT and above. */
export function personAvatar(/** @type {{ size?: number, ring?: boolean, label?: string|null, title?: string|null, cls?: string }} */ o = {}) {
  const seed = "vyre:person:fallback:" + (who.owner.name || who.host || "you");
  return avatar("person", seed, { ...o, fp: who.owner.fp });
}

/** The person's assistant: its creature. */
export function assistantAvatar(/** @type {{ size?: number, label?: string|null, title?: string|null, cls?: string }} */ o = {}) {
  const fp = who.assistant.fp;
  const seed = fp ? fp.map(b => b.toString(16).padStart(2, "0")).join("") : "vyre:assistant:fallback:" + (who.assistant.name || "vyre");
  return avatar("assistant", seed, o);
}

/** An agent by its stable id (its name): a blob, or a character when team.list says it is a teammate. */
export function agentAvatar(/** @type {string} */ id, /** @type {{ size?: number, label?: string|null, title?: string|null, cls?: string }} */ o = {}) {
  return avatar(isTeammate(id) ? "teammate" : "agent", String(id || ""), o);
}

/** A teammate by its teammate id ("<role>-<project>", see teammateId). */
export function teammateAvatar(/** @type {string} */ id, /** @type {{ size?: number, label?: string|null, title?: string|null, cls?: string }} */ o = {}) {
  return avatar("teammate", String(id || ""), o);
}

/**
 * Whoever a thread's `agent` names: the assistant (no agent, a Claude label, or the assistant's
 * own name, chat/lib/names.js's rule), a teammate, or an agent.
 * @param {string|null|undefined} agent
 * @param {{ size?: number, label?: string|null, title?: string|null, cls?: string }} [o]
 */
export function whoAvatar(agent, o = {}) {
  const a = String(agent ?? "").trim();
  if (!a || /claude/i.test(a) || a === who.assistant.name) return assistantAvatar(o);
  return agentAvatar(a, o);
}

// ---- the tap -------------------------------------------------------------------------------

/**
 * A tap on any avatar plays a small hop (deck.css .vy-av-play), restarted by each tap. Nothing
 * under prefers-reduced-motion. Installed once, on the document, so avatars drawn later need no
 * listener of their own and a long chat carries none.
 * @param {Document} [doc]
 */
export function installAvatarMotion(doc = document) {
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
}

/** For tests: forget the cache and who is who. */
export function _reset() { cache.clear(); teammates.clear(); reading = null; readingTeam = null; setIdentity({}); }
