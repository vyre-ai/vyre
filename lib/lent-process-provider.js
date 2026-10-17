// @ts-check
// Which session providers run as a process on a lent computer (lib copy for placement; full layout lives in core/sessions/drivers/lent-agent.js).

import { AGENTS } from "./agent-sandbox.js";

/** Providers that run as a process on the lender (AGENTS table); in-process chat providers are never lent. */
export const LENT_PROCESS_PROVIDERS = Object.freeze(Object.keys(AGENTS));

/** @param {string | null | undefined} provider */
export function lentProcessProvider(provider) {
  const p = provider || "claude";
  return LENT_PROCESS_PROVIDERS.includes(p) ? p : null;
}
