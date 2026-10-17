// GENERATED from lib/siteops/outbound.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// outbound: classify sends and gate writes for chrome.api on the box (parity with hands-chrome-mac).

/** @param {string} method @param {string} url @param {string} [body] @returns {{ send: boolean, why: string }} */
export function classifySend(method, url, body) {
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || m === "DELETE") return { send: false, why: "" };
  let path = String(url || "");
  try { path = new URL(path, "http://x.invalid").pathname; } catch { /* keep */ }
  path = path.toLowerCase();
  const GHL = [
    /\/conversations\/messages(\/|$)/, /\/conversations\/[^/]+\/messages(\/|$)/, /\/conversations\/[^/]+\/(send|reply)/,
    /\/campaigns?\/[^/]*\/?(start|send|resume)/, /\/marketing\/(emails?|sms)\/[^/]*\/?(send|schedule)/,
    /\/invoices?\/[^/]*\/?(send|record-payment|remind)/, /\/payments?\/(orders|charge|transactions)\b/,
    /\/social-media-posting\//, /\/emails\/(send|schedule)/, /\/workflows?\/[^/]+\/(enroll|trigger)/,
  ];
  for (const re of GHL) if (re.test(path)) return { send: true, why: "it messages, posts or charges as the person" };
  if (/(^|\/)(send|sends|sendmessage|message|messages|messaging|sms|email|emails|mail|publish|post|posts|pay|payment|payments|charge|charges|checkout|transfer|transfers|payout|payouts|broadcast|broadcasts|blast|tweet|reply|forward|dm|share)(\/|$|\.)/.test(path)) {
    return { send: true, why: "the endpoint sends, posts or pays" };
  }
  if (/(graphql|\/rpc|\/trpc)/.test(path) && /["']?(send|publish|pay|charge|post|reply|forward|broadcast)[a-z]*["']?\s*[(:{]|mutation[^{]*\b(send|publish|pay|charge|post)/i.test(String(body || ""))) {
    return { send: true, why: "the mutation sends, posts or pays" };
  }
  return { send: false, why: "" };
}

/** @param {string} s */
export function digest(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** @param {string} method @param {string} url @param {string} why @param {string} sigSource */
export function held(method, url, why, sigSource) {
  let path = url;
  try { const u = new URL(url); path = u.origin + u.pathname; } catch { /* raw */ }
  return {
    held: true,
    send: true,
    why: `This would ${String(method).toUpperCase()} ${path}: ${why}. It sends something as the person and nobody asked for it, so it waits for their approval.`,
    method: String(method).toUpperCase(),
    sig: digest(sigSource),
  };
}

/** @param {string} method */
export const writeKind = method => ({ POST: "create", PUT: "edit", PATCH: "edit", DELETE: "delete" }[String(method).toUpperCase()] || "edit");

/** @param {string} method @param {string} url @param {string} sigSource */
export function heldWrite(method, url, sigSource) {
  let path = url;
  try { const u = new URL(url); path = u.origin + u.pathname; } catch { /* raw */ }
  const m = String(method).toUpperCase();
  let origin = ""; try { origin = new URL(url).origin; } catch { /* raw */ }
  return {
    held: true,
    write: true,
    kind: writeKind(m),
    method: m,
    ...(origin ? { origin } : {}),
    why: `This would ${m} ${path}, a change made with the person's login. Nothing was done. It waits for their approval, or for a plan they approved that covers it.`,
    sig: digest(sigSource),
  };
}

export const PASS = Symbol("vyre.write-passed");

/**
 * @param {string} method @param {string} url @param {string} body
 * @param {{ asked?: boolean, writeOk?: boolean, approved?: boolean }} [trust]
 */
export function writeGate(method, url, body, trust = {}) {
  const m = String(method || "GET").toUpperCase();
  if (/^(GET|HEAD|OPTIONS)$/.test(m)) return { pass: PASS };
  if (trust && (trust.asked === true || trust.writeOk === true || trust.approved === true)) return { pass: PASS };
  return { held: heldWrite(m, url, `${m} ${url} ${body || ""}`) };
}
