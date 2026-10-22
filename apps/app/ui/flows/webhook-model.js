// @ts-check
// A Flow's own webhook address as the trigger editor shows it: the address (or one plain line saying why there is none yet), the last delivery in words, and a sample a sender or a form can use.
// Pure; hooks.flow is read in screens/flows/watchers-source.ts. The address carries its token, so nothing here logs it or puts it anywhere but the copy the person asked for.

/** @typedef {{ when?: string, at?: string, ok: boolean, why?: string, bytes: number, test?: boolean }} Last */
/** @typedef {{ open: boolean, address: { path: string, url: string | null } | null, why: string | null, last: Last | null, check: { scheme: string, header?: string, secret: string } | null }} FlowHook */

/** The signature checks a sender may add, under "Advanced, verify a signature". */
export const SIGN_SCHEMES = /** @type {[string, string][]} */ ([["none", "None"], ["hmac-sha256", "Signed body"], ["github", "GitHub"], ["stripe", "Stripe"]]);
const SCHEME = /** @type {Record<string, string>} */ ({ "hmac-sha256": "a hex HMAC-SHA256 of the body, in the header you name", github: "GitHub's X-Hub-Signature-256", stripe: "Stripe's Stripe-Signature" });
export const schemeWords = (/** @type {string} */ s) => SCHEME[s] ?? s;

/** A size in plain words. @param {number} n */
export const sizeWords = (n) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`);

/**
 * What the panel says: `live` (the address works from the internet), `here` (open, but the server has no public address yet, or webhooks are off: `line` says why and what to do), `off` (the Flow is
 * off or not saved yet), or `none` (this server takes no webhooks). @param {FlowHook | null | undefined} h
 */
export function addressFacts(h) {
  if (!h) return { state: "none", address: "", line: "This server does not take webhooks yet." };
  if (!h.open || !h.address) return { state: "off", address: "", line: h.why || "Turn the Flow on and its address shows here." };
  if (h.address.url) return { state: "live", address: h.address.url, line: "" };
  // No public url yet: the path is still the address (it carries the token), and the page copies it. `line` says why senders on the internet cannot use it yet.
  return { state: "here", address: typeof h.address.path === "string" ? h.address.path : "", line: h.why || "The server has no public address yet, so senders on the internet cannot reach it." };
}

/** The last delivery in words: when, OK or refused and why, its size. Never the token or the body. @param {Last | null | undefined} l */
export function lastWords(l) {
  if (!l) return "Nothing has arrived yet.";
  const when = l.when || l.at || "";
  const what = l.ok ? (l.test ? "the test from Vyre, OK" : "OK") : `refused, ${l.why || "it did not check"}`;
  return `${when ? `${when}: ` : ""}${what}. ${sizeWords(l.bytes)}.`;
}

/** A test a sender's developer can run: JSON to the address, nothing else needed (the token is in the address). @param {string} url */
export function curlSample(url) {
  return `curl -X POST '${url}' -H 'content-type: application/json' -d '{"name":"Sam Lee","email":"sam@example.com"}'`;
}

/** A form on a site that posts to the address: plain HTML, fields arrive as the Flow's trigger values. @param {string} url */
export function formSample(url) {
  return [`<form method="post" action="${url}">`, `  <input name="name" placeholder="Name">`, `  <input name="email" type="email" placeholder="Email">`, `  <button>Send</button>`, `</form>`].join("\n");
}
