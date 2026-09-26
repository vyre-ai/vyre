// @ts-check
// clock: timers and alarms in the Clock app.
//
// Clock has no AppleScript dictionary. What it does have is App Intents (Start Timer, Create
// Alarm), which run without bringing the app forward, and the only way to reach an App Intent
// from outside is a shortcut. So Vyre ships two small shortcuts, "Vyre Timer" and "Vyre Alarm",
// that the person imports once; this adapter runs them with `shortcuts run`. A missing shortcut
// is code setup, with the one command that fixes it.

import { AppsError } from "../env.js";

export const TIMER = "Vyre Timer";
export const ALARM = "Vyre Alarm";

const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 90 -> "1 minute 30 seconds", 3600 -> "1 hour". */
export function duration(/** @type {number} */ seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const parts = [];
  if (h) parts.push(plural(h, "hour"));
  if (m) parts.push(plural(m, "minute"));
  if (s) parts.push(plural(s, "second"));
  return parts.join(" ") || "0 seconds";
}

/** "7:00" or "07:00" -> { hh: "07", mm: "00" }, or null. 24-hour time. */
export function parseTime(/** @type {string} */ t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t).trim());
  return m ? { hh: m[1].padStart(2, "0"), mm: m[2] } : null;
}

/** Refuse with code setup unless the person has imported the shortcut. */
async function need(/** @type {any} */ env, /** @type {string} */ name) {
  const have = await env.shortcuts.list();
  if (!have.includes(name)) {
    throw new AppsError("setup", `Clock needs Vyre's ${name.replace(/^Vyre /, "")} shortcut, once: run "vyre apps setup clock"`);
  }
}

/** @type {import("./index.js").Adapter} */
export default {
  id: "clock",
  app: "Clock",
  bundleIds: ["com.apple.clock"],
  tier: "intents",
  actions: {
    timer: {
      title: "Start a timer",
      input: { type: "object", required: ["seconds"], properties: {
        seconds: { type: "integer", description: "Length of the timer in seconds, more than 0." },
        label: { type: "string", description: "Shown in Vyre's reply; Clock's Start Timer takes a length only." },
      } },
      sends: false,
      async run({ seconds, label }, env) {
        if (!(seconds > 0)) throw new AppsError("bad_input", "a timer needs a length of more than 0 seconds");
        await need(env, TIMER);
        await env.shortcuts.run(TIMER, String(seconds));
        return { said: `Timer set for ${duration(seconds)}${label ? `: ${label}` : ""}`, seconds };
      },
    },
    alarm: {
      title: "Set an alarm",
      input: { type: "object", required: ["time"], properties: {
        time: { type: "string", description: "24-hour time, HH:MM." },
        label: { type: "string" },
      } },
      sends: false,
      async run({ time, label }, env) {
        const t = parseTime(time);
        if (!t) throw new AppsError("bad_input", `an alarm needs a 24-hour time like 07:00, not "${time}"`);
        await need(env, ALARM);
        await env.shortcuts.run(ALARM, JSON.stringify({ time: `${t.hh}:${t.mm}`, label: label || "" }));
        return { said: `Alarm set for ${Number(t.hh)}:${t.mm}${label ? `: ${label}` : ""}`, time: `${t.hh}:${t.mm}` };
      },
    },
  },
};
