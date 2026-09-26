// @ts-check
// adapters: what Vyre knows how to do inside each app, and the lookup from an app's name or
// bundle id to that knowledge.
//
// An adapter names its app, the bundle ids it answers to, and its tier: how it reaches the app,
// best first. connector is a real API; intents is an App Intent through a shortcut; script is the
// app's AppleScript dictionary; ax is the app's own UI through the hands module, the fallback for
// any app with nothing better (a later slice). Each action says whether it sends, posts, pays or
// deletes as the person (`sends`): those run only through apps.send, one proof per call.

import clock from "./clock.js";
import notes from "./notes.js";
import reminders from "./reminders.js";
import weather from "./weather.js";

/**
 * @typedef {import("../env.js").Env} Env
 * @typedef {{ title: string, input: any, sends: boolean,
 *   preview?: (args: any, env: Env) => string | Promise<string>,
 *   run: (args: any, env: Env) => Promise<{ said: string, [k: string]: any }> }} Action
 * @typedef {{ id: string, app: string, bundleIds: string[], tier: "connector" | "intents" | "script" | "ax",
 *   actions: Record<string, Action>,
 *   targets?: (q: string, env: Env) => Promise<Array<{ id: string, title: string, kind: string, subtitle?: string }>> }} Adapter
 */

/** @type {Adapter[]} */
export const BUILTIN = [clock, notes, reminders, weather];

/**
 * The adapters in force: config's own first (so a person or a test can stand in for a built-in),
 * then Vyre's.
 * @param {Adapter[]} [extra]
 */
export function adapters(extra = []) {
  const all = [...extra, ...BUILTIN];
  return {
    all,
    /** The adapter for an app name or bundle id, case-insensitive; null when none. @param {string | null | undefined} app */
    find(app) {
      const k = String(app || "").trim().toLowerCase();
      if (!k) return null;
      return all.find(a => a.app.toLowerCase() === k || a.id === k || a.bundleIds.some(b => b.toLowerCase() === k)) || null;
    },
  };
}
