// @ts-check
// S2 for the whole shipped tree, not only for the lines a branch adds (scripts/team/preflight.mjs): nothing the product ships loads from a third-party CDN, font host or analytics host, and no
// content-security policy lists one. The product is what a box and the apps serve; the public website (site/, scripts/gen-site.mjs, scripts/lib/docs) and docs have their own page in BACKLOG.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdnHit, CDN_HOSTS, s2Exempt } from "../scripts/team/cdn-hosts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** What a box and the apps ship. */
const SHIPPED = ["web", "core", "lib", "modules", "local", "kernel", "harness", "box", "relay", "records", "stores", "names", "bin", "apps/app/src", "apps/app/screens", "apps/app/app", "apps/app/modules", "apps/android/app/src/main", "apps/ios"];
const EXT = /\.(m?js|cjs|ts|tsx|html|css|json|swift|kt|java|sh|yml|yaml)$/;

test("cdnHit finds a CDN in a link, an import, a style url and a CSP source list, and nothing in plain text", () => {
  assert.equal(cdnHit('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans">'), "fonts.googleapis.com");
  assert.equal(cdnHit('import x from "https://esm.sh/react@18"'), "esm.sh");
  assert.equal(cdnHit("@import url(//fonts.gstatic.com/s/x.woff2)"), "fonts.gstatic.com");
  assert.equal(cdnHit("style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"), "fonts.googleapis.com");
  assert.equal(cdnHit("src='https://cdn.jsdelivr.net/npm/x'"), "cdn.jsdelivr.net");
  assert.equal(cdnHit("https://www.google-analytics.com/collect"), "www.google-analytics.com");
  assert.equal(cdnHit("the font is served from the box, not from unpkg or Google"), "");
  assert.equal(cdnHit("https://notunpkg.com.example.org/x"), "", "a different host that only contains the name");
  assert.ok(CDN_HOSTS.length >= 25);
});

test("nothing the product ships names a CDN, font host or analytics host", () => {
  /** @type {string[]} */ const hits = [];
  const walk = (/** @type {string} */ dir) => {
    let entries; try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "vendor") continue;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!EXT.test(e.name) || s2Exempt(rel)) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      text.split("\n").forEach((line, i) => { const h = cdnHit(line); if (h) hits.push(`${rel}:${i + 1}: ${h}`); });
    }
  };
  for (const d of SHIPPED) walk(d);
  assert.deepEqual(hits, [], `shipped code points at a third-party host (vendor the file, pinned and hashed, and serve it from the box):\n  ${hits.join("\n  ")}`);
});
