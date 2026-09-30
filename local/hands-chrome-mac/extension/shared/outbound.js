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
    control: { role: "request", name: `${String(method).toUpperCase()} ${path}` }, fields: [], sig: digest(sigSource),
    ...(/(^|\/)(publish|published|activate|go-live|golive)(\/|$)/i.test(path) ? { kind: "publish", method: String(method).toUpperCase() } : {}) };
}

/** What a write is, in a person's words: POST creates, PUT and PATCH edit, DELETE deletes. @param {string} method */
export const writeKind = method => ({ POST: "create", PUT: "edit", PATCH: "edit", DELETE: "delete" }[String(method).toUpperCase()] || "edit");

/** A change made with the person's login that is not a message, post or payment: held unless a plan they approved covers it, or they asked for it. */
export function heldWrite(method, url, sigSource) {
  let path = url;
  try { const u = new URL(url); path = u.origin + u.pathname; } catch { /* raw */ }
  const m = String(method).toUpperCase();
  let origin = ""; try { origin = new URL(url).origin; } catch { /* raw */ }
  return { ok: false, held: true, write: true, kind: writeKind(m), method: m, ...(origin ? { origin } : {}), why: `This would ${m} ${path}, a change made with the person's login. Nothing was done. It waits for their approval, or for a plan they approved that covers it.`,
    control: { role: "request", name: `${m} ${path}` }, fields: [], sig: digest(sigSource) };
}

/** The one proof that a request went through the write gate. Only writeGate() returns it, and pageFetch() refuses a write without it. */
export const PASS = Symbol("vyre.write-passed");

/**
 * THE write gate. Every request Vyre issues with the page's credentials (api.call, net.replay, anything later) asks here first; pageFetch() will not
 * send a write without the pass this returns. A read passes. A write passes only when the person asked for this very call (asked) or the module
 * says a plan they approved covers it (writeOk, which the module sets and a model's input cannot). Anything else comes back as a held write.
 * @param {string} method @param {string} url @param {string} body @param {{ asked?: boolean, writeOk?: boolean }} [trust] what the host approved (never the caller's args)
 * @returns {{ pass: symbol, held?: undefined } | { held: any, pass?: undefined }}
 */
