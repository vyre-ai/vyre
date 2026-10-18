// @ts-check
// How vyred reads a request's body (kept out of core/daemon/index.js, which has a size cap): raw text, capped bytes for a sync chunk, and JSON.

export async function rawBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw new Error("request too large"); }
  return raw;
}

/** A request's body as bytes, capped, for sync.upload's chunks (never JSON: octet-stream only). */
export async function rawBinary(req, max) {
  const parts = [];
  let got = 0;
  for await (const chunk of req) {
    got += chunk.length;
    if (got > max) throw Object.assign(new Error(`a chunk is at most ${max} bytes`), { code: "bad_input" });
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export async function body(req) {
  // The router may have read it already, to check a person session's signature over it.
  const raw = req.vyreRaw !== undefined ? req.vyreRaw : await rawBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("request body is not JSON"); }
}
