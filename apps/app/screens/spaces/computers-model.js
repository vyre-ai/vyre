// @ts-check
// A Space's rule for where its members' sessions run (G01, link's spaces.members.computers): an owner or admin allows members to run their sessions on their own computers; without it every session in the Space runs on the
// server, and a member can still lend their computer. The words for the switch, for a member's "Run on this computer", and for a refusal. Pure.

export const COMPUTERS_TITLE = "Members may run their sessions on their own computers";

/** What the switch says under its title. @param {boolean | null} allowed @param {string} space */
export const switchLine = (allowed, space) => (allowed ? `Sessions in ${space} may run on a member's own computer when they lend it. Taking this back moves them to the server.` : `Every session in ${space} runs on the server. A member can lend their computer, but nothing runs on it until you allow it.`);

/** The line on a member's "Run on this computer" for one Space they are in. @param {string} space @param {boolean | null | undefined} allowed */
export function memberLine(space, allowed) {
  if (allowed === true) return `${space} allows sessions on your computer.`;
  if (allowed === false) return `${space} keeps sessions on its server. An owner can allow your computer.`;
  return "";
}

/** A refusal in words: only an owner or admin sets it. @param {string | undefined} code @param {string} message */
export const refusal = (code, message) => (code === "forbidden" ? "Only an owner or an admin of this Space can change that." : code === "presence_required" || code === "presence_denied" || code === "denied" ? "That needs your approval. Approve on this device, then try again." : message || "That did not save.");

/** The answer of spaces.members.computers, or null when the box has no such tool or does not say. @param {any} d */
export const allowedOf = (d) => (d && typeof d.allowed === "boolean" ? d.allowed : null);
