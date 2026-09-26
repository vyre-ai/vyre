// @ts-check
// planner: timers, alarms, reminders, todos and notes kept by Vyre's own planner (core module
// `planner`, ADR 0025) on the box, so they ring when the Mac is shut. On a paired Mac the planner
// module forwards to the box, so to this adapter it is one call: ctx.call("planner.add").
//
// The planner reads the person's own words itself; this adapter hands them over with the kind the
// router saw. The one line said back comes from what the planner kept, or, when its answer has
// no words, from the router's own reading of the request.

import { AppsError } from "../env.js";
import { route } from "../route.js";

/** The Mac app that says the same thing, for a fallback line from the router's own reading. */
const APPLE = /** @type {Record<string, string>} */ ({ timer: "Clock", alarm: "Clock", reminder: "Reminders", todo: "Reminders", note: "Notes" });
const KINDS = ["alarm", "timer", "reminder", "todo", "note", "event"];
const NAMES = /** @type {Record<string, string>} */ ({ alarm: "Alarm", timer: "Timer", reminder: "Reminder", todo: "Todo", note: "Note", event: "Event" });

/** The line to show for an item the planner added. */
export function saidFor(/** @type {any} */ item, /** @type {string} */ text, /** @type {string | undefined} */ kind, /** @type {any} */ env) {
  if (item && typeof item.said === "string" && item.said) return item.said;
  if (item && typeof item.title === "string" && item.title.trim()) return `${NAMES[item.kind] || "Planner"}: ${item.title.trim()}`;
  const k = (item && item.kind) || kind;
  const own = k && APPLE[k] ? route(text, { now: env.now(), timeZone: env.timeZone, app: APPLE[k] }) : null;
  return own && "said" in own ? own.said : `Added to the planner: ${text}`;
}

/** @type {import("./index.js").Adapter} */
export default {
  id: "planner",
  app: "Planner",
  bundleIds: [],
  tier: "connector",
  actions: {
    add: {
      title: "Add to the planner",
      input: { type: "object", required: ["text"], properties: {
        text: { type: "string", description: "The person's own words: \"timer 10 min\", \"remind me to call juno at 6\"." },
        kind: { type: "string", enum: KINDS },
      } },
      sends: false,
      async run({ text, kind }, env) {
        const r = await env.call("planner.add", { text, ...(kind ? { kind } : {}) });
        if (r && r.error) {
          if (r.error.code === "no_such_tool" || r.error.code === "not_found") throw new AppsError("setup", "The planner is not on this Vyre yet");
          throw new AppsError(/^[a-z][a-z0-9_]{1,40}$/.test(String(r.error.code)) ? r.error.code : "failed", r.error.message || "the planner refused");
        }
        const item = r && r.data;
        return { said: saidFor(item, text, kind, env), item };
      },
    },
  },
};
