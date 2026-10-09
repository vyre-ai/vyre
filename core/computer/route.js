// @ts-check
// route: the pure half of Vyre Computer (R031-90). Which computer is meant ("on my Mac", "the office computer", nothing at all), and which way to do a thing: through a Connection or a learned
// operation (interface first) or on the screen (last). No tool is called here; index.js asks the modules and feeds the answers in.

/** The cloud computer's own names. Nothing named means this one. */
export const CLOUD_NAMES = Object.freeze(["cloud", "cloud computer", "the cloud", "cloud browser", "my cloud computer", "vyre cloud"]);

/** A name as compared: lower case, a leading "on", "my" or "the" and a trailing "computer" or "mac" dropped, spaces folded. @param {unknown} s */
export const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ']+/g, " ").replace(/\s+/g, " ").trim();
const core = (/** @type {string} */ s) => norm(s).replace(/^(on |at |to )/, "").replace(/^(my|the|our|your) /, "").replace(/ (computer|machine|laptop|desktop)$/, "").trim();

/**
 * @typedef {{ id: string, kind: "cloud" | "here" | "mac", name: string, aliases?: string[], online?: boolean }} Target
 * Resolve "where" to one target.
 *  - nothing named: the cloud computer (when there is one), else the only other target
 *  - an exact name, then a case-insensitive one, then one that is the same after "my"/"the"/"computer" are dropped, then a word of the name that no other target has
 *  - several or none: an ask (never a guess), with the real names as choices
 * @param {string | undefined | null} on @param {Target[]} targets
 * @returns {{ ok: true, target: Target } | { ok: false, ask: { why: "ambiguous" | "unknown" | "none", question: string, choices: string[] } }}
 */
export function resolveTarget(on, targets) {
  const all = targets.filter(t => t && t.id);
  if (!all.length) return { ok: false, ask: { why: "none", question: "There is no computer to do this on yet. Pair your Mac, or turn the cloud computer on.", choices: [] } };
  const want = String(on ?? "").trim();
  const names = all.map(t => t.name);
  if (!want) {
    const cloud = all.find(t => t.kind === "cloud");
    if (cloud) return { ok: true, target: cloud };
    if (all.length === 1) return { ok: true, target: all[0] };
    return { ok: false, ask: { why: "ambiguous", question: "Which computer should do this?", choices: names } };
  }
  const labels = (/** @type {Target} */ t) => [t.name, ...(t.aliases || []), ...(t.kind === "cloud" ? CLOUD_NAMES : [])];
  const pick = (/** @type {(a: string, b: string) => boolean} */ same) => all.filter(t => labels(t).some(l => same(l, want)));
  for (const same of [(/** @type {string} */ a, /** @type {string} */ b) => a === b, (a, b) => norm(a) === norm(b), (a, b) => core(a) === core(b)]) {
    const hit = pick(same);
    if (hit.length === 1) return { ok: true, target: hit[0] };
    if (hit.length > 1) return { ok: false, ask: { why: "ambiguous", question: `Which one is "${want}"?`, choices: hit.map(t => t.name) } };
  }
  // A word of the name that only one target has: "office" for "Office Mac mini".
  const words = core(want).split(" ").filter(w => w.length > 2);
  const byWord = all.filter(t => words.length && words.every(w => labels(t).some(l => norm(l).split(" ").includes(w))));
  if (byWord.length === 1) return { ok: true, target: byWord[0] };
  if (byWord.length > 1) return { ok: false, ask: { why: "ambiguous", question: `Which one is "${want}"?`, choices: byWord.map(t => t.name) } };
  return { ok: false, ask: { why: "unknown", question: `I do not know a computer called "${want}". Which one?`, choices: names } };
}

/** The host of a URL or a bare host, lower case; null when there is none. @param {unknown} u */
export function hostOf(u) {
  const s = String(u ?? "").trim();
  if (!s) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase() || null; } catch { return null; }
}

/** The part of a host that names the service: the last two labels (three under a two-letter country code with a short second label: co.uk). @param {string | null} h */
export const registrable = h => {
  if (!h) return null;
  const p = h.split(".");
  if (p.length <= 2) return h;
  return p.length >= 3 && p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join(".") : p.slice(-2).join(".");
};

/**
 * Interface first, screen last. Given where the thing is (a site, an app or only the words) and what already exists, say the cheapest way: a Connection, a learned operation, or the screen.
 * Nothing here runs anything; the answer is an offer with the reason, and `screen` (the person said "do it on screen", or the model insists) always keeps the screen open.
 * @param {{ goal?: string, site?: string, app?: string, screen?: boolean }} q
 * @param {{ connections?: { id: string, label?: string, host?: string }[], sites?: { id?: string, site: string, operations?: string[] }[] }} have
 * @returns {{ route: "screen", why: string } | { route: "connection", connection: string, label: string, why: string } | { route: "operation", site: string, operations: string[], why: string }}
 */
export function planRoute(q, have = {}) {
  if (q.screen) return { route: "screen", why: "you asked for the screen" };
  const reg = registrable(hostOf(q.site));
  const words = new Set(norm(`${q.goal || ""} ${q.app || ""} ${q.site || ""}`).split(" ").filter(w => w.length > 2));
  for (const c of have.connections || []) {
    const label = norm(c.label || c.id);
    const byHost = reg && registrable(hostOf(c.host)) === reg;
    const byName = label.length > 2 && label.split(" ").some(w => w.length > 2 && words.has(w));
    if (byHost || byName) return { route: "connection", connection: c.id, label: c.label || c.id, why: `a ${c.label || c.id} Connection exists` };
  }
  for (const s of have.sites || []) {
    if (reg && registrable(hostOf(s.site)) === reg && (s.operations || []).length) return { route: "operation", site: s.site, operations: s.operations || [], why: `${(s.operations || []).length} learned operation${(s.operations || []).length === 1 ? "" : "s"} exist for ${hostOf(s.site)}` };
  }
  return { route: "screen", why: "no Connection or learned operation covers this" };
}
