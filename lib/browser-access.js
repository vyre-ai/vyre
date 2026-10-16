// @ts-check
// browser-access: one place for how agents reach Chrome on the box (shared browser or desktop),
// the egress floor for model navigation, and the registry of every entry that must use it.
//
// Isolation (per-agent or per-fill browser contexts, member CDP tokens, shield) is enforced in
// computerd/cdpmux; this file is the vyred-side gate before any CDP socket opens.

import { resolvePublic } from "./netguard.js";

/** Synthetic shared-computer row id (never a real agent name). */
export const SHARED_COMPUTER_ID = "browser-shared";

/** @param {any} cfg computers section of config */
export function browseMode(cfg) {
  const m = cfg && cfg.browse;
  if (m === "desktop" || m === "desktops" || m === "pool") return "desktop";
  if (m === "browser") return "browser";
  if (cfg && cfg.browser === false) return "desktop";
  if (cfg && cfg.driver === "fake") return "desktop";
  return "browser";
}

/** @param {any} cfg */
export function sharedBrowserOn(cfg) {
  return browseMode(cfg) === "browser";
}

/** computerd's authenticated CDP proxy URL for a helper answer from computers.endpoint. */
export function cdpUrlOf(/** @type {{ url: string }} */ helper) {
  return `${String(helper.url).replace(/\/+$/, "")}/cdp`;
}

/**
 * Model/agent navigation floor: public http(s) only (lib/netguard.js). A person's own call skips this.
 * @param {string} url
 * @param {{ guarded?: boolean, lookup?: (h: string) => Promise<{ address: string }[]>, own?: string[] }} [o]
 */
export async function guardAgentNavigate(url, o = {}) {
  if (o.guarded === false) return;
  let host;
  try { host = new URL(url).hostname; } catch { throw Object.assign(new Error(`"${url}" is not a URL`), { code: "bad_input" }); }
  if (!/^https?:$/.test(new URL(url).protocol)) throw Object.assign(new Error(`"${url}" is not an http(s) URL`), { code: "bad_input" });
  try { await resolvePublic(host, o); } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === "NOT_PUBLIC" || code === "ENOTFOUND") throw Object.assign(new Error(`${host} is not a public address: an agent's Chrome reaches the public web only; take over in Glass to open a local page`), { code: "denied" });
    throw e;
  }
}

/**
 * Every vyred path that opens an agent's browser CDP or Glass stream must go through one of these
 * gates (test/browser-access-registry.test.js). Mac person-Chrome (extension) is a separate product
 * surface and is not listed here.
 */
export const AGENT_BROWSER_GATES = Object.freeze({
  /** hands-chrome, hands-desktop, siteops: always computers.endpoint → AgentBrowser helper token. */
  cdpViaEndpoint: Object.freeze([
    "core/computers/index.js",
    "core/computers/agent-browser.js",
    "modules/hands-chrome/index.js",
    "modules/hands-desktop/index.js",
  ]),
  /** Vault fill: computers.fill.begin → one-time fill token, fresh browser context in agent-fill. */
  cdpViaFill: Object.freeze([
    "core/vault/agent-fill.js",
  ]),
  /** Person Glass: computers.watch ticket → glass or browser-glass relay. */
  /** Model navigation: guardAgentNavigate / requirePublicUrl before chrome.open and after redirect. */
  navigateEgress: Object.freeze([
    "lib/browser-access.js",
    "modules/hands-chrome/nav.js",
    "modules/hands-chrome/index.js",
  ]),
  glassStream: Object.freeze([
    "core/computers/glass.js",
    "core/computers/browser-glass.js",
    "core/glass/index.js",
    "apps/app/src/glass/frame.js",
    "apps/app/screens/glass/state.ts",
    "apps/app/src/chat/LiveScreen.tsx",
    "apps/app/src/chat/OperatorCard.tsx",
  ]),
  /** Owner helper for files/shield (may be shared computer row). */
  helperViaAgentBrowser: Object.freeze([
    "core/computers/helper.js",
    "core/computers/fill.js",
    "core/computers/shield.js",
    "core/glass/providers/computer.js",
  ]),
});

/** WebSocket stream path segment for Glass in each browse mode. */
export function glassStreamPath(/** @type {"browser"|"desktop"} */ mode) {
  return mode === "browser" ? "/v1/streams/computers/browser-glass" : "/v1/streams/computers/glass";
}