export function writeGate(method, url, body, trust = {}) {
  const m = String(method || "GET").toUpperCase();
  if (/^(GET|HEAD|OPTIONS)$/.test(m)) return { pass: PASS };
  if (trust && (trust.asked === true || trust.writeOk === true)) return { pass: PASS };
  return { held: heldWrite(m, url, `${m} ${url} ${body || ""}`) };
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
  // chrome.eval sets __vyreWrites: a script may read with the page's login but not write with it. A write goes through api.call, which is asked first.
  const writes = window.__vyreWrites === true;
  const hold = (m, u, b) => { const c = classifySend(m, u, b); if (writes && !c.send && !/^(GET|HEAD|OPTIONS)$/i.test(String(m))) { blocked.push({ method: String(m).toUpperCase(), url: String(u), why: "write", write: true }); return true; } if (c.send) { blocked.push({ method: String(m).toUpperCase(), url: String(u), why: c.why }); return true; } return false; };
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
  // A script that submits a form writes too (form.submit(), form.requestSubmit(), or a click on a submit button), not only fetch and XHR. Under the eval flag a non-GET form submit is refused.
  const fs = HTMLFormElement.prototype.submit, frs = HTMLFormElement.prototype.requestSubmit;
  const formWrite = f => { try { return writes && String(f.method || "get").toLowerCase() !== "get"; } catch { return writes; } };
  HTMLFormElement.prototype.submit = function () { if (formWrite(this)) { hold(String(this.method || "POST"), this.action || location.href, "form"); blocked[blocked.length - 1].write = true; return; } return fs.apply(this, arguments); };
  if (frs) HTMLFormElement.prototype.requestSubmit = function () { if (formWrite(this)) { hold(String(this.method || "POST"), this.action || location.href, "form"); blocked[blocked.length - 1].write = true; return; } return frs.apply(this, arguments); };
  const subMethod = e => { try { const m = e.submitter && e.submitter.formMethod; return String(m || e.target.method || "get").toLowerCase(); } catch { return "post"; } };
  const onSubmit = e => { if (writes && subMethod(e) !== "get") { e.preventDefault(); e.stopImmediatePropagation(); blocked.push({ method: subMethod(e).toUpperCase(), url: String((e.submitter && e.submitter.formAction) || e.target.action || location.href), why: "form", write: true }); } };
  if (writes) document.addEventListener("submit", onSubmit, true);
  // Channels the network layer does not always see: WebRTC (ICE resolves a hostname) and link hints that make the browser
  // resolve or connect (dns-prefetch, preconnect, prefetch). A cross-origin one made by the script is refused and reported.
  const RTC = window.RTCPeerConnection, WRTC = window.webkitRTCPeerConnection;
  const refuse = (what, u) => { blocked.push({ method: what, url: String(u), why: "the script tried to open a channel to another site" }); };
  if (RTC) window.RTCPeerConnection = function () { refuse("WEBRTC", "webrtc"); throw new Error("Vyre held this"); };
  if (WRTC) window.webkitRTCPeerConnection = window.RTCPeerConnection;
  const hint = n => { try { if (!n || n.tagName !== "LINK") return false; const rel = String(n.getAttribute("rel") || n.rel || ""); if (!/(^|\s)(dns-prefetch|preconnect|prefetch|prerender|preload)(\s|$)/i.test(rel)) return false; const h = n.getAttribute("href"); return !h || new URL(h, location.href).origin !== location.origin; } catch { return true; } };
  // A new WebSocket to another host is refused (a socket the page already holds is untouched). Plain form only.
  const WS = window.WebSocket;
  if (WS) {
    const G = function WebSocket(u, p) { let host = ""; try { host = new URL(String(u), location.href).host; } catch (e) { host = ""; } if (host && host !== location.host) { refuse("WEBSOCKET", u); throw new Error("Vyre held this"); } return p === undefined ? new WS(u) : new WS(u, p); };
    G.prototype = WS.prototype; for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) G[k] = WS[k];
    window.WebSocket = G;
  }
  const P = Node.prototype, E = Element.prototype;
  const oa = P.appendChild, oi = P.insertBefore, oap = E.append, opp = E.prepend;
  P.appendChild = function (n) { if (hint(n)) { refuse("LINK", n.getAttribute("href")); return n; } return oa.apply(this, arguments); };
  P.insertBefore = function (n) { if (hint(n)) { refuse("LINK", n.getAttribute("href")); return n; } return oi.apply(this, arguments); };
  E.append = function () { for (const n of arguments) if (hint(n)) { refuse("LINK", n.getAttribute("href")); return; } return oap.apply(this, arguments); };
  E.prepend = function () { for (const n of arguments) if (hint(n)) { refuse("LINK", n.getAttribute("href")); return; } return opp.apply(this, arguments); };
  window.__vyreGuard = { blocked, restore() { if (WS) window.WebSocket = WS; if (RTC) window.RTCPeerConnection = RTC; if (WRTC) window.webkitRTCPeerConnection = WRTC; P.appendChild = oa; P.insertBefore = oi; E.append = oap; E.prepend = opp; window.fetch = of; XMLHttpRequest.prototype.open = xo; XMLHttpRequest.prototype.send = xs; if (sb) navigator.sendBeacon = sb; HTMLFormElement.prototype.submit = fs; if (frs) HTMLFormElement.prototype.requestSubmit = frs; document.removeEventListener("submit", onSubmit, true); } };
  return true;
})()`;

/** The same guard for chrome.eval: a script may read with the page's login but not write with it. */
export const guardInstallWrites = "window.__vyreWrites = true;" + guardInstall;

export const guardCollect = `(() => { const g = window.__vyreGuard; if (!g) return []; g.restore(); delete window.__vyreGuard; return g.blocked; })()`;
