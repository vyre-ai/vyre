// @ts-check
// lib/publish/hostname.js: strict hostname validation for anything that reaches a Caddyfile or a compose file.
// No wildcards from user input, no IP addresses, no internal names, punycode handled, one label under vyre.run.

import { domainToASCII, domainToUnicode } from "node:url";
import { fail } from "./util.js";

export const VYRE_DOMAIN = "vyre.run";
export const RESERVED_LABELS = Object.freeze(["www", "admin", "api", "app", "mail", "publish", "preview", "relay", "wink", "control", "dns", "ns", "ns1", "ns2", "vyre", "root", "status", "support", "smtp", "imap", "ftp", "git", "hq", "setup", "box"]);
const INTERNAL_TLDS = new Set(["localhost", "local", "internal", "lan", "home", "corp", "intranet", "private", "test", "example", "invalid", "onion", "arpa", "localdomain", "home", "docker", "svc", "cluster", "ts", "wink"]);
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SCRIPTS = ["Latin", "Cyrillic", "Greek"];

/**
 * Validate and normalise a hostname a person typed. Returns the ASCII (punycode) form and the display form.
 * Throws PublishError `bad_domain` for anything that is not a plain public DNS name.
 * @param {unknown} input
 * @param {{ generated?: boolean }} [opts] `generated`: a name Vyre builds itself (preview and default hosts), so the vyre.run depth and reserved-label rules do not apply
 * @returns {{ ascii: string, unicode: string, labels: string[], vyre_run: boolean }}
 */
export function normalizeHost(input, opts = {}) {
  if (typeof input !== "string" || input.length === 0 || input.length > 253 * 4) fail("bad_domain", "a domain name is required");
  if (/[\s\u0000-\u001f\u007f]/.test(input)) fail("bad_domain", "a domain name has no spaces or control characters");
  if (/[*\/\\?#@:\[\]{}()<>"'`;|&$%!^=,+~]/.test(input)) fail("bad_domain", "a domain name holds letters, digits and hyphens only; wildcards are not allowed");
  const ascii = domainToASCII(input);
  if (!ascii || ascii.length > 253) fail("bad_domain", "that is not a valid domain name");
  if (ascii.endsWith(".")) fail("bad_domain", "leave off the trailing dot");
  const labels = ascii.split(".");
  if (labels.length < 2) fail("bad_domain", "a domain needs at least two parts, like harlow.example.com");
  for (const l of labels) if (!LABEL_RE.test(l)) fail("bad_domain", "that is not a valid domain name");
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld) || /^0x[0-9a-f]+$/i.test(tld)) fail("bad_domain", "an IP address is not a domain name");
  if (INTERNAL_TLDS.has(tld)) fail("bad_domain", "internal names cannot be published");
  if (tld.length < 2) fail("bad_domain", "that is not a valid domain name");
  const unicode = domainToUnicode(ascii);
  for (const l of labels) {
    if (l.startsWith("xn--")) {
      const u = domainToUnicode(l);
      if (!u || u === l) fail("bad_domain", "that is not a valid internationalised name");
      const seen = SCRIPTS.filter(s => new RegExp(`\\p{Script=${s}}`, "u").test(u));
      if (seen.length > 1) fail("bad_domain", "that name mixes alphabets and could be mistaken for another");
    } else if (l.slice(2, 4) === "--") fail("bad_domain", "that is not a valid domain name");
  }
  const vyre_run = ascii === VYRE_DOMAIN || ascii.endsWith("." + VYRE_DOMAIN);
  if (ascii === VYRE_DOMAIN) fail("bad_domain", "that name is reserved");
  if (vyre_run && !opts.generated) {
    if (labels.length !== 3) fail("bad_domain", `use one label: <label>.${VYRE_DOMAIN}`);
    if (RESERVED_LABELS.includes(labels[0])) fail("bad_domain", "that label is reserved");
  }
  return { ascii, unicode, labels, vyre_run };
}

/** @param {string} host @returns {boolean} */
export const isValidHost = host => { try { normalizeHost(host); return true; } catch { return false; } };
