import { base32 } from "../../lib/bytes.js";
// @ts-check
// otpmigration: Google Authenticator's "Transfer accounts" QR codes, read into otpauth:// URIs.
//
// The export is one or more QR codes, each `otpauth-migration://offline?data=<base64>`, where the
// data is a protobuf MigrationPayload: repeated OtpParameters (secret bytes, name, issuer,
// algorithm, digits, type, counter), then version, batch_size, batch_index and batch_id. A large
// export is split across several codes that share a batch_id, so the parts are gathered and the
// import waits until every index from 0 to batch_size - 1 is here (ADR 0028).
//
// Reading the QR image is the client's job (the phone's camera, the Deck's BarcodeDetector, the
// Mac's Vision helper): vyred only ever sees the URI text. Pure; no disk, no network. Errors and
// `skipped` name an account by its issuer and label, never by its secret.

/**
 * @typedef {{ issuer: string, account: string, uri: string }} Account
 * @typedef {{ batch: { id: number, index: number, size: number }, accounts: Account[], skipped: string[] }} Part
 */

const ALGORITHM = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512", 4: "MD5" };
const DIGITS = { 0: 6, 1: 6, 2: 8 };
const TYPE = { 0: "totp", 1: "hotp", 2: "totp" };

/** A protobuf reader for the subset this payload uses: varints and length-delimited fields. */
function* fields(buf) {
  let i = 0;
  const varint = () => {
    let v = 0n, shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("the code's data ends early");
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
      if (shift > 63n) throw new Error("the code's data has a number that is too long");
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) yield { field, int: varint() };
    else if (wire === 2) {
      const n = Number(varint());
      if (n < 0 || i + n > buf.length) throw new Error("the code's data ends early");
      yield { field, bytes: buf.subarray(i, i + n) };
      i += n;
    } else if (wire === 5) { i += 4; }
    else if (wire === 1) { i += 8; }
    else throw new Error("the code's data is not an authenticator export");
  }
}

/** RFC 4648 base32, no padding, for otpauth's `secret`. @param {Uint8Array} bytes */
export const base32Encode = bytes => base32(bytes).toUpperCase();

const text = b => Buffer.from(b).toString("utf8").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);

/**
 * One `otpauth-migration://offline?data=...` URI to its accounts and batch position.
 * @param {string} uri
 * @returns {Part}
 */
