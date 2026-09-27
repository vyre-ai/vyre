// @ts-check
// manifest: the signed list of a web app release's files (ADR 0026 section 10, ADR 0027 section 4).
// The same code runs in the loader (a browser) and in release.js (Node), on WebCrypto alone.
//
// A manifest is canonical JSON, keys sorted, UTF-8:
//   { v: 1, release: "0.4.2", created: <ms>, entry: ["app.js", "app.css"],
//     files: { "app.js": "sha384-<base64>", ... } }
// Paths are relative to the release's folder. The file hashes are Subresource Integrity values,
// so the loader puts them straight into `integrity`. The manifest's own sha256 (hex) is what the
// box's core/relay/releases.json lists, and its first 40 characters name the folder: /v/<sha>/.
// The signature is Ed25519 over the manifest's exact bytes, base64url, in release-manifest.sig.

import { utf8, fromUtf8, hex, base64url, fromBase64url } from "../client/bytes.js";

export const MANIFEST = "release-manifest.json";
export const SIGNATURE = "release-manifest.sig";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const PATH = /^(?!\/)(?!.*\.\.)[\w./@-]{1,200}$/;

const subtle = () => globalThis.crypto.subtle;

/** JSON with sorted keys, so the same manifest always has the same bytes. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** @param {Uint8Array} bytes */
export const sha256Hex = async bytes => hex(new Uint8Array(await subtle().digest("SHA-256", bytes)));

/** The SRI value for a file. @param {Uint8Array} bytes */
export async function sri(bytes) {
  const d = new Uint8Array(await subtle().digest("SHA-384", bytes));
  let s = "";
  for (const b of d) s += String.fromCharCode(b);
  return `sha384-${btoa(s)}`;
}

/** The folder a manifest names: the first 40 hex characters of its sha256. */
export const folderOf = manifestHex => manifestHex.slice(0, 40);

/** Whether a is a newer semver release than b. */
export function newer(a, b) {
  const x = (SEMVER.exec(a) || []).slice(1).map(Number), y = (SEMVER.exec(b) || []).slice(1).map(Number);
  if (x.length !== 3) return false;
  if (y.length !== 3) return true;
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
}

/** Check a manifest's shape. Throws with the reason. */
export function checkShape(m) {
  if (!m || m.v !== 1 || !SEMVER.test(m.release)) throw new Error("not a release manifest");
  if (!m.files || typeof m.files !== "object") throw new Error("the manifest lists no files");
  for (const [p, h] of Object.entries(m.files)) {
    if (!PATH.test(p) || !/^sha384-[A-Za-z0-9+/]{64}$/.test(String(h))) throw new Error(`bad manifest entry ${p}`);
  }
  for (const e of Array.isArray(m.entry) ? m.entry : []) if (!(e in m.files)) throw new Error(`entry ${e} is not in the manifest`);
  return m;
}

/** @param {Uint8Array} raw 32-byte Ed25519 public key */
const importPub = raw => subtle().importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);

/**
 * Verify a manifest's signature and shape. Resolves with { manifest, sha256 } or throws.
 * @param {Uint8Array} bytes the manifest file @param {string} sig base64url @param {Uint8Array} pub
 */
export async function verifyManifest(bytes, sig, pub) {
  let s;
  try { s = fromBase64url(String(sig).trim()); } catch { throw new Error("the release signature is not base64url"); }
  const ok = s.length === 64 && await subtle().verify({ name: "Ed25519" }, await importPub(pub), s, bytes);
  if (!ok) throw new Error("the release signature does not verify");
  let m;
  try { m = JSON.parse(fromUtf8(bytes)); } catch { throw new Error("the manifest is not JSON"); }
  return { manifest: checkShape(m), sha256: await sha256Hex(bytes) };
}

/** Build a manifest's bytes from its files. @param {{ release: string, created?: number, entry?: string[], files: Record<string, Uint8Array> }} o */
export async function buildManifest(o) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const [p, b] of Object.entries(o.files)) files[p] = await sri(b);
  const m = checkShape({ v: 1, release: o.release, created: o.created ?? Date.now(), entry: o.entry || [], files });
  return utf8(canonical(m));
}

/** Sign manifest bytes with a CryptoKey (Ed25519 private). @returns {Promise<string>} base64url */
export const signManifest = async (bytes, key) => base64url(new Uint8Array(await subtle().sign({ name: "Ed25519" }, key, bytes)));
