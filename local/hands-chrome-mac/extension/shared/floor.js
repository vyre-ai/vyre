// @ts-check
// floor: the URL tier for a Chrome tab. ONE list and ONE function, imported by the module
// (floor-url.js, decided before anything is sent) and by the extension (lib/floor.js, re-checked in
// the worker), so the two can never drift (reviewer-2). Each side still enforces it on its own.
//
//   blind   the page returns nothing and every op on it is refused: a bank, a password manager's
//           web vault, a sign-in page, Vyre's own surfaces, the browser's own pages, the Web Store
//   hands   readable, but nothing may act on it (a payments dashboard, account security settings)
//   open    everything else
//
// This is the same idea as screen-mac/floor.js for apps, keyed by origin and path instead of by
// bundle id. Deployments add to it through cfg: { box, blind: [], hands: [], open: [] }, where each
// entry is a host ("example.com" covers its subdomains) or a host plus path ("example.com/admin").

import { ACTING } from "./proto.js";

/** Origin of a URL, or protocol//host for one URL() gives "null" for (chrome:, about:). @param {string|null|undefined} u */
export function originOf(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u));
    if (x.origin && x.origin !== "null") return x.origin;
    return x.host ? `${x.protocol}//${x.host}` : `${x.protocol}`;
  } catch { return null; }
}

/** Only these schemes are ordinary pages; everything else is the browser's own or code, and is blind. */
const OPEN_SCHEMES = new Set(["http:", "https:", "file:"]);

/** [host, optional path prefix]. A host matches itself and its subdomains. */
const BLIND_HOSTS = /** @type {[string, string?][]} */ ([
  ["chromewebstore.google.com"], ["chrome.google.com", "/webstore"], ["microsoftedge.microsoft.com", "/addons"],
  ["accounts.google.com"], ["passwords.google.com"],
  ["vyre.run"], ["vyre.sh"],
  ["1password.com"], ["1password.eu"], ["1password.ca"],
  ["vault.bitwarden.com"], ["vault.bitwarden.eu"],
  ["lastpass.com"], ["dashlane.com"], ["keepersecurity.com"], ["nordpass.com"],
  ["proton.me", "/pass"], ["pass.proton.me"],
  ["appleid.apple.com"], ["passwords.apple.com"], ["icloud.com", "/passwords"], ["apple.com", "/passwords"],
  ["login.microsoftonline.com"], ["login.live.com"], ["login.okta.com"], ["signin.aws.amazon.com"],
  // banks and payment accounts: the common ones; the person's own list adds more, and a hostname
  // that says "bank" is caught below.
  ["chase.com"], ["bankofamerica.com"], ["wellsfargo.com"], ["citi.com"], ["citibank.com"], ["capitalone.com"],
  ["usbank.com"], ["pnc.com"], ["truist.com"], ["ally.com"], ["schwab.com"], ["fidelity.com"], ["vanguard.com"],
  ["americanexpress.com"], ["discover.com"], ["paypal.com"], ["venmo.com"], ["wise.com"], ["revolut.com"],
  ["coinbase.com"], ["robinhood.com"], ["hsbc.com"], ["barclays.co.uk"], ["lloydsbank.com"], ["santander.com"], ["tdbank.com"],
]);

/** host:port surfaces that belong to Vyre on this machine. */
const BLIND_LOCAL = new Set(["localhost:7300", "localhost:7788", "127.0.0.1:7300", "127.0.0.1:7788", "[::1]:7300", "[::1]:7788"]);

/** @param {string} path @param {string} prefix */
const underPath = (path, prefix) => path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
/** @param {string} host @param {string} domain */
const hostIs = (host, domain) => host === domain || host.endsWith("." + domain);

/**
 * Does one configured entry cover this URL? Entries are "host", "*.host", "host/path", a
 * "host:port", or a scheme prefix like "chrome://settings".
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

/** Whether an op can change a page or send something. @param {string|undefined} op */
export const acts = op => Boolean(op) && (ACTING.has(/** @type {string} */ (op)) || op === "net.on" || op === "tabs.open" || op === "tabs.close");

/**
 * The tier of a URL and whether `op` may run on it.
 * @param {string|null|undefined} url @param {string} [op] without one, allow means "may be read"
 * @param {{ box?: string|null, blind?: string[], hands?: string[], readonly?: string[], open?: string[] }} [cfg]
 * @returns {{ tier: "blind"|"hands"|"open", allow: boolean, why: string|null }}
 */
export function classify(url, op, cfg = {}) {
  const raw = String(url ?? "").trim();
  const done = (/** @type {"blind"|"hands"|"open"} */ tier, /** @type {string|null} */ why) =>
    ({ tier, allow: tier === "open" || (tier === "hands" && !acts(op)), why });
  if (!raw) return done("blind", "the page has no readable address");
  if (raw === "about:blank") return done("open", null);
  let u;
  try { u = new URL(raw); } catch { return done("blind", "the address cannot be parsed"); }
  // view-source:, javascript:, chrome:, about:, data: and the rest are not pages Vyre drives.
  if (!OPEN_SCHEMES.has(u.protocol)) return done("blind", "a browser page, not a website");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");

  // The person's deployment decides first, both ways: open lets one origin out of a built-in
  // rule they know better than we do; blind and hands add to them.
  if ((cfg.open || []).some(e => covers(u, raw, e))) return done("open", null);
  if (cfg.box) { const bo = originOf(cfg.box); if (bo && originOf(raw) === bo) return done("blind", "a Vyre surface in the browser"); }
  if (BLIND_LOCAL.has(u.host.toLowerCase())) return done("blind", "a Vyre surface");
  for (const [h, p] of BLIND_HOSTS) {
    if (hostIs(host, h) && (!p || underPath(u.pathname.toLowerCase(), p))) return done("blind", h === "vyre.run" || h === "vyre.sh" ? "a Vyre surface" : "a sign-in, password or bank page");
  }
  if (/(^|[.-])(bank|banking|onlinebanking|netbanking)([.-]|$)/.test(host)) return done("blind", "a bank or payment account");
  for (const e of cfg.blind || []) if (covers(u, raw, e)) return done("blind", "on the blind list");
  for (const e of [...(cfg.hands || []), ...(cfg.readonly || [])]) if (covers(u, raw, e)) return done("hands", "on the read-only list");
  return done("open", null);
}
