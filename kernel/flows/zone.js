// @ts-check
// A Flow's time zone is the Space's. Cron in a zone is lib/cron.js (daylight saving as lib/time has it: a wall time the clocks skip runs once, moved on by the gap; one that happens twice runs once, the
// first time). This file keeps only the zone check.
import { validZone } from "../../lib/time/index.js";

/** Is this an IANA time zone name this runtime knows? @param {string} tz */
export const validTimeZone = tz => typeof tz === "string" && tz.length > 0 && validZone(tz);
