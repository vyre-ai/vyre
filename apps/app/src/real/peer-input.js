// @ts-check
// What a direct call carries as headers (the owner's proof, an approval id) goes over the peer wire inside the call: `proof` (the server's door takes it to the kernel as the owner's presence proof) and `approval`, both removed
// before the tool sees them. Pure.

/** The proof a header carries (base64url JSON of an object), or null. @param {string | undefined} h */
function proofOf(h) {
  if (!h) return null;
  try {
    const b64 = h.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** @param {Record<string, unknown>} input @param {{ kernelProof?: string, yes?: string, approval?: string, presence?: string } | undefined} o @returns {Record<string, unknown>} */
export function peerInput(input, o) {
  if (!o) return input;
  const proof = proofOf(o.kernelProof) ?? proofOf(o.yes);
  return { ...input, ...(proof ? { proof } : {}), ...(typeof o.approval === "string" && o.approval ? { approval: o.approval } : {}) };
}
