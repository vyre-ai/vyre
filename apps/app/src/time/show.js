// @ts-check
// How the app shows a time: every time goes through lib/time (platform-2's one time library), read in the viewer's own zone, and, for a time that belongs to a space with a zone of its own, the space's
// too ("9:00 am PT · 9:00 pm your time"). Nothing here converts or formats on its own: it picks the zone and calls lib/time. A device's own formatting (toLocaleTimeString and friends) is not used for a time.
import { clock, localParts, showTimes, stamp, systemZone, validZone, zoneLabel } from "../../../../lib/time/index.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The viewer's zone (the device's). */
export const viewerZone = () => systemZone();

/** "9:00 pm", in the viewer's zone. @param {number} ms @param {string} [zone] */
export const timeOf = (ms, zone = viewerZone()) => clock(ms, zone);

/** "9:00 am PT · 9:00 pm your time" for a time of a space with a zone; the viewer's clock alone when there is none or the clocks agree. @param {number} ms @param {string | null} [spaceZone] @param {string} [zone] */
export const timeLineOf = (ms, spaceZone = null, zone = viewerZone()) => showTimes(ms, { person: zone, space: spaceZone }).text;

/** "5 Oct 2026" or, with year false, "5 Oct", in the viewer's zone. @param {number} ms @param {{ year?: boolean, zone?: string }} [o] */
export function dayOf(ms, o = {}) {
  const p = localParts(ms, o.zone ?? viewerZone());
  return `${p.day} ${MON[p.month - 1]}${o.year === false ? "" : ` ${p.year}`}`;
}

/** "5 Oct, 9:41 pm" (the year only when it is not this year), in the viewer's zone. @param {number} ms @param {{ now?: number, zone?: string }} [o] */
export function dayTimeOf(ms, o = {}) {
  const zone = o.zone ?? viewerZone();
  const yr = localParts(ms, zone).year !== localParts(o.now ?? Date.now(), zone).year;
  return `${dayOf(ms, { year: yr, zone })}, ${clock(ms, zone)}`;
}

/** "Mon 5 Oct 2026, 9:41 pm". @param {number} ms @param {string} [zone] */
export const stampOf = (ms, zone = viewerZone()) => stamp(ms, zone);

/** The hour of day (0 to 23) in the viewer's zone, for a greeting. @param {number} ms @param {string} [zone] */
export const hourOf = (ms, zone = viewerZone()) => localParts(ms, zone).hour;

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon 5 Oct", in the viewer's zone. @param {number} ms @param {string} [zone] */
export function weekdayDayOf(ms, zone = viewerZone()) {
  const p = localParts(ms, zone);
  return `${WEEK[p.weekday]} ${p.day} ${MON[p.month - 1]}`;
}

/** Are two instants on the same day in the viewer's zone? @param {number} a @param {number} b @param {string} [zone] */
export function sameDay(a, b, zone = viewerZone()) {
  const x = localParts(a, zone), y = localParts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

const DAYNAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHNAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "Thursday, 1 October", in the viewer's zone. @param {number} ms @param {string} [zone] */
export function longDateOf(ms, zone = viewerZone()) {
  const p = localParts(ms, zone);
  return `${DAYNAMES[p.weekday]}, ${p.day} ${MONTHNAMES[p.month - 1]}`;
}

/** A contact's local time, "9:41 pm PT", from the zone on the Contact (its `time_zone`, an IANA name). null when there is no zone or it is not one lib/time knows. @param {number} ms @param {unknown} zone */
export function theirTimeOf(ms, zone) {
  const z = typeof zone === "string" ? zone.trim() : "";
  if (!z || !validZone(z)) return null;
  return `${clock(ms, z)} ${zoneLabel(z, ms)}`;
}
