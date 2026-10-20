// The person's agreement key, as one interface for every platform. On a computer and in a browser it is the master record's chat key (src/crypto/agree-key.ts), opened with the password: one key for all of the
// person's devices, no Keychain, no Secure Enclave, no page storage. A phone still uses its own native key (the phone's sign-in is not the record's yet). It does one thing: ECDH. Another device wraps a chat key
// (or the identity home) to its public point; this device opens the wrap with `agree` and portable code does the rest (HKDF-SHA256, AES-256-GCM: lib/keywrap.js). There is no prompt per use.
// No react-native import here (Node tests run this file): a phone is told apart by `navigator.product`. Its public point goes in the person's identity entry as `agree` (kernel/identity/chain.js).

const onPhone = () => typeof navigator !== "undefined" && (navigator as { product?: string }).product === "ReactNative";
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/** A peer's public point must be a raw uncompressed P-256 point (65 bytes, 0x04) before any key is asked. */
export function validPoint(epk: string): Uint8Array {
  let p: Uint8Array;
  try { p = unb64u(epk); } catch { throw Object.assign(new Error("That is not a public key."), { code: "bad_epk" }); }
  if (p.length !== 65 || p[0] !== 4) throw Object.assign(new Error("That is not a public key."), { code: "bad_epk" });
  return p;
}

/** The person's chat key from the opened master record (src/crypto/agree-key.ts), or why there is none yet. v0.6.5: no device makes a key of its own, on the desktop or in a browser. */
const webKey = async (): Promise<{ key: import("../crypto/agree-key.ts").AgreeKey; store: string } | { key: null; reason: string }> => {
  try { return await (await import("../crypto/agree-key.ts")).agreeKeyResult(); } catch (e) { return { key: null, reason: String((e as Error)?.message || e) }; }
};

/** This device's agreement public point (raw uncompressed, base64url), made on first use. null where this build has no agreement key (a browser, an app without the native module). */
export async function agreePublic(create = true): Promise<string | null> {
  try {
    if (!onPhone()) {
      void create; // the record's key is made when the record is, never here
      return (await webKey()).key?.point ?? null;
    }
    const m = (await import("../../modules/vyre-signer")) as unknown as { agreePublic?: (create: boolean) => Promise<string> };
    return m.agreePublic ? await m.agreePublic(create) : null;
  } catch { return null; }
}

/** The 32-byte ECDH shared secret (the raw X coordinate) between this device's agreement key and the peer's point `epk`. Rejects when there is no key or `epk` is not a point. */
export async function agree(epk: string): Promise<Uint8Array> {
  validPoint(epk);
  let out: string;
  if (!onPhone()) {
    const k = await webKey();
    if (!k.key) throw Object.assign(new Error(`Vyre can't open your chat key yet: ${k.reason}.`), { code: "no_agree_key" });
    out = b64u(await k.key.ecdh(validPoint(epk)));
  } else {
    const m = (await import("../../modules/vyre-signer")) as unknown as { agree?: (epk: string) => Promise<string> };
    if (!m.agree) throw Object.assign(new Error("This device has no agreement key."), { code: "no_agree_key" });
    out = await m.agree(epk);
  }
  const secret = unb64u(out);
  if (secret.length !== 32) throw Object.assign(new Error("The agreement key gave a bad answer."), { code: "bad_agree" });
  return secret;
}
export { b64u as _b64u };
