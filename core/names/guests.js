// @ts-check
// guests: people from another tailnet the owner shared this box with (ADR 0014 part 8).
//
// A shared-in person reaches the box's tailnet listener as `tailnet-guest:<login>`, never as the
// owner. What they may call is the tools the owner listed for them (network.guests.people) or the
// tailnet policy granted them (the vyre.run/cap/guest app capability), and only those of that
// union that are in GUEST_SAFE. The router enforces it; every other tool is "no such tool".

import { capValues } from "../link/transport.js";

/** The app capability a tailnet grant gives a guest: values [{ "tools": ["threads.list", ...] }]. */
export const GUEST_CAP = "vyre.run/cap/guest";

/**
 * The only tools a guest can ever reach, whatever the config or a grant says. View only: the list
 * of threads. No Glass: tailnet streams are the owner's alone, so a Glass ticket a guest opened
 * could never be used, and a guest has no session of its own to close. glass.take, and anything that
 * approves, is never here. (threads.read does not exist; threads.get, which reads one thread's recent
 * events, is left out until the owner decides a guest should see that much.)
 */
export const GUEST_SAFE = Object.freeze(new Set(["threads.list"]));

/** network.guests with its defaults: off, nobody listed. */
export function settings(network) {
  const g = (network && network.guests) || {};
  const people = g.people && typeof g.people === "object" && !Array.isArray(g.people) ? g.people : {};
  return { enabled: g.enabled === true, people };
}

/** The config entry for a login, matched without case, or null. */
export function listed(network, login) {
  if (!login) return null;
  const want = String(login).toLowerCase();
  const people = settings(network).people;
  const key = Object.keys(people).find(k => k.toLowerCase() === want);
  return key ? { login: key, tools: toolList(people[key] && people[key].tools) } : null;
}

const toolList = v => (Array.isArray(v) ? v.filter(t => typeof t === "string" && t) : []);

/** The tool patterns the tailnet policy granted this peer in vyre.run/cap/guest. */
export const grantedPatterns = who => capValues(who, GUEST_CAP).flatMap(v => toolList(v && v.tools));

/** Is this peer a guest? Only while guests are on, and only a person listed or granted. */
export function isGuest(network, who) {
  if (!settings(network).enabled || !who || !who.login || who.tagged) return false;
  return Boolean(listed(network, who.login)) || capValues(who, GUEST_CAP).length > 0;
}

/** A pattern is an exact tool name or a prefix ending in "*". Nothing else. */
const matches = (pattern, name) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

/**
 * The tools this guest may call: (listed tools, plus granted ones) that are in GUEST_SAFE.
 * @param {any} network the live network config
 * @param {{ login?: string|null, caps?: Record<string, any[]> } | null | undefined} who the peer meta
 * @returns {string[]}
 */
export function allowedTools(network, who) {
  if (!who || !settings(network).enabled) return [];
  const e = listed(network, who.login);
  const patterns = [...(e ? e.tools : []), ...grantedPatterns(who)];
  return [...GUEST_SAFE].filter(name => patterns.some(p => matches(p, name))).sort();
}
