// @ts-check
// A join link opened from outside the app (a tapped link, a vyre:// open) carries the invite token. The token is read once, kept in memory only, and taken out of the address:
// it is never left in a query string, never written to storage, never logged, never handed on as a referrer. A link from outside is untrusted input: the invite card it opens
// still names the space and asks the person to confirm.

/** @type {string | null} */
let held = null;

/** Keep a link in memory for the screen that will open it. @param {string} link */
export function holdJoin(link) { held = link; }

/** @type {{ link: string, at: number } | null} */
let taken = null;
/** How long a second read of the same link is answered: React's development double-run of an initialiser reads twice, and must not leave the card empty. */
const SAME_READ_MS = 1000;

/** The held link, once. A second read within a second (the double-run) gets the same link; after that it is empty. @param {number} [now] */
export function takeJoin(now = Date.now()) {
  if (held !== null) { const l = held; held = null; taken = { link: l, at: now }; return l; }
  if (taken && now - taken.at < SAME_READ_MS) return taken.link;
  taken = null;
  return null;
}

/** The link with its token left off, for showing on screen and for any log line. @param {string} link */
export function withoutToken(link) { return link.replace(/\/join\/.*$/, "/join/…"); }

/** The address a page shows after the token is taken out: the same path, no query, no fragment. @param {string} href */
export function cleanAddress(href) { try { const u = new URL(href); return u.pathname; } catch { return "/"; } }

/** A link carried in the fragment (`#link=<url-encoded https join link>`): a fragment is never sent to a server, so this is the form a hosted page should hand over. @param {string} hash */
export function linkFromHash(hash) {
  const m = /^#?(?:.*&)?link=([^&]*)/.exec(String(hash || ""));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
