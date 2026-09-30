// @ts-check
// floor: which pages the extension will touch at all, judged from the URL alone.
//
// Three tiers. `blind`: the page is a secret store, a bank, the browser's own chrome or Vyre
// itself, so nothing is read and nothing is done (a model may learn that a tab exists, never
// what is in it). `hands`: readable, never acted on (the person listed it as read-only).
// `open`: everything else. The module classifies before it sends and this re-checks in the
// worker (ADR 0049), so a bug on either side alone is not enough to reach a blind page.
//
// Pure: no chrome.* here. ctx.floorAllows fetches the tab URL and the person's extra lists from
// chrome.storage.local ("floor.blind", "floor.readonly") and calls decide().
// Refusal is the default for anything unrecognised: an unreadable URL is blind.

import { proto } from "./shared.js";

/** @typedef {{ blind?: string[], readonly?: string[] }} FloorConfig */
/** @typedef {{ allow: boolean, tier: "blind"|"hands"|"open", why: string }} Verdict */

/** [host, optional path prefix]. A host matches itself and its subdomains. */
const BLIND_HOSTS = /** @type {[string, string?][]} */ ([
  ["chromewebstore.google.com"], ["chrome.google.com", "/webstore"],
  ["accounts.google.com"], ["passwords.google.com"],
  ["vyre.run"],
  ["1password.com"], ["1password.eu"], ["1password.ca"],
  ["vault.bitwarden.com"], ["vault.bitwarden.eu"],
  ["lastpass.com"], ["dashlane.com"], ["keepersecurity.com"],
  ["proton.me", "/pass"], ["pass.proton.me"],
  ["appleid.apple.com"], ["passwords.apple.com"], ["icloud.com", "/passwords"], ["apple.com", "/passwords"],
  // banks and payment accounts: a short list of the common ones; the person's own list adds more.
  ["chase.com"], ["bankofamerica.com"], ["wellsfargo.com"], ["citi.com"], ["capitalone.com"],
  ["usbank.com"], ["pnc.com"], ["truist.com"], ["ally.com"], ["schwab.com"], ["fidelity.com"],
  ["americanexpress.com"], ["discover.com"], ["paypal.com"], ["hsbc.com"], ["barclays.co.uk"],
]);

/** host:port surfaces that belong to Vyre on this machine. */
const BLIND_LOCAL = new Set(["localhost:7300", "localhost:7788", "127.0.0.1:7300", "127.0.0.1:7788", "[::1]:7300", "[::1]:7788"]);
const BLIND_SCHEMES = new Set(["chrome:", "chrome-extension:", "edge:", "devtools:", "chrome-untrusted:", "chrome-search:", "view-source:"]);
const OPEN_SCHEMES = new Set(["http:", "https:", "file:"]);

/** @param {string} path @param {string} prefix */
const underPath = (path, prefix) => path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");

/** @param {string} host @param {string} domain */
const hostIs = (host, domain) => host === domain || host.endsWith("." + domain);

/**
 * Does one configured entry cover this URL? Entries are "host", "*.host", "host/path", a
 * "host:port", or a full scheme prefix like "chrome://settings".
 * @param {URL} u @param {string} url @param {string} entry
 */
function covers(u, url, entry) {
  const e = String(entry || "").trim().toLowerCase();
  if (!e) return false;
  if (e.includes("://")) return url.toLowerCase().startsWith(e);
  const slash = e.indexOf("/");
  const hostPart = (slash < 0 ? e : e.slice(0, slash)).replace(/^\*\./, "");
  const pathPart = slash < 0 ? "" : e.slice(slash);
  const host = hostPart.includes(":") ? u.host.toLowerCase() : u.hostname.toLowerCase();
  if (!hostIs(host, hostPart)) return false;
  return !pathPart || underPath(u.pathname.toLowerCase(), pathPart.replace(/\/$/, ""));
}

/**
 * The tier of a URL.
 * @param {string|undefined|null} url @param {FloorConfig} [cfg]
 * @returns {{ tier: "blind"|"hands"|"open", why: string }}
 */
export function tierOf(url, cfg = {}) {
  const s = String(url ?? "");
  if (!s) return { tier: "blind", why: "the page has no readable address" };
  if (s === "about:blank") return { tier: "open", why: "blank page" };
  let u;
  try { u = new URL(s); } catch { return { tier: "blind", why: "the address cannot be parsed" }; }
  if (u.protocol === "about:") return { tier: "blind", why: "a browser page" };
  if (BLIND_SCHEMES.has(u.protocol)) return { tier: "blind", why: "a browser page" };
  if (!OPEN_SCHEMES.has(u.protocol)) return { tier: "blind", why: `${u.protocol} pages are not driven` };
  const host = u.hostname.toLowerCase();
  if (BLIND_LOCAL.has(u.host.toLowerCase())) return { tier: "blind", why: "a Vyre surface" };
  for (const [h, p] of BLIND_HOSTS) {
    if (hostIs(host, h) && (!p || underPath(u.pathname.toLowerCase(), p))) return { tier: "blind", why: "a sign-in, password or bank page" };
  }
  for (const e of cfg.blind || []) if (covers(u, s, e)) return { tier: "blind", why: "on your blind list" };
  for (const e of cfg.readonly || []) if (covers(u, s, e)) return { tier: "hands", why: "on your read-only list" };
  return { tier: "open", why: "an ordinary page" };
}

/**
 * May this op run on a page at this URL? Acting ops need `open`; reading ops need not `blind`.
 * @param {string|undefined|null} url @param {string} op @param {FloorConfig} [cfg]
 * @returns {Verdict}
 */
export function decide(url, op, cfg = {}) {
  const { tier, why } = tierOf(url, cfg);
  if (tier === "blind") return { allow: false, tier, why };
  if (tier === "hands" && proto.ACTING.has(op)) return { allow: false, tier, why: why + "; it can be read but not acted on" };
  return { allow: true, tier, why };
}
