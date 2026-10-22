// @ts-check
// The Space's first page for each role: the setting spaces.landing. A role is one of the four a
// person sees (lib/roles/catalogue.js BUILTIN_VIEW, the one role list); a page is one of the app's
// own routes (lib/sidebar/model.js HREF, the one route shape). The kernel's "temp" is the
// person-facing "guest": the catalogue maps it, and the app does the same.
//
// This file owns two things: the check the settings hub calls before it stores a value (the
// module's own tool, spaces.check, called as the settings module), and the read of the value for
// the spaces list. The value itself is kept by the settings hub at account level: on a Space's own
// server the account level is that Space's value.

import { BUILTIN_VIEW } from "../../lib/roles/catalogue.js";
import { HREF } from "../../lib/sidebar/model.js";

/** The setting key this module owns. */
export const KEY = "spaces.landing";

/** The roles a person may set a first page for, in the catalogue's order. */
export const ROLE_IDS = Object.freeze(BUILTIN_VIEW.map((r) => r.id));

/**
 * The problems with a proposed value, in plain words with the next step. Empty means it may be
 * stored: the value is a set of first pages, one route for each role, and nothing else.
 * @param {any} value
 * @returns {string[]}
 */
export function landingProblems(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${KEY} takes a set of first pages, one route for each role.`];
  /** @type {string[]} */
  const problems = [];
  for (const [role, route] of Object.entries(value)) {
    if (!ROLE_IDS.includes(role)) { problems.push(`${KEY}: ${role} is not a role. The roles are ${ROLE_IDS.join(", ")}.`); continue; }
    if (typeof route !== "string" || !HREF.test(route) || route.includes("..")) problems.push(`${KEY}: the page for ${role} must be a page of the app, like /u/now.`);
  }
  return problems;
}

/**
 * The check the settings hub calls before it stores a value: the module's own tool, called as the
 * settings module. It answers ok, or the problem in plain words.
 * @param {{ tool: Function }} ctx
 */
export function registerLanding(ctx) {
  ctx.tool("spaces.check", {
    effect: "read",
    description: "Check a proposed value for a Space setting without saving it: give key and value. It answers ok, or what is wrong with it.",
    input: { type: "object", properties: { key: { type: "string" }, value: {}, level: { type: "string" } } },
    run: async (/** @type {any} */ i) => {
      if (i && i.key !== undefined && i.key !== KEY) return { ok: false, message: `spaces.check checks ${KEY}, not ${i.key}` };
      const problems = landingProblems(i ? i.value : undefined);
      return problems.length ? { ok: false, message: problems.join("; ") } : { ok: true };
    },
  });
}

/**
 * The first page for each role, as the hub keeps it: { owner?, admin?, member?, guest? }. Null when
 * the settings hub is off, or when nothing is set.
 * @param {{ call: Function }} ctx
 */
export async function landingValue(ctx) {
  try {
    const r = await ctx.call("settings.get", { key: KEY });
    const v = r && r.data ? r.data.value : undefined;
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
