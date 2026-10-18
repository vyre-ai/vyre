// A yes for the first-run proof, made by the page itself. A browser-only person has no hardware key and no phone, so the proof's two browsers (an owner approving an ask, a second person joining) could not
// give the yes that a real person gives with a fingerprint or a passkey. This is a SOFTWARE presence key: the page's own person key (the one it already reports when it pairs), signing the same proof body a
// phone signs. It is for the proof build only:
//   1. Only a build made for the proof (EXPO_PUBLIC_VYRE_PROOF_YES=1, which `npx expo export` writes into the bundle as a constant) can use it. In every other build the test below is a constant `true`
//      that returns first, the minifier drops the body, and the marker string is not in the bundle (the app workflow greps a release export for the marker and the flag name; proof-yes.test.js).
//   2. The server takes a software proof only on a development-kind build (kernel/seal/proof.js allowSoftware, never on a release-kind build: kernel/seal/seal.test.js SW-2). A release server refuses the key
//      when it is enrolled and the proof when it is checked, so even this body in a build could not say yes to a release server.
// Real browser-only people get a passkey instead (team/BACKLOG.md, "A real browser yes").

export type ProofYes = {
  signer: { signPresence(card: any): Promise<any> };
  /** The key to enrol on the server with the join (public data only). */
  presenceKey(): Promise<{ key_id: string; spki: string; signer: "software" }>;
};

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

/** The proof build's yes for this person, or null in every other build. @param person the identity id the proof names */
export async function proofYes(person: string): Promise<ProofYes | null> {
  if (process.env.EXPO_PUBLIC_VYRE_PROOF_YES !== "1") return null;
  (globalThis as { __vyreProofYes?: string }).__vyreProofYes = "vyre-proof-yes-enabled";
  const { personKey } = await import("../auth/person.web");
  const { b64, b64url, proofBody, proofBytes } = await import("../../modules/vyre-signer/presence-proof.js");
  const key = await personKey();
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));
  const keyId = `dk_${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", spki))).slice(0, 16)}`;
  return {
    presenceKey: async () => ({ key_id: keyId, spki: b64(spki), signer: "software" as const }),
    signer: {
      signPresence: async (card: any) => {
        const body = proofBody({ ...card, person: card.person || person }, { keyId, now: Date.now(), nonce: b64url(crypto.getRandomValues(new Uint8Array(8))), signer: "software" as never });
        const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, proofBytes(body) as BufferSource));
        return { ...body, signature: b64url(signature) };
      },
    },
  };
}
