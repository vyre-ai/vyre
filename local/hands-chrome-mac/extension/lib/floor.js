// @ts-check
// floor: which pages the extension will touch at all, judged from the URL alone.
//
// Three tiers. `blind`: a secret store, a bank, the browser's own pages or Vyre itself: nothing is
// read and nothing is done (a model may learn that a tab exists, never what is in it). `hands`:
// readable, never acted on. `open`: everything else. The list and the rules live in
// ../shared/floor.js, the same file the module imports, so the two sides cannot drift; this wrapper
// only adds the person's lists from chrome.storage.local ("floor.blind", "floor.readonly").
// Refusal is the default for anything unrecognised: an unreadable URL is blind.

import { classify } from "../shared/floor.js";

/** @typedef {{ blind?: string[], readonly?: string[] }} FloorConfig */
/** @typedef {{ allow: boolean, tier: "blind"|"hands"|"open", why: string }} Verdict */

/** @param {string|undefined|null} url @param {FloorConfig} [cfg] @returns {{ tier: "blind"|"hands"|"open", why: string }} */
export function tierOf(url, cfg = {}) {
  const r = classify(url, undefined, cfg);
  return { tier: r.tier, why: r.why || "an ordinary page" };
}

/** May this op run on a page at this URL? @param {string|undefined|null} url @param {string} op @param {FloorConfig} [cfg] @returns {Verdict} */
export function decide(url, op, cfg = {}) {
  const r = classify(url, op, cfg);
  return { allow: r.allow, tier: r.tier, why: (r.why || "an ordinary page") + (r.tier === "hands" && !r.allow ? "; it can be read but not acted on" : "") };
}
