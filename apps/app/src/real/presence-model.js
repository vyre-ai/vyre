// Presence by a passkey in a browser (ADR 0004, 0032), as pure data: what the box's challenge holds and
// what the proof header looks like. No DOM, no network. The Deck's own copy is deck/js/api.js presenceProof.

const b64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const b64url = (buf) => b64(new Uint8Array(buf));
export const unb64url = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};

/** Whether a box refusal says a passkey would answer it. */
export const wantsPasskey = (error) => Boolean(error) && error.code === "presence_required" && Array.isArray(error.methods) && error.methods.includes("passkey");

/** The options navigator.credentials.get takes, from the box's challenge answer `{ challenge, webauthn }`, or null when it holds none. */
export function getOptions(answer) {
  const w = answer && answer.data && answer.data.webauthn;
  if (!w || typeof w.challenge !== "string" || typeof w.rpId !== "string") return null;
  return {
    challenge: unb64url(w.challenge), rpId: w.rpId, userVerification: w.userVerification || "required", timeout: w.timeout,
    allowCredentials: (w.allowCredentials || []).map((c) => ({ type: "public-key", id: unb64url(c.id) })),
  };
}

/** The x-vyre-presence value for a passkey assertion answering challenge `id`. */
export function passkeyHeader(id, cred) {
  const r = cred.response;
  return `passkey id=${id} cred=${b64url(cred.rawId)} ad=${b64url(r.authenticatorData)} cd=${b64url(r.clientDataJSON)} sig=${b64url(r.signature)}`;
}
