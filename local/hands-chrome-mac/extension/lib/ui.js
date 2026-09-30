// @ts-check
// ui: the worker-side half of robust page control. Pure functions, no chrome.* and no CDP, so they
// are tested with plain objects. page.js feeds them a snapshot; ghl.js reads the same shapes.
//
//   matchControl   bind a selector to a control: strict first (identifier, role+name, name), then
//                  fuzzy-but-safe (case-insensitive name, aria-label or placeholder, nearby label,
//                  whole-word text). A fuzzy stage binds only when EXACTLY ONE control matches at that
//                  stage; two is "tied", never a guess. The strategy that bound comes back, so a trace
//                  can say what was used and whether it was a fallback.
//   topBlocker     the modal dialog or overlay in front of the page that does not contain the target.
//   classifyBlocker  safe to dismiss (a "what's new", cookie or tour popup with a plain close
//                  control), unsafe (unsaved changes, confirm, delete), or unknown. Only safe is ever
//                  dismissed on our own; the rest is surfaced to the caller.
//   redactDom      a small snippet of page HTML/text with credential, email and phone shapes masked.
//
// The blocker words and the close-control allowlist below are the whole policy. They are English
// and unverified against a live GoHighLevel account; a person can always dismiss a dialog by hand
// or by a chrome.act on its own button, which this policy never stands in the way of.

import { redact } from "./shared.js";
import { err } from "./err.js";

/** Roles a person types into or toggles: what a form label means. */
export const FILLABLE = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "spinbutton", "listbox", "slider"]);

