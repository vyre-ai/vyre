// @ts-check
// drive-windows: mapping a VyreDrive share as a Windows drive.
//
// Taildrive is WebDAV, and Windows has a WebDAV client of its own (the WebClient service), so a
// share maps like any network drive: `net use Z: \\100.100.100.100@8080\<tailnet>\<machine>\<share>`.
// The `host@port` UNC form is how Windows names a WebDAV server on a port. Nothing is installed;
// the drive shows in Explorer, and a file is fetched when it is opened.
//
// These are the pure pieces (the address, the command lines, reading `net use`), so the mapping
// is testable without Windows. drive.js runs the commands, and the Windows app's own mount
// command is built from the same strings.

import fs from "node:fs";

/**
 * The UNC name of a Taildrive WebDAV address.
 * http://100.100.100.100:8080/example.com/vyre/projects  ->  \\100.100.100.100@8080\example.com\vyre\projects
 * @param {string} url
 */
export function uncFor(url) {
  const u = new URL(url);
  if (u.protocol !== "http:") throw new Error("a VyreDrive address is http on the tailnet");
  const host = u.port && u.port !== "80" ? `${u.hostname}@${u.port}` : u.hostname;
  const parts = u.pathname.split("/").filter(Boolean).map(s => decodeURIComponent(s));
  if (parts.some(s => /[\\:*?"<>|]/.test(s))) throw new Error("a share name Windows cannot map");
  return `\\\\${host}\\${parts.join("\\")}`;
}

/** Pure: `net use` arguments to map a share to a drive letter such as "Z:". Never persistent: Vyre maps it again when asked. */
export const mapArgs = (letter, unc) => ["use", letter, unc, "/persistent:no"];
export const unmapArgs = letter => ["use", letter, "/delete", "/y"];

/**
 * Pure: the drive letters `net use` lists as mapped to a Taildrive address, and every letter it
 * lists at all. Lines look like `OK           Z:        \\100.100.100.100@8080\a\b\c   Web Client Network`.
 * @param {string} out
 * @returns {{ vyre: { letter: string, unc: string }[], used: string[] }}
 */
export function parseNetUse(out) {
  const vyre = [], used = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s*(?:\S+\s+)?([A-Za-z]:)\s+(\\\\\S+)/.exec(line);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    used.push(letter);
    if (/^\\\\100\.100\.100\.100@8080\\/i.test(m[2])) vyre.push({ letter, unc: m[2] });
  }
  return { vyre, used };
}

/**
 * Pure: the first free drive letter, from Z down to D, skipping mapped ones and ones that exist.
 * @param {string[]} used letters like "C:" @param {(letter: string) => boolean} [exists]
 */
export function freeLetter(used, exists = l => { try { return fs.existsSync(l + "\\"); } catch { return false; } }) {
  const taken = new Set(used.map(l => l.toUpperCase()));
  for (let c = 90; c >= 68; c--) {
    const l = String.fromCharCode(c) + ":";
    if (!taken.has(l) && !exists(l)) return l;
  }
  return null;
}

/**
 * Pure: turn a `net use` failure into what the person can do about it. The usual cause is the
 * WebClient service, which Windows ships stopped on some editions.
 * @param {string} text
 */
export function explainNetUse(text) {
  const t = String(text || "").trim();
  if (/\b67\b|network name cannot be found|\b1244\b|\b53\b|network path was not found/i.test(t)) {
    return "Windows could not reach the share. Check Tailscale is running and signed in on this PC, and that the WebClient service is running (Services, WebClient, Start).";
  }
  if (/\b85\b|already in use/i.test(t)) return "that drive letter is already in use";
  return t.split(/\r?\n/).find(l => l.trim()) || "net use failed";
}
