// @ts-check
// vyre-core release handling (ADR 0040 section 5): verify a signed manifest, check the tarball
// hash, enforce the anti-rollback version floor, list a tarball's entries without extracting,
// refuse it whole if any entry is dangerous, then extract with normalized modes and one atomic
// rename. Pure Node, no dependencies. Every check fails closed with a plain-reason Error.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

// PLACEHOLDER. This is a throwaway public key, generated only so the code has something to
// compile against. The real release key is generated once, offline, by the person who signs
// releases, and replaces this constant at release time. It is never generated in CI and its
// private half never touches a machine vyre-core runs on. Base64 of the SPKI DER encoding.
export const RELEASE_KEY = "MCowBQYDK2VwAyEAfFTFccqQNhkHQ3II6EniEoRfWgDDDjQn+GKEJZQIHoE=";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** @param {string | Buffer | Uint8Array} v */
const toBuf = (v) => (typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v));

/** @param {string} key base64 SPKI DER */
function publicKey(key) {
  try {
    return crypto.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("release key is not a valid Ed25519 public key");
  }
}

/**
 * @param {string | Buffer | Uint8Array} manifestBytes
 * @param {string | Buffer | Uint8Array} sigBytes base64 detached signature over the exact manifest bytes
 * @param {{ key?: string }} [opts]
 * @returns {{ version: string, tarball: string, sha256: string, channel?: string }}
 */
export function verifyManifest(manifestBytes, sigBytes, { key = RELEASE_KEY } = {}) {
  if (manifestBytes == null || sigBytes == null) throw new Error("manifest or signature is missing");
  const m = toBuf(manifestBytes);
  const sigText = toBuf(sigBytes).toString("utf8").trim();
  if (!sigText) throw new Error("signature is empty");
  if (!B64.test(sigText)) throw new Error("signature is not base64");
  const sig = Buffer.from(sigText, "base64");
  if (sig.length !== 64) throw new Error("signature is not 64 bytes");
  let ok = false;
  try {
    ok = crypto.verify(null, m, publicKey(key), sig);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("release key")) throw e;
    ok = false;
  }
  if (!ok) throw new Error("manifest signature does not verify");
  let j;
  try {
    j = JSON.parse(m.toString("utf8"));
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("manifest is not a JSON object");
  if (typeof j.version !== "string" || !SEMVER.test(j.version)) throw new Error("manifest version is not semver");
  if (typeof j.tarball !== "string" || !j.tarball) throw new Error("manifest names no tarball");
  if (typeof j.sha256 !== "string" || !HEX64.test(j.sha256)) throw new Error("manifest sha256 is not 64 hex characters");
  if (j.channel !== undefined && typeof j.channel !== "string") throw new Error("manifest channel is not a string");
  return j;
}

/**
 * @param {string} file
 * @param {{ sha256: string }} manifest
 */
export function checkTarball(file, manifest) {
  const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (got !== String(manifest.sha256).toLowerCase()) throw new Error("tarball sha256 does not match the manifest");
  return true;
}

/** @param {string} v */
function parseVersion(v) {
  const m = typeof v === "string" ? SEMVER.exec(v) : null;
  if (!m) throw new Error(`not a semver version: ${String(v)}`);
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order: negative if a < b, 0 if equal, positive if a > b. A prerelease sorts below its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Anti-rollback: refuse a version at or below the floor. A missing floor allows anything.
 * @param {string} version
 * @param {string | null | undefined} floor
 */
export function checkFloor(version, floor) {
  parseVersion(version);
  if (floor === null || floor === undefined || floor === "") return true;
  if (compareVersions(version, floor) <= 0) throw new Error(`version ${version} is at or below the floor ${floor}`);
  return true;
}

/** @param {string} p @returns {string | null} null when no floor file exists; a malformed one throws. */
export function readFloor(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  const v = raw.trim();
  parseVersion(v);
  return v;
}

/**
 * Raise the floor to `version`, atomically (tmp then rename). Never lowers it.
 * @param {string} p
 * @param {string} version
 * @returns {string} the floor now in force
 */
export function raiseFloor(p, version) {
  parseVersion(version);
  const cur = readFloor(p);
  if (cur !== null && compareVersions(version, cur) <= 0) return cur;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, `${version}\n`, { mode: 0o644 });
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return version;
}

/**
 * @typedef {{ path: string, type: "file" | "dir" | "symlink" | "hardlink" | "char" | "block" | "fifo" | "other", mode: number, linkname: string, size: number }} TarEntry
 */

/** @param {Buffer} b */
function cstr(b) {
  const i = b.indexOf(0);
  return b.toString("utf8", 0, i < 0 ? b.length : i);
}

/** @param {Buffer} b */
function num(b) {
  if (b[0] & 0x80) {
    // base-256 (GNU), big-endian two's complement without the marker bit
    let v = b[0] & 0x7f;
    for (let i = 1; i < b.length; i++) v = v * 256 + b[i];
    return v;
  }
  const s = cstr(b).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error("tarball has a malformed header field");
  return parseInt(s, 8);
}

