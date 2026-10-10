// A self-hosted Vyre does not call another company when a device pairs (S2: no third-party host in shipped code). The pairing pages, the app's CSP and the box's CSP name only this box.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CSP } from "./app.js";

const root = new URL("../../", import.meta.url).pathname;
const hosts = (/** @type {string} */ s) => [...s.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
const htmlIn = (/** @type {string} */ dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? htmlIn(path.join(dir, e.name)) : e.name.endsWith(".html") ? [path.join(dir, e.name)] : []);

test("the onboarding pages load nothing from outside this box", () => {
  for (const f of htmlIn(path.join(root, "web", "onboard"))) assert.deepEqual(hosts(fs.readFileSync(f, "utf8")), [], `${path.relative(root, f)} names an outside host`);
});

test("both content security policies name no outside host, and the fonts they need are the box's own", () => {
  assert.deepEqual(hosts(CSP), []);
  const src = fs.readFileSync(path.join(root, "core", "daemon", "index.js"), "utf8");
  const policies = [...src.matchAll(/"content-security-policy": `([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ""));
  assert.ok(policies.length >= 1, "the box's policy was found");
  for (const p of policies) assert.deepEqual(hosts(p), [], p);
  assert.ok(fs.existsSync(path.join(root, "web", "fonts", "instrument-sans-latin.woff2")), "the sans face is served from web/fonts");
  assert.ok(fs.existsSync(path.join(root, "web", "fonts", "jetbrains-mono-latin.woff2")), "the mono face is served from web/fonts");
});