/** Lowercase, punctuation to space, whitespace collapsed. @param {any} s */
export const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** "messageBody", "message_body" -> "message body" (a config key becomes a label). @param {string} k */
export const labelOf = k => { const t = String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** @param {string} s */ const tokens = s => norm(s).split(" ").filter(Boolean);

/**
 * Whole-word containment: every word of `want` is a word of `have`, and `have` is at most two
 * words longer, so "Save" binds "Save workflow" but not "Save as a reusable template for later".
 * @param {string} want @param {string} have
 */
export function wordsWithin(want, have) {
  const w = tokens(want), h = tokens(have);
  if (!w.length || h.length > w.length + 2) return false;
  const set = new Set(h);
  return w.every(t => set.has(t));
}

/**
 * @typedef {{ role?: string, identifier?: string, name?: string, container?: string, path?: string }} Selector
 * @typedef {{ control: any|null, strategy?: string, fallback?: boolean, why?: "unbound"|"tied", candidates?: string[] }} Match
 */

/** The strategy a selector would use first. @param {Selector} sel */
export const primaryStrategy = sel => (sel.identifier ? "identifier" : sel.role ? "role+name" : "name");

/**
 * @param {Selector} sel @param {any[]} controls
 * @param {(sel: Selector, cands: any[]) => { control: any|null, why?: string }} strict page.js's resolve
 * @param {{ fillable?: boolean, within?: (c: any) => boolean }} [o]
 * @returns {Match}
 */
export function matchControl(sel, controls, strict, o = {}) {
  let pool = o.fillable ? controls.filter(c => FILLABLE.has(c.role)) : controls;
  /** @param {any[]} list @param {boolean} preferred @returns {Match} */
  const run = (list, preferred) => {
    const primary = primaryStrategy(sel);
    const s = strict(sel, list);
    if (s.control) {
      const strategy = sel.identifier && s.control.identifier === sel.identifier ? "identifier" : sel.role ? "role+name" : "name";
      return { control: s.control, strategy, fallback: strategy !== primary || !preferred };
    }
    if (s.why === "tied") return { control: null, why: "tied", candidates: list.filter(c => sel.name && norm(c.name) === norm(sel.name)).map(c => String(c.name || c.identifier)).slice(0, 6) };
    const cand = sel.role ? list.filter(c => c.role === sel.role) : list;
    /** @type {[string, (c: any) => boolean][]} */
    const stages = [];
    if (sel.identifier) stages.push(["identifier", c => !!c.identifier && norm(c.identifier) === norm(sel.identifier)]);
    if (sel.name) {
      const want = norm(sel.name);
      stages.push(
        ["name-ci", c => norm(c.name) === want],
        ["aria", c => norm(c.aria) === want || norm(c.placeholder) === want],
        ["nearby-label", c => norm(c.near) === want],
        ["text", c => wordsWithin(sel.name || "", c.name || "") || wordsWithin(sel.name || "", c.aria || "") || wordsWithin(sel.name || "", c.placeholder || "")],
        ["nearby-label", c => wordsWithin(sel.name || "", c.near || "")],
      );
    }
    for (const [strategy, test] of stages) {
      const hits = cand.filter(test);
      if (hits.length === 1) return { control: hits[0], strategy, fallback: true };
      if (hits.length > 1) return { control: null, why: "tied", candidates: hits.map(c => String(c.name || c.identifier)).slice(0, 6) };
    }
    return { control: null, why: "unbound" };
  };
  if (o.within) {
    const inside = pool.filter(o.within);
    if (inside.length) {
      const r = run(inside, true);
      if (r.control || r.why === "tied") return r;
      const r2 = run(pool, false);
      return r2.control ? { ...r2, fallback: true } : r2;
    }
  }
  return run(pool, true);
}

/** Up to n control names closest to a wanted name, so a not-found error can say what IS there. @param {string} want @param {any[]} controls @param {number} [n] */
export function nearMisses(want, controls, n = 6) {
  const w = new Set(tokens(want));
  const scored = controls.filter(c => c.name).map(c => ({ c, s: tokens(c.name).filter(t => w.has(t)).length })).sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map(x => ({ role: x.c.role, name: String(x.c.name).slice(0, 60) }));
}

// ---------------------------------------------------------------- blockers

const UNSAFE = /unsaved|discard|leave (this )?page|leave site|are you sure|confirm|delete|remove|cannot be undone|can't be undone|permanent|lose (your |any )?(changes|progress)|changes (that )?you made|will be lost|publish|send now/i;
/** A dialog that asks for agreement: never closed with an OK or Got it, since that could be a yes. */
const AGREES = /consent|agree|terms|privacy|subscribe|opt.?in|marketing (emails|messages)/i;
const SAFE = /what'?s new|new features?|product (update|tour)|announcement|release notes|cookie|tour\b|walkthrough|welcome|getting started|tips?\b|take a tour|feature (update|tour)/i;
/** Close controls, in preference order. Nothing that saves, sends, deletes or confirms is on the list. */
const CLOSERS = [/^(close|dismiss|close dialog|close modal|close popup)$/i, /^(skip|skip tour|skip for now)$/i, /^(no thanks|not now|maybe later|remind me later|later)$/i, /^(got it|ok|okay)$/i, /^(x|×|✕|✖)$/, /^(decline|reject( all)?|necessary only)$/i, /^(accept( all)?( cookies)?|allow)$/i];

/**
 * @typedef {{ i: number, path?: string, role?: string, title?: string, text?: string, modal?: boolean }} Blocker
 */

/**
 * The modal blocker in front of the page that does not hold this control, or null. The top one is
 * the last in document order.
 * @param {any} snap @param {any} [ctl]
 * @returns {Blocker|null}
 */
export function topBlocker(snap, ctl) {
  const list = /** @type {Blocker[]} */ ((snap && snap.state && snap.state.blockers) || []).filter(b => b.modal);
  if (!list.length) return null;
  const top = list[list.length - 1];
  if (ctl && ctl.blk === top.i) return null;
  return top;
}

/**
 * @param {Blocker} b @param {any} snap
 * @returns {{ kind: "safe"|"unsafe"|"unknown", why: string, closer?: any, closers: string[] }}
 */
export function classifyBlocker(b, snap) {
  const inside = (snap.controls || []).filter((/** @type {any} */ c) => c.blk === b.i && c.enabled !== false);
  const closers = inside.map((/** @type {any} */ c) => String(c.name || "")).filter(Boolean).slice(0, 8);
  const said = `${b.title || ""} ${b.text || ""}`;
  if (UNSAFE.test(said)) return { kind: "unsafe", why: "the dialog asks about changes, a confirmation or something that cannot be undone", closers };
  if (!SAFE.test(said)) return { kind: "unknown", why: "the dialog is not one of the known announcement, tour or cookie popups", closers };
  const agrees = AGREES.test(said);
  for (const re of CLOSERS) {
    // Only a plain Close or Skip on a dialog that asks for agreement; never OK, Got it, Accept or Allow.
    if (agrees && /accept|allow|got it|ok/i.test(re.source)) continue;
    const closer = inside.find((/** @type {any} */ c) => re.test(String(c.name || "").trim()));
    if (closer) return { kind: "safe", why: "an announcement, tour or cookie popup with a plain close control", closer, closers };
  }
  return { kind: "unknown", why: "an announcement-like dialog with no plain close control", closers };
}

/** @param {Blocker} b @param {any} snap */
export function describeBlocker(b, snap) {
  const c = classifyBlocker(b, snap);
  return { title: (b.title || "").slice(0, 80), text: (b.text || "").slice(0, 200), kind: c.kind, why: c.why, controls: c.closers };
}

// ---------------------------------------------------------------- redaction and shape of detail

/** @param {string} kind @param {string} v */
const mask = (kind, v) => `[redacted:${kind}:${v.length}]`;

/**
 * Mask what must not travel in a debugging snippet: the shared redactor's credential shapes, plus
 * email addresses and phone-like numbers, which the shared redactor leaves alone.
 * @param {any} s
 */
export function scrub(s) {
  let t = redact.text(String(s == null ? "" : s));
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, m => mask("email", m));
  t = t.replace(/\+?\d[\d\s().-]{7,}\d/g, m => (m.replace(/\D/g, "").length >= 7 ? mask("phone", m) : m));
  return t;
}

/** A page snippet capped at max characters, masked first so a mask never gets cut in half. @param {any} html @param {number} [max] */
export function redactDom(html, max = 2048) {
  const t = scrub(html).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Host and path of a URL, never the query or fragment. @param {any} url */
export function whereOf(url) {
  try { const u = new URL(String(url)); return { host: u.host, path: u.pathname }; } catch { return { host: "", path: "" }; }
}

/**
 * The trace every page and ghl step result carries.
 * @param {{ strategy?: string, fallback?: boolean, waitedMs?: number, retries?: number, newTab?: boolean, [k: string]: any }} t
 */
export const traceOf = t => ({ strategy: t.strategy || "", fallback: !!t.fallback, waitedMs: Math.round(t.waitedMs || 0), retries: t.retries || 0, newTab: !!t.newTab, ...Object.fromEntries(Object.entries(t).filter(([k, v]) => !["strategy", "fallback", "waitedMs", "retries", "newTab"].includes(k) && v !== undefined)) });

/** A stop-aware sleep. @param {any} ctx @param {number} ms */
export async function nap(ctx, ms) {
  if (ctx.stopped && ctx.stopped()) throw err("stopped");
  await new Promise(r => setTimeout(r, ms));
}
