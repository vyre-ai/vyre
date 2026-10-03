// @ts-check
// The install flow's rules, pure so Node tests them: names, the step graph, the two-sided server code.
// Steps (prototype p3Inst): name > recovery > spaces; or name > scan > spaces. spaces > create > where > (cmd | vps | here) > ... > done.
// spaces > join > invite > joined.

export const NAMES_TAKEN = ["alex", "chris", "harlow", "vyre", "admin"];
export const MIN_NAME = 3;
export const RECOVERY_CODE = "R7K4-Q2MX-9HDP-W3NB";
export const SERVER_CODE = "WINK-7K4Q-M2XD";
export const SERVER_NUMBER = "47";
export const NUMBER_CHOICES = ["12", "47", "85"];

/** "Harlow Legal" > "harlow-legal". The slug is what goes before .vyre.run. */
export function slug(/** @type {string} */ s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Can this name be claimed? People and spaces share one namespace, so a space cannot take its owner's name either.
 * @param {string} raw @param {string[]} [also] names already used by this person (their own name, spaces they made)
 * @returns {{ slug: string, state: "empty"|"short"|"taken"|"ok", address: string }}
 */
export function nameStatus(raw, also = []) {
  const s = slug(raw);
  const address = s ? `${s}.vyre.run` : "";
  if (!s) return { slug: s, state: "empty", address };
  if (NAMES_TAKEN.includes(s) || also.map(slug).includes(s)) return { slug: s, state: "taken", address };
  if (s.length < MIN_NAME) return { slug: s, state: "short", address };
  return { slug: s, state: "ok", address };
}

/** The words under the name field. */
export function nameNote(/** @type {ReturnType<typeof nameStatus>} */ st, /** @type {boolean} */ space) {
  if (st.state === "taken") return `${st.address} is taken.${space ? " People and spaces share names." : ""}`;
  if (st.state === "short") return "Use at least three letters.";
  if (st.state === "ok") return `${st.address} is yours to take.`;
  return "";
}

/** @type {Record<string, string|null>} */
export const BACK = {
  name: null, scan: "name", recovery: null, spaces: null, create: "spaces", where: "create", cmd: "where", vps: "where", vpsbusy: null,
  srv1: "cmd", srv2: "cmd", here: "where", done: null, join: "spaces", invite: "join", joined: null,
};

/** Where Back goes from a step. The server steps go back to the server's own first screen (the line or the new server). */
export function backOf(/** @type {string} */ step, /** @type {{ vps?: boolean }} */ ctx = {}) {
  if (step === "srv1" || step === "srv2") return ctx.vps ? "vps" : "cmd";
  return BACK[step] ?? null;
}

/** The first step for a route: /u/install, /u/install/create, /u/install/join. */
export function startStep(/** @type {string|undefined} */ start) {
  return start === "create" ? "create" : start === "join" ? "join" : "name";
}

/** Where "Where will it live?" sends each choice. */
export const WHERE_STEP = { server: "cmd", vps: "vps", here: "here" };

/** One try per code: the right number completes pairing, a wrong one closes the code and a new one shows (back to the first server step). */
export function pickNumber(/** @type {string} */ n) {
  return n === SERVER_NUMBER ? { ok: true, step: "done" } : { ok: false, step: "srv1" };
}

/** The line shown under a made space. */
export function homeLine(/** @type {"server"|"vps"|"here"} */ where) {
  if (where === "here") return "Lives on this computer. Unreachable while it sleeps.";
  if (where === "vps") return "Lives on northwind, a new server.";
  return "Lives on your server.";
}

/** The lines a server prints, as the prototype shows them. `two` adds the code prompt and the number to match. */
export function serverLines(/** @type {boolean} */ vps, /** @type {string} */ spaceName, /** @type {boolean} */ two) {
  const base = [vps ? "Created northwind on DigitalOcean" : "$ curl -fsSL vyre.run/i | sh", "Installing Vyre ... done", `Setting up ${spaceName} ... done`];
  if (!two) return base;
  return [...base, `Enter the code from your phone or computer: ${SERVER_CODE}`, "Code accepted. Match this number on your phone or computer:", "", `      ${SERVER_NUMBER}`];
}
