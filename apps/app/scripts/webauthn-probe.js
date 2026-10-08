// A probe for the Windows panel, run in the page by the runner proof (scripts/win-setup-proof.mjs `page.evaluate`): is WebAuthn exposed here, on which origin, and would the shell take a passkey on it?
// Self-contained (no imports): the whole file is one async function expression, so `page.evaluate(fs.readFileSync(thisFile, "utf8"))` returns its result. It makes no credential and asks for no prompt.
(async () => {
  const out = { origin: location.origin, secure: window.isSecureContext, ua: navigator.userAgent, credentials: typeof navigator.credentials, publicKeyCredential: typeof PublicKeyCredential };
  try { out.platformAuthenticator = typeof PublicKeyCredential !== "undefined" && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : "not exposed"; } catch (e) { out.platformAuthenticator = `error: ${e && e.name}`; }
  // the shell's rule (apps/app/src/identity/passkey.js passkeyRp, shell): the bundled page or the pinned server, https only
  const m = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vyre\.run|vyreapp\.localhost)$/.exec(location.origin);
  out.shellRp = m ? m[1] : null;
  // the secure-context fact the rp rests on: a host WebAuthn takes as a relying party id for this origin is the host itself or a registrable suffix of it
  out.rpIsHost = out.shellRp === location.hostname;
  return JSON.stringify(out);
})()
