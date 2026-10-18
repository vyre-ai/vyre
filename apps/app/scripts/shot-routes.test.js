import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_ONLY, PROOF_OR_MOCK, blockRe } from "./sample-routes.js";
import { leaks } from "./check-release-routes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const metro = fs.readFileSync(path.join(app, "metro.config.js"), "utf8");
const mockRe = blockRe(MOCK_ONLY), proofRe = blockRe(PROOF_OR_MOCK);
const p = (f) => path.join(app, f);

test("a real build blocks the sample-world pages from Metro, the mock build does not", () => {
  assert.match(metro, /if \(process\.env\.EXPO_PUBLIC_VYRE_MOCK !== "1"\) \{\n\s+config\.resolver\.blockList = [^\n]*blockRe\(MOCK_ONLY\)/, "only a build that is not the mock build blocks them");
  assert.match(metro, /EXPO_PUBLIC_VYRE_PROOF !== "1"\) config\.resolver\.blockList = [^\n]*blockRe\(PROOF_OR_MOCK\)/, "the proof page stays in the proof build");
});

test("every demo, gallery, proof and screenshot page is in the list, and no real page is", () => {
  const demos = ["app/chat-demo.tsx", "app/connect-demo.tsx", "app/gallery.tsx", "app/terminal-demo.tsx", "app/keycheck.tsx", "app/glass-relay-proof.tsx", "app/notices-proof.tsx", "app/u/vault-design.tsx", "app/u/flows/shot.tsx",
    ...fs.readdirSync(path.join(app, "app")).filter((f) => /^shots-/.test(f)).map((f) => `app/${f}`)];
  for (const f of demos) { assert.ok(fs.existsSync(p(f)), `${f} exists`); assert.ok(mockRe.test(p(f)), `${f} is not registered in a real build`); }
  assert.ok(proofRe.test(p("app/two-servers-proof.tsx")));
  assert.equal(mockRe.test(p("app/two-servers-proof.tsx")), false, "the proof page is blocked by its own rule");
  for (const f of ["app/u/flows/new.tsx", "app/u/flows/[id].tsx", "app/u/design.tsx", "app/onboard.tsx", "app/u/now.tsx", "app/index.tsx", "app/settings.tsx", "app/devices.tsx"]) {
    assert.equal(mockRe.test(p(f)) || proofRe.test(p(f)), false, `${f} is a real page`);
  }
});

test("no real screen links to a blocked page", () => {
  const alt = [...MOCK_ONLY, ...PROOF_OR_MOCK].join("|");
  const link = new RegExp(`["'\`]/(${alt})[?"'\`/]`);
  /** @type {string[]} */ const hits = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(f); continue; }
    if (!/\.(tsx?|js|mjs)$/.test(e.name) || /\.test\.|\.generated\./.test(e.name)) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((line, n) => { if (!/^\s*(\/\/|\*)/.test(line) && link.test(line)) hits.push(`${path.relative(app, f)}:${n + 1}`); });
  } };
  for (const d of ["screens", "ui", "src", "modules"]) if (fs.existsSync(path.join(app, d))) walk(path.join(app, d));
  assert.deepEqual(hits, [], "a link to a page a release does not have");
});

test("the release export check finds a blocked page by its chunk or by the router's file map, and passes a clean export", () => {
  const clean = ["index.html", "_expo/static/js/web/entry-0123456789abcdef.js", "_expo/static/js/web/onboard-893096b1004853156007001f703efcdb.js"];
  assert.deepEqual(leaks(clean, () => "routes: ./onboard.tsx ./u/now.tsx"), []);
  assert.equal(leaks([...clean, "_expo/static/js/web/chat-demo-0123456789abcdef.js"], () => "").length, 1);
  assert.equal(leaks([...clean, "_expo/static/js/web/shots-vault-0123456789abcdef.js"], () => "").length, 1);
  assert.equal(leaks(clean, (f) => (f.startsWith("_expo/static/js/web/entry") ? 'ctx: {"./u/flows/shot.tsx": 1}' : "")).length, 1);
  assert.equal(leaks(clean, (f) => (f.startsWith("_expo/static/js/web/entry") ? 'ctx: {"./u/flows/new.tsx": 1}' : "")).length, 0);
  assert.equal(leaks(["x/two-servers-proof-aaaaaaaaaaaa.js"], () => "").length, 1);
});
