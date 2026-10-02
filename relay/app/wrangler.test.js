// The three Workers' wrangler.toml files: workers.dev off and exactly one custom-domain route each, as TOP-LEVEL keys.
// Keys written after a [table] header belong to that table, which silently unbinds the route and leaves workers.dev on.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const topLevel = file => {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const lines = text.split("\n");
  const end = lines.findIndex(l => /^\s*\[/.test(l));
  return (end < 0 ? lines : lines.slice(0, end)).filter(l => !/^\s*#/.test(l)).join("\n");
};

for (const [file, domain] of [["relay/worker/wrangler.toml", "relay.vyre.run"], ["names/worker/wrangler.toml", "names.vyre.run"], ["relay/app/wrangler.toml", "app.vyre.run"]]) {
  test(`${file}: workers.dev off and the ${domain} custom domain, as top-level keys`, () => {
    const top = topLevel(file);
    assert.match(top, /^workers_dev\s*=\s*false\s*$/m);
    const routes = [...top.matchAll(/^routes\s*=\s*\[(.*)\]\s*$/gm)];
    assert.equal(routes.length, 1, "one routes line before the first table");
    assert.deepEqual([...routes[0][1].matchAll(/pattern\s*=\s*"([^"]+)"/g)].map(m => m[1]), [domain]);
    assert.match(routes[0][1], /custom_domain\s*=\s*true/);
  });
}

for (const file of ["relay/worker/wrangler.toml", "names/worker/wrangler.toml"]) {
  test(`${file}: Cloudflare request logs are off (they keep addresses Vyre does not need, #70)`, () => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    assert.match(text, /^\[observability\]\s*\nenabled\s*=\s*false\s*$/m);
    assert.doesNotMatch(text, /enabled\s*=\s*true/, "no logs, traces or invocation logs switched on anywhere in the file");
  });
}
