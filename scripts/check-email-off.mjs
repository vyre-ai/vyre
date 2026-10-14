#!/usr/bin/env node
// check-email-off: no HTML page of the assembled site may carry email-looking text outside <!--email_off--> ... <!--/email_off-->. Cloudflare's edge rewrites such text into "[email protected]" (see scripts/lib/docs/markdown.js
// noEdgeRewrite), which breaks a command like `vyre box add alex@192.0.2.10` for a reader without JavaScript and for an agent.
//   node scripts/check-email-off.mjs DIR   exit 1 and list each page and address that would be rewritten
import fs from "node:fs";
import path from "node:path";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** @param {string} dir @returns {string[]} */
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".html") ? [path.join(dir, e.name)] : []));

/** The addresses in an HTML page that sit outside email_off markers, script/style bodies and tag attributes Cloudflare leaves alone. @param {string} html */
export function exposed(html) {
  const text = html
    .replace(/<!--email_off-->[\s\S]*?<!--\/email_off-->/g, "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return [...text.matchAll(EMAIL)].map(m => m[0]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: check-email-off.mjs DIR"); process.exit(1); }
  let bad = 0;
  for (const f of walk(dir)) { const found = exposed(fs.readFileSync(f, "utf8")); if (found.length) { bad++; console.error(`${path.relative(dir, f)}: ${[...new Set(found)].slice(0, 5).join(", ")}`); } }
  if (bad) { console.error(`check-email-off: ${bad} page(s) carry email-looking text outside <!--email_off-->`); process.exit(1); }
}
