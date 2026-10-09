// @ts-check
// cron: a watcher's schedule. The parsing, the next time and the words are lib/cron.js, shared with Flows; this file is the watchers' shape of it (parse throws a readable reason naming the field, and
// the time zone is the Space's: the server's own zone unless the Space sets one, and `describe` says which).

import { parseCron, nextCron, describeCron } from "../../lib/cron.js";
import { systemZone } from "../../lib/time/index.js";

/** @typedef {import("../../lib/cron.js").Cron} Cron */

/**
 * Parse a schedule. Throws with a readable reason naming the field.
 * @param {string} expr
 * @returns {Cron}
 */
export function parse(expr) {
  const c = parseCron(expr, { strictSteps: true });
  if (!c.ok) throw new Error(c.detail);
  return c;
}

/**
 * The first minute strictly after `after` (ms) that the schedule matches, in the Space's time zone (default: the server's own). Null for a schedule that never matches (February 30th).
 * @param {Cron} c @param {number} after @param {string} [zone]
 */
export function next(c, after, zone = systemZone()) { return nextCron(c, after, zone); }

/** The schedule in words, for telling the user what they are turning on. @param {string} expr @param {string} [zone] named when given */
export function describe(expr, zone) {
  const words = describeCron(expr);
  // Only a clock time depends on the zone ("every day at 09:00", or a schedule quoted as written); "every 15 minutes" does not.
  return zone && (words.startsWith("every day at") || words.startsWith('"')) ? `${words} (${zone})` : words;
}
