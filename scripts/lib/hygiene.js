// @ts-check
// hygiene: the rules for what may never appear in Vyre's code or docs. test/hygiene.test.js holds
// shipped code to FORBIDDEN and SECRET; scripts/docs-check holds every published page to all of
// them. One list, two users, so the two can never disagree.
//
// The forbidden words are stored encoded so this file does not match itself. They are the names
// of the people and businesses whose machines Vyre was first built on; none may appear in code
// anyone installs or in a page anyone reads.

export const FORBIDDEN = ["aXJmYWQ=", "bXlsZWdhbGFjYWRlbXk=", "cmFucWw=", "aXZ5cw==", "a2F6YWxhdw==", "dGVjaG1hbmFnZXI="]
  .map(b => Buffer.from(b, "base64").toString("utf8"));

export const SECRET = /((?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

// Examples use the made-up sample world (alex, Juniper Studio, Northwind Bakery, juno, kit) or the
// domains reserved for documentation. Anything else could be a real person's inbox. A git remote
// (git@github.com) is an address in form only.
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const EMAIL_DOMAINS = [/^example\.(com|org|net)$/i, /\.example(\.(com|org|net))?$/i, /^(harlowlegal|harlow-legal|northwindbakery|northwind-bakery|northwind)\.(com|org|net|co|test)$/i,
  /\.(test|example|invalid|localhost)$/i, /^vyre\.run$/i, /\.vyre\.run$/i];

/** @param {string} domain */
export const sampleEmailDomain = domain => EMAIL_DOMAINS.some(r => r.test(domain));

// IPv4 addresses that are safe in an example: the documentation ranges (RFC 5737), the tailnet
// range Tailscale hands out (100.64.0.0/10), loopback, the any-address and the private ranges.
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d]|\.\d)/g;

/** @param {number[]} o */
export function safeIPv4([a, b, c, d]) {
  if ([a, b, c, d].some(n => n > 255)) return true; // not an address (a version number, say)
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127 && b === 0 && c === 0 && d === 1) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 255 && b === 255) return true; // a netmask
  return false;
}

/**
 * Every hygiene problem in one text, with 1-based line numbers.
 * @param {string} text
 * @returns {{ line: number, problem: string }[]}
 */
export function scanText(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = i + 1, lower = raw.toLowerCase();
    for (const w of FORBIDDEN) if (lower.includes(w)) out.push({ line, problem: "names a real person or business; use the sample world (alex, Harlow Legal, Northwind Bakery)" });
    if (SECRET.test(raw)) out.push({ line, problem: "looks like a secret" });
    for (const m of raw.matchAll(EMAIL)) if (!sampleEmailDomain(m[1]) && !/^git@(github|gitlab)\.com$/i.test(m[0])) out.push({ line, problem: `email address ${m[0]} is not an example; use @example.com` });
    for (const m of raw.matchAll(IPV4)) if (!safeIPv4(m.slice(1, 5).map(Number))) out.push({ line, problem: `IP address ${m[0]} is not in a documentation range; use 192.0.2.x, 198.51.100.x or 203.0.113.x` });
  });
  return out;
}
