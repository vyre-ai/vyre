// @ts-check
// passkey-page: the one Vyre script that runs in the page's own world (MAIN), in every frame,
// at document_start, once the person has passkeys on in the popup. It stands in for
// navigator.credentials.create and .get so a site's passkey request can be answered by vyred,
// which holds the private key and signs (core/vault/fill-passkey.js).
//
// Why it is built this way:
//   - It holds nothing and reaches nothing. It turns the page's own request into JSON, posts it
//     to passkey-bridge.js (the isolated content script) on this window, and waits. The bridge
//     asks the person and the background worker; the worker names the page's origin from the
//     browser's sender, so nothing this script or the page says can choose another site.
//   - Only `publicKey` requests are touched. Passwords, federated and OTP credentials, and every
//     conditional or silent request go straight to the browser's own functions, saved at
//     injection before any page script ran. So does anything this script cannot read.
//   - A reply of { fallback: true } (the person chose another device, the vault is not paired
//     or vyred is down) calls the browser's own function with the page's ORIGINAL options
//     object, signal included, so the site sees exactly what it would have seen without Vyre.
//   - Replies carry a random channel id made per injection, so two frames or two injections
//     never answer each other. The page can read that id; it gains nothing by it, because the
//     page is already the caller and every answer still needs the person's trusted click.
//   - The result is a PublicKeyCredential-shaped object whose prototype is the page's own
//     PublicKeyCredential (and Authenticator*Response), so `instanceof` checks pass; its fields
//     are own data properties that shadow the prototype's native getters.
//   - In a frame, the browser's own functions obey the parent's permissions policy
//     (allow="publickey-credentials-get"). This script reads the same policy, captured before the
//     frame's scripts run, and leaves the request to the browser when it cannot read it (Firefox)
//     or the policy says no.
//   - If the bridge does not answer within a second (it failed to load), the browser's own
//     function takes over rather than leaving the site waiting forever.

