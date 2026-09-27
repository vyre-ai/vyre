// @ts-check
// check: what a tip in a manifest's teaches.tips may look like. Pure, so the tips module, `vyre
// module check` and the docs tests all hold tips to one rule. A bad tip is dropped with a reason,
// never the whole module: one long sentence should not cost a module its other tips.

export const SURFACES = ["capsule", "deck", "chat", "phone", "cli", "glass", "statusline"];
export const LEVELS = ["first-use", "power", "discovery"];
export const TRIGGERS = ["on-use", "idle", "never-used", "after-update"];
export const MAX_TEXT = 140;

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ABOUT = /^[a-z][a-z0-9-]{1,40}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i;
const DOCS = /^[a-z0-9][a-z0-9/_-]*\.md(#[a-z0-9-]+)?$/;
const KNOWN = new Set(["id", "text", "surfaces", "level", "trigger", "since", "key", "command", "docs", "about"]);

/**
 * The tips a module declares, checked. Returns the good ones (with `module` and `about` filled in)
 * and one line per problem.
 * @param {string} module @param {any} tips
 * @returns {{ tips: Tip[], problems: string[] }}
 */
export function checkTips(module, tips) {
  /** @type {Tip[]} */
  const out = [];
  const problems = [];
  if (tips === undefined) return { tips: out, problems };
  if (!Array.isArray(tips)) return { tips: out, problems: ["teaches.tips must be a list"] };
  const seen = new Set();
  tips.forEach((t, i) => {
    const at = `teaches.tips[${i}]${t && typeof t.id === "string" ? ` (${t.id})` : ""}`;
    const bad = tipProblems(t);
    if (!bad.length && seen.has(t.id)) bad.push("id is used twice");
    if (bad.length) { problems.push(...bad.map(b => `${at}: ${b}`)); return; }
    seen.add(t.id);
    out.push({
      id: `${module}/${t.id}`, module, about: t.about || module, text: t.text, surfaces: [...t.surfaces], level: t.level,
      trigger: t.trigger, since: t.since, ...(t.key ? { key: t.key } : {}), ...(t.command ? { command: t.command } : {}),
      ...(t.docs ? { docs: t.docs } : {}), order: i,
    });
  });
  return { tips: out, problems };
}

/** @param {any} t @returns {string[]} */
function tipProblems(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return ["must be an object"];
  const p = [];
  for (const k of Object.keys(t)) if (!KNOWN.has(k) && !k.startsWith("x-")) p.push(`unknown key ${k}`);
  if (typeof t.id !== "string" || !ID.test(t.id)) p.push("id must be lowercase letters, digits and dashes");
  if (typeof t.text !== "string" || !t.text.trim()) p.push("text is required");
  else {
    if (t.text.length > MAX_TEXT) p.push(`text is ${t.text.length} characters; at most ${MAX_TEXT}`);
    if (/—/.test(t.text)) p.push("text has an em dash; use a comma, a colon or two sentences");
    if (/§/.test(t.text)) p.push("text has a section sign; write \"Section\"");
  }
  if (!Array.isArray(t.surfaces) || !t.surfaces.length || t.surfaces.some((/** @type {any} */ s) => !SURFACES.includes(s))) p.push(`surfaces must be a list of ${SURFACES.join(", ")}`);
  if (!LEVELS.includes(t.level)) p.push(`level must be one of ${LEVELS.join(", ")}`);
  if (!TRIGGERS.includes(t.trigger)) p.push(`trigger must be one of ${TRIGGERS.join(", ")}`);
  if (typeof t.since !== "string" || !SEMVER.test(t.since)) p.push("since must be a version, like 0.1.0");
  for (const k of ["key", "command"]) if (t[k] !== undefined && (typeof t[k] !== "string" || !t[k].trim() || t[k].length > 80)) p.push(`${k} must be a short string`);
  if (t.docs !== undefined && (typeof t.docs !== "string" || !DOCS.test(t.docs))) p.push("docs must be a page path like using/planner.md#remind");
  if (t.about !== undefined && (typeof t.about !== "string" || !ABOUT.test(t.about))) p.push("about must be a module or surface name");
  return p;
}

/**
 * -1, 0 or 1. Plain numeric parts; a prerelease sorts before its release.
 * @param {string} a @param {string} b
 */
export function compareVersions(a, b) {
  const split = (/** @type {string} */ v) => { const [core, pre] = String(v).split("-", 2); return { n: core.split(".").map(x => Number(x) || 0), pre: pre || null }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) < (y.n[i] || 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * @typedef {{ id: string, module: string, about: string, text: string, surfaces: string[], level: string,
 *   trigger: string, since: string, key?: string, command?: string, docs?: string, order: number }} Tip
 */
