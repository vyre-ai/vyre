// @ts-check
// The headers wink.vyre.run's Worker puts on every response (tailnet's Worker adds them; test/wink.test.js holds them to the page).
// The page is one screen with a Pair button: nobody may frame it (clickjacking), and nothing but its own files may run.
//   default-src 'none', script and style from itself only, no inline anything, no connections at all (the page looks nothing up: it decodes the ring and hands it to the app), no frames, no forms,
//   no base tag, camera for this origin only, no referrer (the seed rides in a URL fragment and must not leak).

/** The relay the page may reach: the ticket lookup (https) and its channel (wss). Nothing else. */
export const RELAY_HTTPS = "https://relay.vyre.run";
export const RELAY_WSS = "wss://relay.vyre.run";

/** Without frame-ancestors, which a <meta> CSP cannot carry (the header does). */
export const CSP_BODY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
  "connect-src 'none'", "worker-src 'self'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'",
].join("; ");

export const CSP = `${CSP_BODY}; frame-ancestors 'none'`;

export const HEADERS = Object.freeze({
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), interest-cohort=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});