/** @param {Buffer} data pax extended header records @returns {Record<string, string>} */
function paxRecords(data) {
  /** @type {Record<string, string>} */
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.toString("utf8", i, sp), 10);
    if (!Number.isFinite(len) || len <= sp - i + 1 || i + len > data.length) throw new Error("tarball has a malformed pax header");
    const rec = data.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * List a gzipped tarball's entries without extracting, by parsing the ustar headers directly.
 * Understands pax (x, g) and GNU long name/link (L, K) records so a long path cannot hide.
 * @param {string} file
 * @returns {TarEntry[]}
 */
export function listTar(file) {
  let buf;
  try {
    buf = zlib.gunzipSync(fs.readFileSync(file));
  } catch {
    throw new Error("tarball is not a readable gzip file");
  }
  /** @type {TarEntry[]} */
  const entries = [];
  let off = 0;
  /** @type {string | undefined} */ let longName;
  /** @type {string | undefined} */ let longLink;
  /** @type {Record<string, string>} */ let pax = {};
  /** @type {Record<string, string>} */ let globalPax = {};
  let ended = false;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) {
      ended = true;
      break;
    }
    // checksum: sum of all header bytes with the checksum field read as spaces
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== num(h.subarray(148, 156))) throw new Error("tarball header checksum is wrong");
    const flag = String.fromCharCode(h[156] || 0x30);
    const size = num(h.subarray(124, 136));
    const dataStart = off + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataStart + size > buf.length) throw new Error("tarball is truncated");
    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      const data = buf.subarray(dataStart, dataStart + size);
      if (flag === "x") pax = paxRecords(data);
      else if (flag === "g") globalPax = { ...globalPax, ...paxRecords(data) };
      else if (flag === "L") longName = cstr(data);
      else longLink = cstr(data);
      off = next;
      continue;
    }
    let name = cstr(h.subarray(0, 100));
    if (cstr(h.subarray(257, 262)) === "ustar") {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    const merged = { ...globalPax, ...pax };
    name = merged.path ?? longName ?? name;
    const linkname = merged.linkpath ?? longLink ?? cstr(h.subarray(157, 257));
    /** @type {TarEntry["type"]} */
    let type;
    if (flag === "0" || flag === "7") type = "file";
    else if (flag === "5") type = "dir";
    else if (flag === "2") type = "symlink";
    else if (flag === "1") type = "hardlink";
    else if (flag === "3") type = "char";
    else if (flag === "4") type = "block";
    else if (flag === "6") type = "fifo";
    else type = "other";
    entries.push({ path: name, type, mode: num(h.subarray(100, 108)), linkname, size });
    longName = longLink = undefined;
    pax = {};
    off = next;
  }
  if (!ended && off < buf.length) throw new Error("tarball is truncated");
  return entries;
}

/**
 * Refuse the WHOLE tarball if any entry is unsafe.
 * @param {TarEntry[]} entries
 */
export function checkEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("tarball has no entries");
  for (const e of entries) {
    const p = e.path;
    if (!p || p.includes("\0")) throw new Error(`tarball entry has an empty or invalid path: ${JSON.stringify(p)}`);
    if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) throw new Error(`tarball entry has an absolute path: ${p}`);
    if (p.split(/[\\/]/).includes("..")) throw new Error(`tarball entry has a .. component: ${p}`);
    if (e.type === "symlink") throw new Error(`tarball entry is a symlink: ${p}`);
    if (e.type === "hardlink") throw new Error(`tarball entry is a hardlink: ${p}`);
    if (e.type === "char" || e.type === "block") throw new Error(`tarball entry is a device file: ${p}`);
    if (e.type === "fifo") throw new Error(`tarball entry is a fifo: ${p}`);
    if (e.type === "other") throw new Error(`tarball entry has an unsupported type: ${p}`);
    if (e.mode & 0o6000) throw new Error(`tarball entry has setuid or setgid bits: ${p}`);
  }
  return true;
}

/** @param {string} dir */
function normalize(dir) {
  fs.chmodSync(dir, 0o755);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) normalize(p);
    else if (st.isFile()) fs.chmodSync(p, st.mode & 0o111 ? 0o755 : 0o644);
    else throw new Error(`extracted a non-regular file: ${name}`);
  }
}

/**
 * Extract a vetted tarball into a fresh directory that must not exist yet. Extracts beside
 * `destDir`, normalizes modes, then renames into place in one step.
 * @param {string} file
 * @param {string} destDir
 * @param {{ tar?: string }} [opts]
 */
export function extract(file, destDir, { tar = "tar" } = {}) {
  checkEntries(listTar(file));
  const dest = path.resolve(destDir);
  if (fs.existsSync(dest)) throw new Error(`destination already exists: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stage = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    execFileSync(tar, ["-xzf", file, "-C", stage, "--no-same-owner"], { stdio: ["ignore", "ignore", "pipe"] });
    normalize(stage);
    fs.renameSync(stage, dest);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return dest;
}
