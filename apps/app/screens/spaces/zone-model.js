// @ts-check
// The choices for a space's home time zone: every zone this device's Intl knows, the current one first. The list is the platform's own; lib/time validates a zone and the box checks it again (spaces.time-zone.set).
import { validZone } from "../../../../lib/time/index.js";

/** @param {string | null} current @returns {[string, string][]} [value, label] pairs */
export function zoneOptions(current) {
  /** @type {string[]} */ let all = [];
  try { all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { all = []; }
  const list = all.filter((z) => validZone(z));
  const rest = list.filter((z) => z !== current);
  const first = current && validZone(current) ? [current] : [];
  return [...first, ...rest].map((z) => [z, z.replace(/_/g, " ")]);
}