(() => {
  const g = /** @type {any} */ (globalThis);
  const MARK = Symbol.for("vyre.passkeys");
  const proto = g.CredentialsContainer && g.CredentialsContainer.prototype;
  const target = proto && typeof proto.create === "function" && typeof proto.get === "function" ? proto
    : g.navigator && g.navigator.credentials;
  if (!target || !g.isSecureContext || target[MARK]) return;
  Object.defineProperty(target, MARK, { value: true });

  // Everything the page could replace later is taken now.
  const original = { create: target.create, get: target.get };
  const post = window.postMessage.bind(window);
  const DOMExc = g.DOMException;
  const toTag = Object.prototype.toString;
  const b64encode = g.btoa.bind(g), b64decode = g.atob.bind(g);
  const where = () => (location.origin && location.origin !== "null" ? location.origin : "*");
  const rnd = new Uint8Array(16);
  g.crypto.getRandomValues(rnd);
  const CHANNEL = `vyre-${Array.from(rnd, b => b.toString(16).padStart(2, "0")).join("")}`;
  const ACK_MS = 1000;
  const framed = window.top !== window;
  const policy = /** @type {any} */ (document).permissionsPolicy || /** @type {any} */ (document).featurePolicy;
  const allows = policy && typeof policy.allowsFeature === "function" ? policy.allowsFeature.bind(policy) : null;
  let seq = 0;
  /** Requests waiting for the bridge, by id. @type {Map<number, (d: any) => void>} */
  const waiting = new Map();

  window.addEventListener("message", e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.vyre !== "passkey-reply" || d.channel !== CHANNEL) return;
    const w = waiting.get(d.id);
    if (w) w(d);
  });

  // ---- bytes <-> base64url -------------------------------------------------------------

  /** A BufferSource as bytes. Tag checks, not instanceof, so buffers from another frame work. @param {any} x */
  function bytes(x) {
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (toTag.call(x) === "[object ArrayBuffer]") return new Uint8Array(x);
    throw new TypeError("expected an ArrayBuffer or a typed array");
  }

  /** @param {any} x */
  function toB64u(x) {
    const b = bytes(x);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return b64encode(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** @param {unknown} s @returns {ArrayBuffer} */
  function fromB64u(s) {
    const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const bin = b64decode(t + "===".slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  /** @param {any} x @returns {any[]} */
  const list = x => (x == null ? [] : Array.from(x));
  const str = (/** @type {any} */ x) => (typeof x === "string" ? x : undefined);
  /** A descriptor list (excludeCredentials / allowCredentials) as JSON. @param {any} x */
  const descriptors = x => list(x).map(c => ({ type: str(c.type) || "public-key", id: toB64u(c.id), transports: list(c.transports).filter(t => typeof t === "string") }));

  /** PublicKeyCredentialCreationOptions as JSON (the WebAuthn Level 3 JSON form). @param {any} pk */
  function creationJSON(pk) {
    const rp = pk.rp || {}, user = pk.user || {}, sel = pk.authenticatorSelection;
    return {
      rp: { id: str(rp.id), name: String(rp.name ?? "") },
      user: { id: toB64u(user.id), name: String(user.name ?? ""), displayName: String(user.displayName ?? "") },
      challenge: toB64u(pk.challenge),
      pubKeyCredParams: list(pk.pubKeyCredParams).map(p => ({ type: String(p.type), alg: Number(p.alg) })),
      timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
      excludeCredentials: descriptors(pk.excludeCredentials),
      authenticatorSelection: sel ? { authenticatorAttachment: str(sel.authenticatorAttachment), residentKey: str(sel.residentKey),
        requireResidentKey: Boolean(sel.requireResidentKey), userVerification: str(sel.userVerification) } : undefined,
      attestation: str(pk.attestation),
    };
  }

  /** PublicKeyCredentialRequestOptions as JSON. @param {any} pk */
  function requestJSON(pk) {
    return {
      challenge: toB64u(pk.challenge),
      rpId: str(pk.rpId),
      timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
      allowCredentials: descriptors(pk.allowCredentials),
      userVerification: str(pk.userVerification),
    };
  }

  // ---- the answer, shaped like the browser's -------------------------------------------

  /** @param {object} o @param {Record<string, any>} data @param {Record<string, Function>} [methods] */
  function own(o, data, methods = {}) {
    for (const [k, v] of Object.entries(data)) Object.defineProperty(o, k, { value: v, enumerable: true });
    for (const [k, v] of Object.entries(methods)) Object.defineProperty(o, k, { value: v, writable: true, configurable: true });
    return o;
  }
  /** @param {any} C */
  const protoOf = C => (typeof C === "function" && C.prototype ? C.prototype : Object.prototype);
  const copy = (/** @type {ArrayBuffer} */ b) => b.slice(0);

  /** @param {"create"|"get"} kind @param {any} r the server's response JSON */
  function credential(kind, r) {
    const j = r.response || {};
    const clientDataJSON = fromB64u(j.clientDataJSON);
    const authenticatorData = fromB64u(j.authenticatorData);
    /** @type {any} */
    let response;
    if (kind === "create") {
      const attestationObject = fromB64u(j.attestationObject);
      const publicKey = typeof j.publicKey === "string" ? fromB64u(j.publicKey) : null;
      const transports = list(j.transports).filter(t => typeof t === "string");
      const alg = typeof j.publicKeyAlgorithm === "number" ? j.publicKeyAlgorithm : -7;
      response = own(Object.create(protoOf(g.AuthenticatorAttestationResponse)), { clientDataJSON, attestationObject, authenticatorData }, {
        getTransports: () => transports.slice(),
        getAuthenticatorData: () => copy(authenticatorData),
        getPublicKey: () => (publicKey ? copy(publicKey) : null),
        getPublicKeyAlgorithm: () => alg,
        toJSON: () => ({ clientDataJSON: j.clientDataJSON, authenticatorData: j.authenticatorData, transports: transports.slice(),
          publicKey: j.publicKey, publicKeyAlgorithm: alg, attestationObject: j.attestationObject }),
      });
    } else {
      const signature = fromB64u(j.signature);
      const userHandle = typeof j.userHandle === "string" && j.userHandle ? fromB64u(j.userHandle) : null;
      response = own(Object.create(protoOf(g.AuthenticatorAssertionResponse)), { clientDataJSON, authenticatorData, signature, userHandle }, {
        toJSON: () => ({ clientDataJSON: j.clientDataJSON, authenticatorData: j.authenticatorData, signature: j.signature,
          ...(userHandle ? { userHandle: j.userHandle } : {}) }),
      });
    }
    const ext = r.clientExtensionResults && typeof r.clientExtensionResults === "object" ? r.clientExtensionResults : {};
    const attachment = typeof r.authenticatorAttachment === "string" ? r.authenticatorAttachment : null;
    return own(Object.create(protoOf(g.PublicKeyCredential)), { id: String(r.id), rawId: fromB64u(r.id), type: "public-key", authenticatorAttachment: attachment, response }, {
      getClientExtensionResults: () => JSON.parse(JSON.stringify(ext)),
      toJSON: () => ({ id: String(r.id), rawId: String(r.id), type: "public-key", authenticatorAttachment: attachment,
        clientExtensionResults: JSON.parse(JSON.stringify(ext)), response: response.toJSON() }),
    });
  }

  // ---- errors ---------------------------------------------------------------------------

  const NAMES = ["SecurityError", "NotAllowedError", "InvalidStateError", "NotSupportedError", "AbortError", "ConstraintError", "UnknownError"];
  /** vyred's { code, message } as the error a browser would throw. @param {any} e */
  function toError(e) {
    const code = e && typeof e.code === "string" ? e.code : "";
    const message = e && typeof e.message === "string" && e.message ? e.message : "The operation either timed out or was not allowed.";
    if (code === "TypeError") return new TypeError(message);
    return new DOMExc(message, NAMES.includes(code) ? code : "NotAllowedError");
  }
  const aborted = () => new DOMExc("The operation was aborted.", "AbortError");

  // ---- the stand-ins ---------------------------------------------------------------------

  /** Whether a request should go to the browser untouched. @param {"create"|"get"} kind @param {any} options */
  function passThrough(kind, options) {
    const pk = options && options.publicKey;
    if (!pk || typeof pk !== "object") return true;
    // Conditional (autofill) and silent requests belong to the browser's own UI.
    if (options.mediation === "conditional" || options.mediation === "silent" || options.mediation === "immediate") return true;
    if (framed) {
      try { if (!allows || !allows(`publickey-credentials-${kind}`)) return true; } catch { return true; }
    }
    if (kind === "create") {
      const sel = pk.authenticatorSelection;
      if (sel && sel.authenticatorAttachment === "cross-platform") return true;
      const algs = list(pk.pubKeyCredParams).map(p => Number(p && p.alg));
      if (algs.length && !algs.includes(-7)) return true;
    }
    return false;
  }

  /** @param {"create"|"get"} kind @param {Function} orig */
  function standIn(kind, orig) {
    /** @this {any} @param {any} options */
    return function (options) {
      const self = this, args = arguments;
      const browser = () => orig.apply(self, args);
      if (passThrough(kind, options)) return browser();
      const signal = options.signal;
      if (signal && signal.aborted) return Promise.reject(aborted());
      let json;
      try { json = kind === "create" ? creationJSON(options.publicKey) : requestJSON(options.publicKey); }
      catch { return browser(); }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        let done = false;
        const end = () => {
          done = true;
          waiting.delete(id);
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          if (done) return;
          end();
          post({ vyre: "passkey", channel: CHANNEL, id, kind: "cancel" }, where());
          reject(aborted());
        };
        // No bridge in this frame: the browser answers instead.
        const timer = setTimeout(() => { if (!done) { end(); resolve(browser()); } }, ACK_MS);
        waiting.set(id, d => {
          if (done) return;
          if (d.ack) { clearTimeout(timer); return; }
          end();
          const r = d.reply || {};
          if (r.fallback) return resolve(browser());
          if (r.error) return reject(toError(r.error));
          if (!r.data || !r.data.response) return reject(toError(null));
          try { resolve(credential(kind, r.data.response)); } catch { reject(toError({ code: "UnknownError", message: "Vyre answered with something that is not a credential" })); }
        });
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        post({ vyre: "passkey", channel: CHANNEL, id, kind, options: json }, where());
      });
    };
  }

  for (const kind of /** @type {const} */ (["create", "get"])) {
    const d = Object.getOwnPropertyDescriptor(target, kind) || { writable: true, enumerable: true, configurable: true };
    Object.defineProperty(target, kind, { ...d, value: standIn(kind, original[kind]) });
  }
})();