export function readMigration(uri) {
  let url;
  try { url = new URL(String(uri).trim()); } catch { throw new Error("not an otpauth-migration:// address"); }
  if (url.protocol !== "otpauth-migration:" || url.hostname !== "offline") throw new Error("not a Google Authenticator export (otpauth-migration://offline)");
  const data = url.searchParams.get("data");
  if (!data) throw new Error("the export has no data");
  // URLSearchParams turns "+" into a space; the payload is standard base64.
  const buf = Buffer.from(data.replace(/ /g, "+"), "base64");
  if (!buf.length) throw new Error("the export has no data");
  /** @type {Account[]} */
  const accounts = [];
  /** @type {string[]} */
  const skipped = [];
  const batch = { id: 0, index: 0, size: 1 };
  for (const f of fields(buf)) {
    if (f.field === 1 && f.bytes) {
      const p = { secret: new Uint8Array(), name: "", issuer: "", algorithm: 0, digits: 0, type: 0 };
      for (const g of fields(f.bytes)) {
        if (g.field === 1 && g.bytes) p.secret = g.bytes;
        else if (g.field === 2 && g.bytes) p.name = text(g.bytes);
        else if (g.field === 3 && g.bytes) p.issuer = text(g.bytes);
        else if (g.field === 4 && g.int !== undefined) p.algorithm = Number(g.int);
        else if (g.field === 5 && g.int !== undefined) p.digits = Number(g.int);
        else if (g.field === 6 && g.int !== undefined) p.type = Number(g.int);
      }
      // A label is often "Issuer:account"; the issuer field wins when both are there.
      let account = p.name, issuer = p.issuer;
      const colon = account.indexOf(":");
      if (colon > 0) { if (!issuer) issuer = account.slice(0, colon).trim(); account = account.slice(colon + 1).trim(); }
      const who = [issuer, account].filter(Boolean).join(" ") || "an account";
      if (TYPE[/** @type {0|1|2} */ (p.type)] === "hotp") { skipped.push(`${who}: counter-based (HOTP) codes are not supported`); continue; }
      const algorithm = ALGORITHM[/** @type {0|1|2|3|4} */ (p.algorithm)];
      if (!algorithm || algorithm === "MD5") { skipped.push(`${who}: MD5 codes are not supported`); continue; }
      if (!p.secret.length) { skipped.push(`${who}: no secret`); continue; }
      const label = encodeURIComponent(issuer ? `${issuer}:${account}` : account || "account");
      const q = new URLSearchParams({ secret: base32Encode(p.secret), ...(issuer ? { issuer } : {}), algorithm,
        digits: String(DIGITS[/** @type {0|1|2} */ (p.digits)] ?? 6), period: "30" });
      accounts.push({ issuer, account, uri: `otpauth://totp/${label}?${q}` });
    } else if (f.field === 3 && f.int !== undefined) batch.size = Math.max(1, Number(f.int));
    else if (f.field === 4 && f.int !== undefined) batch.index = Number(f.int);
    else if (f.field === 5 && f.int !== undefined) batch.id = Number(BigInt.asIntN(32, f.int));
  }
  return { batch, accounts, skipped };
}

/**
 * Many scanned codes (migration parts and plain otpauth:// URIs, in any order, repeats allowed)
 * to the accounts they hold, and any batch still missing parts, as 1-based numbers to scan.
 * @param {string[]} uris
 * @returns {{ accounts: Account[], skipped: string[], missing: { batch: number, parts: number[], of: number }[] }}
 */
export function gather(uris) {
  /** @type {Map<number, { size: number, parts: Map<number, Part> }>} */
  const batches = new Map();
  /** @type {Account[]} */
  const accounts = [];
  /** @type {string[]} */
  const skipped = [];
  for (const [n, raw] of uris.entries()) {
    const uri = String(raw || "").trim();
    if (/^otpauth:\/\/totp\//i.test(uri)) {
      let u;
      try { u = new URL(uri); } catch { skipped.push(`code ${n + 1}: not a readable otpauth address`); continue; }
      const labelText = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      const colon = labelText.indexOf(":");
      const issuer = u.searchParams.get("issuer") || (colon > 0 ? labelText.slice(0, colon) : "");
      accounts.push({ issuer: issuer.trim().slice(0, 200), account: (colon > 0 ? labelText.slice(colon + 1) : labelText).trim().slice(0, 200), uri });
      continue;
    }
    if (/^otpauth:\/\/hotp\//i.test(uri)) { skipped.push(`code ${n + 1}: counter-based (HOTP) codes are not supported`); continue; }
    let part;
    try { part = readMigration(uri); } catch (e) { skipped.push(`code ${n + 1}: ${/** @type {Error} */ (e).message}`); continue; }
    const b = batches.get(part.batch.id) ?? { size: part.batch.size, parts: new Map() };
    b.parts.set(part.batch.index, part);
    batches.set(part.batch.id, b);
  }
  const missing = [];
  for (const [id, b] of batches) {
    const want = [...Array(b.size).keys()].filter(i => !b.parts.has(i));
    if (want.length) { missing.push({ batch: id, parts: want.map(i => i + 1), of: b.size }); continue; }
    for (const i of [...b.parts.keys()].sort((x, y) => x - y)) {
      const p = /** @type {Part} */ (b.parts.get(i));
      accounts.push(...p.accounts);
      skipped.push(...p.skipped);
    }
  }
  return { accounts, skipped, missing };
}
