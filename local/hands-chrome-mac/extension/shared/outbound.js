// @ts-check
// outbound: is a request one that SENDS something as the person (a message, an email, a post, a
// payment), judged by method and endpoint. Only those are held at the Gate, and only when nobody
// asked and no standing permission covers them (the no-nag list). Reading, and writing that sends
// nothing (tagging a contact, saving a draft, building a workflow), is hands-free after the grant.
//
// classifySend is SELF-CONTAINED on purpose: page.eval injects its source into the page, so the
// exact function that judges an api.call also judges a script's own fetch and XHR calls.

/**
 * @param {string} method @param {string} url @param {string} [body]
 * @returns {{ send: boolean, why: string }}
 */
export function classifySend(method, url, body) {
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || m === "DELETE") return { send: false, why: "" };
  let path = String(url || "");
  try { path = new URL(path, "http://x.invalid").pathname; } catch { /* keep the raw string */ }
  path = path.toLowerCase();
  // GoHighLevel's own outbound endpoints: conversations (SMS, email, WhatsApp, DMs), campaigns and
  // bulk actions that message contacts, invoices and payments, social posting.
  const GHL = [
    /\/conversations\/messages(\/|$)/, /\/conversations\/[^/]+\/messages(\/|$)/, /\/conversations\/[^/]+\/(send|reply)/,
    /\/campaigns?\/[^/]*\/?(start|send|resume)/, /\/marketing\/(emails?|sms)\/[^/]*\/?(send|schedule)/,
    /\/invoices?\/[^/]*\/?(send|record-payment|remind)/, /\/payments?\/(orders|charge|transactions)\b/,
    /\/social-media-posting\//, /\/emails\/(send|schedule)/, /\/workflows?\/[^/]+\/(enroll|trigger)/,
  ];
  for (const re of GHL) if (re.test(path)) return { send: true, why: "it messages, posts or charges as the person" };
  // Anything else: a write to an endpoint whose name says it sends, posts or pays.
  if (/(^|\/)(send|sends|sendmessage|message|messages|messaging|sms|email|emails|mail|publish|post|posts|pay|payment|payments|charge|charges|checkout|transfer|transfers|payout|payouts|broadcast|broadcasts|blast|tweet|reply|forward|dm|share)(\/|$|\.)/.test(path)) {
    return { send: true, why: "the endpoint sends, posts or pays" };
  }
  // GraphQL and RPC endpoints name the action in the body.
  if (/(graphql|\/rpc|\/trpc)/.test(path) && /["']?(send|publish|pay|charge|post|reply|forward|broadcast)[a-z]*["']?\s*[(:{]|mutation[^{]*\b(send|publish|pay|charge|post)/i.test(String(body || ""))) {
    return { send: true, why: "the mutation sends, posts or pays" };
  }
  return { send: false, why: "" };
}

/** A short stable digest for a held request's signature. @param {string} s */
export function digest(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The held-result shape page.act uses, for a request. @param {string} method @param {string} url @param {string} why @param {string} sigSource */
export function held(method, url, why, sigSource) {
  let path = url;
  try { const u = new URL(url); path = u.origin + u.pathname; } catch { /* raw */ }
  return { ok: false, held: true, why: `This would ${String(method).toUpperCase()} ${path}: ${why}. It sends something as the person and nobody asked for it, so it waits for their approval.`,
    control: { role: "request", name: `${String(method).toUpperCase()} ${path}` }, fields: [], sig: digest(sigSource) };
}

/**
 * Two page scripts that bracket a user script: install a shim that holds back the page's own network
 * sends (fetch, XHR, sendBeacon) and records them, then take the shim off and read what it caught.
 * They are separate evaluations (not a wrapper around the user's text) so the user's script runs
 * exactly as written and a page's Content-Security-Policy against eval cannot break it.
 * Not a defence against a hostile page (it can reach the original fetch some other way): it stops a
 * script an agent wrote from sending by accident or by a prompt-injected instruction.
 */
export const guardInstall = `(() => {
  if (window.__vyreGuard) return true;
  const classifySend = ${classifySend.toString()};
  const blocked = [];
  const hold = (m, u, b) => { const c = classifySend(m, u, b); if (c.send) { blocked.push({ method: String(m).toUpperCase(), url: String(u), why: c.why }); return true; } return false; };
  const of = window.fetch, xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send, sb = navigator.sendBeacon;
  window.fetch = function (i, o) {
    const m = (o && o.method) || (i && i.method) || "GET", u = (i && i.url) || i;
    if (hold(m, u, o && typeof o.body === "string" ? o.body : "")) return Promise.reject(new TypeError("Vyre held this send"));
    return of.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function (m, u) { this.__vyre = [m, u]; return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__vyre && hold(this.__vyre[0], this.__vyre[1], typeof b === "string" ? b : "")) throw new Error("Vyre held this send");
    return xs.apply(this, arguments);
  };
  if (sb) navigator.sendBeacon = function (u, d) { if (hold("POST", u, typeof d === "string" ? d : "")) return false; return sb.apply(this, arguments); };
  // Channels the network layer does not always see: WebRTC (ICE resolves a hostname) and link hints that make the browser
  // resolve or connect (dns-prefetch, preconnect, prefetch). A cross-origin one made by the script is refused and reported.
  const RTC = window.RTCPeerConnection, WRTC = window.webkitRTCPeerConnection;
  const refuse = (what, u) => { blocked.push({ method: what, url: String(u), why: "the script tried to open a channel to another site" }); };
  if (RTC) window.RTCPeerConnection = function () { refuse("WEBRTC", "webrtc"); throw new Error("Vyre held this"); };
  if (WRTC) window.webkitRTCPeerConnection = window.RTCPeerConnection;
  const hint = n => { try { if (!n || n.tagName !== "LINK") return false; const rel = String(n.getAttribute("rel") || n.rel || ""); if (!/(^|\s)(dns-prefetch|preconnect|prefetch|prerender|preload)(\s|$)/i.test(rel)) return false; const h = n.getAttribute("href"); return !h || new URL(h, location.href).origin !== location.origin; } catch { return true; } };
  const P = Node.prototype, E = Element.prototype;
  const oa = P.appendChild, oi = P.insertBefore, oap = E.append, opp = E.prepend;
  P.appendChild = function (n) { if (hint(n)) { refuse("LINK", n.getAttribute("href")); return n; } return oa.apply(this, arguments); };
  P.insertBefore = function (n) { if (hint(n)) { refuse("LINK", n.getAttribute("href")); return n; } return oi.apply(this, arguments); };
  E.append = function () { for (const n of arguments) if (hint(n)) { refuse("LINK", n.getAttribute("href")); return; } return oap.apply(this, arguments); };
  E.prepend = function () { for (const n of arguments) if (hint(n)) { refuse("LINK", n.getAttribute("href")); return; } return opp.apply(this, arguments); };
  window.__vyreGuard = { blocked, restore() { if (RTC) window.RTCPeerConnection = RTC; if (WRTC) window.webkitRTCPeerConnection = WRTC; P.appendChild = oa; P.insertBefore = oi; E.append = oap; E.prepend = opp; window.fetch = of; XMLHttpRequest.prototype.open = xo; XMLHttpRequest.prototype.send = xs; if (sb) navigator.sendBeacon = sb; } };
  return true;
})()`;

export const guardCollect = `(() => { const g = window.__vyreGuard; if (!g) return []; g.restore(); delete window.__vyreGuard; return g.blocked; })()`;
