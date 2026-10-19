// @ts-check
// A webhook route as the Flow editor shows it: the address, the header and the signature scheme, how to try it, and why it cannot be reached yet. Pure; hooks.list and hooks.status are read in screens/flows/watchers-source.ts.

/** @typedef {{ name: string, scheme?: string, header?: string, secret?: string }} Route */
/** @typedef {{ enabled: boolean, listening: boolean, routes: Route[], public: { available: boolean, base?: string, why?: string }, urls: Record<string, string | null> }} Hooks */

const SCHEME = /** @type {Record<string, string>} */ ({ "hmac-sha256": "the hex HMAC-SHA256 of the body", github: "GitHub's X-Hub-Signature-256", stripe: "Stripe's Stripe-Signature" });

/** What a person needs about one route, in words: its address (or why it has none yet), the header the sender signs in, the Vault item that holds the secret, and what to do next. @param {Hooks | null} h @param {string} name */
export function routeFacts(h, name) {
  if (!h) return { found: false, url: "", line: "This box does not have webhooks.", next: "none", header: "", secret: "", scheme: "" };
  const r = h.routes.find((x) => x.name === name);
  if (!r) return { found: false, url: "", line: `/hooks/${name} is not open yet.`, next: "open", header: "", secret: "", scheme: "" };
  const url = h.urls[name] || "";
  const live = !!url;
  const line = live ? "Reachable from the internet." : !h.enabled || !h.listening ? "The listener is off, so nothing can reach this route." : h.public.why || "The box has no public address yet, so only this machine can reach it.";
  return { found: true, url, line, next: live ? "none" : !h.enabled || !h.listening ? "enable" : "wait", header: r.header || "", secret: r.secret || "", scheme: r.scheme || "" };
}

/** A command that sends a test delivery, for the sender's developer or for a terminal. The signature is computed from the secret in the Vault; the secret is never put in the text. @param {string} url @param {string} scheme @param {string} header */
export function sampleCall(url, scheme, header) {
  const sig = scheme === "hmac-sha256" ? `"${header || "x-signature"}: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"` : scheme === "github" ? `"X-Hub-Signature-256: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"` : null;
  if (!sig) return `# ${scheme === "stripe" ? "Stripe signs its own deliveries: use the Stripe CLI (stripe trigger) pointed at the address above." : "This scheme is signed by the sender."}`;
  return [`BODY='{"hello":"world"}'`, `SECRET='<the value of the Vault item>'`, `curl -X POST '${url || "https://<your address>/hooks/<route>"}' -H 'content-type: application/json' -H ${sig} -d "$BODY"`].join("\n");
}

export const schemeWords = (/** @type {string} */ s) => SCHEME[s] ?? s;
