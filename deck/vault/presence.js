// @ts-check
// The Deck's presence client (docs/adr/0004-presence.md). Self-contained so the rest of the Deck
// can lift it: no DOM, no view state. The page decides how to ask the person (a sheet), and this
// file does the protocol:
//
//   const r = await withPresence("vault.session.open", { surface: "deck" }, { confirm });
//
// 1. The call goes out as usual. If vyred answers `presence_required`, `confirm` is asked, with
//    the tool, the input and the methods vyred offers. It resolves true when the person chose to
//    prove it (a click on "Use passkey"), false when they did not.
// 2. POST /v1/presence/challenge { tool, input, method: "passkey" } returns WebAuthn options.
// 3. navigator.credentials.get with user verification required. The platform shows its own
//    Touch ID or device PIN prompt, which a model cannot answer.
// 4. The same call again, with `x-vyre-presence: passkey id= cred= ad= cd= sig=`. A proof is for
//    one tool and one exact input, used once, so the retry sends the identical input.
//
// Returns { data } or { error: { code, message, methods? } }, never throws.

/** @typedef {{ code: string, message: string, methods?: string[] }} PresenceError */
/** @typedef {{ tool: string, input: any, methods: string[], message: string }} Ask */

const CALLER = "deck";

/**
 * POST /v1/tools/<name>. Optionally with a proof header.
 * @param {string} name @param {any} input @param {string} [proof]
 * @returns {Promise<{ data?: any, error?: PresenceError }>}
 */
export async function callTool(name, input = {}, proof) {
  try {
    const res = await fetch("/v1/tools/" + encodeURIComponent(name), {
      method: "POST",
      headers: { "content-type": "application/json", "x-vyre-caller": CALLER, ...(proof ? { "x-vyre-presence": proof } : {}) },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => null);
    if (body && "data" in body && !body.error) return { data: body.data };
    return { error: { code: body?.error?.code || "http_" + res.status, message: body?.error?.message || res.statusText, ...(body?.error?.methods ? { methods: body.error.methods } : {}) } };
  } catch {
    return { error: { code: "offline", message: "vyred did not answer" } };
  }
}

/** Can this browser make a passkey assertion at all? (A secure context with WebAuthn.) */
export const passkeysHere = () => typeof window !== "undefined" && Boolean(window.isSecureContext && navigator.credentials && window.PublicKeyCredential);

const toB64url = (/** @type {ArrayBuffer} */ buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (/** @type {string} */ s) => {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

/**
 * Get a passkey proof for exactly this call. Resolves to the header value.
 * @param {string} tool @param {any} input
 * @returns {Promise<string>}
 */
export async function passkeyProof(tool, input) {
  if (!passkeysHere()) throw Object.assign(new Error("This browser cannot use a passkey here. Open the Deck over https or on localhost."), { code: "no_passkey" });
  let c;
  try {
    const res = await fetch("/v1/presence/challenge", { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": CALLER },
      body: JSON.stringify({ tool, input, method: "passkey" }) });
    c = await res.json();
  } catch { throw Object.assign(new Error("vyred did not answer"), { code: "offline" }); }
  if (!c || c.error || !c.data?.webauthn) throw Object.assign(new Error(c?.error?.message || "vyred gave no passkey challenge"), { code: c?.error?.code || "no_challenge" });
  const w = c.data.webauthn;
  const cred = /** @type {PublicKeyCredential | null} */ (await navigator.credentials.get({ publicKey: {
    challenge: fromB64url(w.challenge), rpId: w.rpId, userVerification: "required", timeout: w.timeout || 60_000,
    allowCredentials: (w.allowCredentials || []).map(a => ({ type: "public-key", id: fromB64url(a.id) })),
  } }));
  if (!cred) throw Object.assign(new Error("No passkey was used."), { code: "cancelled" });
  const r = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
  return `passkey id=${c.data.challenge} cred=${toB64url(cred.rawId)} ad=${toB64url(r.authenticatorData)} cd=${toB64url(r.clientDataJSON)} sig=${toB64url(r.signature)}`;
}

/**
 * Call a tool, proving presence if vyred asks for it.
 * @param {string} name @param {any} input
 * @param {{ confirm: (ask: Ask) => Promise<boolean>, proof?: (tool: string, input: any) => Promise<string> }} opts
 * @returns {Promise<{ data?: any, error?: PresenceError }>}
 */
export async function withPresence(name, input, { confirm, proof = passkeyProof }) {
  const first = await callTool(name, input);
  if (first.error?.code !== "presence_required") return first;
  const ok = await confirm({ tool: name, input, methods: first.error.methods || [], message: first.error.message });
  if (!ok) return { error: { code: "presence_refused", message: "Not confirmed. Nothing was done." } };
  let header;
  try { header = await proof(name, input); }
  catch (e) {
    const err = /** @type {any} */ (e);
    // NotAllowedError is the browser's word for a cancelled or timed-out prompt.
    const code = err?.name === "NotAllowedError" ? "cancelled" : err?.code || "presence_failed";
    return { error: { code, message: code === "cancelled" ? "The passkey prompt was cancelled. Nothing was done." : String(err?.message || err) } };
  }
  return callTool(name, input, header);
}
