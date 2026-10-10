// @ts-check
// A schedule in plain words with its next run shown on BOTH clocks (the user's time-zone ruling, option B): a Flow's schedule runs in the Space's zone, and the person reading it may be somewhere else.
// "On a schedule (0 9 * * 1-5, America/New_York) · next 9:00 am ET · 6:00 am your time". The conversion and the showing are lib/time's.
import { showTimes, validZone } from "../../lib/time/index.js";
import { describeTrigger } from "./triggers.js";
import { nextFire } from "./schedule.js";

/**
 * @param {any} trigger @param {{ space?: string | null, person?: string | null, now: number, holidays?: string[] }} ctx `space` is the Space's zone (UTC when none), `person` the reader's zone
 * @returns {string}
 */
export function describeSchedule(trigger, ctx) {
  const words = describeTrigger(trigger);
  if (!trigger || trigger.on !== "time") return words;
  const space = trigger.tz && validZone(trigger.tz) ? trigger.tz : ctx.space && validZone(ctx.space) ? ctx.space : "UTC";
  const person = ctx.person && validZone(ctx.person) ? ctx.person : space;
  /** @type {number | null} */ let next = null;
  if (trigger.cron !== undefined || trigger.every_ms !== undefined) next = nextFire(trigger, trigger.cron !== undefined ? ctx.now : ctx.now, space, ctx.holidays || []);
  else if (trigger.at !== undefined) { const t = Date.parse(String(trigger.at)); next = Number.isNaN(t) ? null : t; }
  if (next === null) return words;
  const shown = showTimes(next, { person, space });
  // a schedule that keeps the Space's clock says which zone that is, so "9:00 am" is never a bare number
  return `${words} · next ${shown.text}${trigger.cron !== undefined && shown.space === null ? ` (${space})` : ""}`;
}
