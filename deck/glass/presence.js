// @ts-check
// presence: proving a person is here with a passkey before a human-only call (ADR 0004).
//
// glass.take and glass.release pause an agent, so the box asks for a passkey: Touch ID on a Mac,
// Face ID on a phone. The dance, per the security workstream:
//
//   1. POST /v1/presence/challenge { tool, input, method: "passkey" } gives WebAuthn options;
//   2. navigator.credentials.get asks the person (user verification required);
//   3. the tool is called with x-vyre-presence: passkey id= cred= ad= cd= sig=.
//
// The proof is bound to the tool and to the exact input, hashed as canonical JSON, so the input
// sent in step 3 is the same object asked about in step 1. Like upload(), this is a byte
// exchange with vyred outside call(); it belongs in js/api.js and lives here until it moves.

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));

/** Can this browser make a passkey proof at all? */
export const canProve = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/**
 * Call a presence tool with a passkey proof. Resolves to { data } or { error }, the shape
 * attempt() gives, so the view handles both paths the same way.
 * @param {string} tool @param {Record<string, any>} input
 */
export async function proveAndCall(tool, input) {
  const fail = (code, message) => ({ error: { code, message } });
  if (!canProve()) return fail("no_passkey", "This browser cannot use a passkey. Open Glass in Safari or Chrome over your tailnet.");
  let ch;
  try {
    const res = await fetch("/v1/presence/challenge", { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" },
      body: JSON.stringify({ tool, input, method: "passkey" }) });
    ch = await res.json().catch(() => null);
  } catch { return fail("offline", "The box did not answer."); }
  if (!ch || ch.error || !ch.data?.webauthn) return fail(ch?.error?.code || "denied", ch?.error?.message || "The box did not offer a passkey challenge.");
  const w = ch.data.webauthn;
  let cred;
  try {
    cred = /** @type {any} */ (await navigator.credentials.get({ publicKey: {
      challenge: unb64url(w.challenge), rpId: w.rpId, userVerification: w.userVerification || "required", timeout: w.timeout,
      allowCredentials: (w.allowCredentials || []).map(c => ({ type: "public-key", id: unb64url(c.id) })),
    } }));
  } catch (e) {
    return fail("cancelled", /** @type {Error} */ (e).name === "NotAllowedError" ? "The passkey was cancelled or timed out." : `The passkey did not work: ${/** @type {Error} */ (e).message}`);
  }
  if (!cred) return fail("cancelled", "The passkey was cancelled.");
  const r = cred.response;
  const proof = `passkey id=${ch.data.challenge} cred=${b64url(cred.rawId)} ad=${b64url(r.authenticatorData)} cd=${b64url(r.clientDataJSON)} sig=${b64url(r.signature)}`;
  try {
    const res = await fetch("/v1/tools/" + encodeURIComponent(tool), { method: "POST",
      headers: { "content-type": "application/json", "x-vyre-caller": "deck", "x-vyre-presence": proof }, body: JSON.stringify(input) });
    const b = await res.json().catch(() => null);
    if (b && "data" in b && !b.error) return { data: b.data };
    return fail(b?.error?.code || `http_${res.status}`, b?.error?.message || res.statusText);
  } catch { return fail("offline", "The box did not answer."); }
}

export const _test = { b64url, unb64url };
