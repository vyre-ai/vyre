// @ts-check
// releases: what `vyre update` reads from a GitHub Release, kept apart from the command so every
// rule can be tested without a network (ADR 0033 section 4).
//
// A release is a tag vX.Y.Z (stable) or vX.Y.Z-beta.N (a GitHub prerelease, beta). `stable` is
// the newest release that is not a prerelease; `beta` is the newest of either. Newest means the
// highest version, not the latest date: a fix to an older line never counts as an update.
// Every file of a release is checked against its SHA256SUMS before anything uses it.

import crypto from "node:crypto";
import fs from "node:fs";

/** @typedef {{ major: number, minor: number, patch: number, pre: string[] }} Version */
/** @typedef {{ version: string, tag: string, prerelease: boolean, notes: string, date: string | null, assets: Record<string, string> }} Release */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

/** "0.2.0-beta.3" (a leading v is fine) as its parts, or null when it is not a version. @returns {Version | null} */
export function parseVersion(v) {
  const m = SEMVER.exec(String(v || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order: -1, 0 or 1. A prerelease sorts before its release; beta.10 after beta.9. */
export function compare(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const k of /** @type {const} */ (["major", "minor", "patch"])) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    // Numbers compare as numbers, and a number sorts before a word.
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether a version is a prerelease (it has a -beta.N part). */
export const isPre = v => Boolean(parseVersion(v)?.pre.length);

/**
 * The Releases API's list as Releases, newest first. Drafts and tags that are not versions are
 * left out. A release is a prerelease if GitHub says so or its tag has a -part.
 * @param {any} list
 * @returns {Release[]}
 */
export function releases(list) {
  if (!Array.isArray(list)) throw new Error("the releases answer is not a list");
  /** @type {Release[]} */
  const out = [];
  for (const r of list) {
    if (!r || r.draft || typeof r.tag_name !== "string" || !parseVersion(r.tag_name)) continue;
    const version = r.tag_name.replace(/^v/, "");
    /** @type {Record<string, string>} */
    const assets = {};
    for (const a of Array.isArray(r.assets) ? r.assets : []) {
      if (a && typeof a.name === "string" && typeof a.browser_download_url === "string") assets[a.name] = a.browser_download_url;
    }
    out.push({ version, tag: r.tag_name, prerelease: Boolean(r.prerelease) || isPre(version), notes: String(r.body || "").trim(), date: r.published_at || null, assets });
  }
  return out.sort((a, b) => compare(b.version, a.version));
}

/** Whether a release belongs to a channel: stable takes no prereleases, beta takes both. */
const inChannel = (/** @type {Release} */ r, /** @type {string} */ channel) => channel === "beta" || !r.prerelease;

/** The newest release on a channel, or null. @param {Release[]} list @param {"stable" | "beta" | string} channel */
export function pick(list, channel) {
  return [...list].sort((a, b) => compare(b.version, a.version)).find(r => inChannel(r, channel)) || null;
}

/**
 * The notes between the running version (left out) and the target (kept), newest first. On
 * stable, betas in between are left out: their notes are folded into the stable one.
 * @param {Release[]} list @param {string} from @param {string} to @param {string} channel
 */
export function changelog(list, from, to, channel) {
  return list.filter(r => compare(r.version, from) > 0 && compare(r.version, to) <= 0 && (inChannel(r, channel) || r.version === to))
    .sort((a, b) => compare(b.version, a.version))
    .map(r => ({ version: r.version, notes: r.notes }));
}

/**
 * Whether `current` may update straight to a release whose release.json says `min_from`. When it
 * may not, `step` is the release to go through first: the lowest one at or above min_from on the
 * channel, or null when there is none below the target (then only a reinstall by hand helps).
 * @param {Release[]} list @param {string} current @param {string | undefined} minFrom @param {string} target @param {string} channel
 * @returns {{ ok: true } | { ok: false, step: Release | null }}
 */
export function canUpdate(list, current, minFrom, target, channel) {
  if (!minFrom || !parseVersion(minFrom) || compare(current, minFrom) >= 0) return { ok: true };
  const step = [...list].sort((a, b) => compare(a.version, b.version))
    .find(r => inChannel(r, channel) && compare(r.version, minFrom) >= 0 && compare(r.version, target) < 0) || null;
  return { ok: false, step };
}

/**
 * A SHA256SUMS file as { name: hash }. Strict: every line must be `<64 hex> <space or *><name>`,
 * the sha256sum format. Anything else (an HTML error page, an empty file) throws, so a wrong URL
 * never reads as "no line for this file".
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseSums(text) {
  const lines = String(text).split("\n").map(l => l.replace(/\r$/, "")).filter(l => l !== "");
  if (!lines.length) throw new Error("SHA256SUMS is empty");
  /** @type {Record<string, string>} */
  const sums = {};
  for (const l of lines) {
    const m = /^([0-9a-f]{64}) [ *]([^ /]+)$/.exec(l);
    if (!m) throw new Error("SHA256SUMS is not a checksum list");
    sums[m[2]] = m[1];
  }
  return sums;
}

/** A file's sha256, in hex. */
export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Throws unless `file` matches the line for `name`. @param {string} file @param {string} name @param {Record<string, string>} sums */
export function verify(file, name, sums) {
  const want = sums[name];
  if (!want) throw new Error(`SHA256SUMS has no line for ${name}`);
  const got = sha256File(file);
  if (got !== want) throw new Error(`checksum mismatch for ${name} (want ${want.slice(0, 12)}, got ${got.slice(0, 12)})`);
}

/** A download URL Vyre will fetch from: https, or plain http only to this machine (the tests). */
export function safeUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(`not a URL: ${u}`); }
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url.href;
  throw new Error(`refusing to download over ${url.protocol} from ${url.host}`);
}
