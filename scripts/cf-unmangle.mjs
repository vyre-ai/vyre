#!/usr/bin/env node
// cf-unmangle: put a page served by Cloudflare back the way it was uploaded, for scripts/assemble-site.sh --check. Cloudflare's edge rewrites any text in an HTML page that looks like an email address
// (the docs say `alex@192.0.2.10`, an SSH target) into `<a class="__cf_email__" data-cfemail="HEX">[email&#160;protected]</a>` (or a `/cdn-cgi/l/email-protection#HEX` link) and adds one decode script before </body>.
// This undoes exactly those two edits, so every other byte of the served page is still compared with the assembled copy. The hex is the address XOR-ed with its first byte, the key.
// Reads the served page on stdin, writes the restored page on stdout.
import fs from "node:fs";

const decode = hex => { const k = parseInt(hex.slice(0, 2), 16); let out = ""; for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return out; };

const html = fs.readFileSync(0, "utf8")
  .replace(/<a href="\/cdn-cgi\/l\/email-protection" class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email&#160;protected\]<\/a>/g, (_, h) => decode(h))
  .replace(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/g, (_, h) => "mailto:" + decode(h))
  .replace(/<script data-cfasync="false" src="\/cdn-cgi\/scripts\/[0-9a-f]+\/cloudflare-static\/email-decode\.min\.js"><\/script>/g, "");
process.stdout.write(html);
