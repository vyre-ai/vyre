// @ts-check
// match: does one outward call fall inside what the person asked for? (P17)
//
// A pure helper for vault's Gate. The Gate stores resolved intents (said_intents) and, for each
// outward call an agent or module makes, asks matches(intent, call). True means the person's own
// request is the approval and the call runs without Touch ID. False means the call is held, as it
// would be without P17. Every doubt answers false.
//
// No state, no I/O.

import { DEFAULT_WINDOW } from "./extract.js";

/** How early a call may come before the time the person asked for. */
export const EARLY_MIN = 10;
const MIN = 60_000;

const ms = v => {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {{ kind: string, channel?: string|null, to_ids: string[]|null, standing?: boolean,
 *   when?: { at?: string|null, window_minutes?: number|null },
 *   limits?: { amount_max?: number|null, currency?: string|null, count?: number|null, until?: string|null },
 *   created_at: number|string, revoked?: boolean|number|string|null }} intent a resolved intent as stored
 * @param {{ kind: string, channel?: string|null, to_ids: string[], amount?: number, currency?: string, at?: number|string }} call
 * @param {{ now?: number|string|Date, used?: number }} [opts] used: how many calls this standing intent already covered
 */
export function matches(intent, call, { now, used = 0 } = {}) {
  if (!intent || !call) return false;
  if (intent.revoked) return false;
  if (intent.kind !== call.kind) return false;
  if (intent.channel && intent.channel !== call.channel) return false;
  if (!Array.isArray(intent.to_ids) || !Array.isArray(call.to_ids)) return false;
  const allowed = new Set(intent.to_ids.map(x => String(x).toLowerCase()));
  if (!call.to_ids.every(r => allowed.has(String(r).toLowerCase()))) return false;

  const limits = intent.limits || {};
  if (call.kind === "pay") {
    const max = limits.amount_max;
    if (typeof max !== "number" || !Number.isFinite(max)) return false;
    if (typeof call.amount !== "number" || !Number.isFinite(call.amount) || call.amount <= 0 || call.amount > max) return false;
    if (!limits.currency || !call.currency || String(limits.currency).toUpperCase() !== String(call.currency).toUpperCase()) return false;
  } else if (typeof limits.amount_max === "number" && typeof call.amount === "number" && call.amount > limits.amount_max) {
    return false;
  }

  const created = ms(intent.created_at);
  const at = ms(call.at) ?? ms(now) ?? Date.now();
  if (created === null) return false;

  if (intent.standing) {
    if (at < created - EARLY_MIN * MIN) return false;
    const until = ms(limits.until);
    if (limits.until && until === null) return false;
    if (until !== null && at > until) return false;
    if (typeof limits.count === "number" && used >= limits.count) return false;
    return true;
  }

  const named = intent.when && intent.when.at ? ms(intent.when.at) : null;
  if (intent.when && intent.when.at && named === null) return false;
  const start = named ?? created;
  const win = intent.when && typeof intent.when.window_minutes === "number" ? intent.when.window_minutes : DEFAULT_WINDOW;
  if (at < start - EARLY_MIN * MIN || at > start + win * MIN) return false;
  // A one-off ask covers one call per recipient ("email Priya and Sam" may be two sends), unless
  // the person gave a count.
  if (used >= (typeof limits.count === "number" ? limits.count : Math.max(1, intent.to_ids.length))) return false;
  return true;
}
