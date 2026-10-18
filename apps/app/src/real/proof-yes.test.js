// @ts-check
// The proof build's software yes (proof-yes.ts) exists only in a build made for the proof. In any other build it says nothing and leaves no marker; the app workflow greps the release web export for the marker and the
// flag name, and the first-run workflow's proof export must SHOW the marker (the positive control, so the release grep can find it). The server side is checked where the rule lives: a release-kind sealing process
// refuses a software key and a software proof (kernel/seal/seal.test.js SW-2, join.test.js).
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const read = (/** @type {string} */ rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("a build without the flag gives no yes and leaves no marker", { skip: !strip }, async () => {
  delete process.env.EXPO_PUBLIC_VYRE_PROOF_YES;
  delete (/** @type {any} */ (globalThis)).__vyreProofYes;
  const m = await import("./proof-yes.ts?plain");
  assert.equal(await m.proofYes("per_x"), null);
  assert.equal(/** @type {any} */ (globalThis).__vyreProofYes, undefined);
});

test("the flag is checked first in proofYes, and nothing else in the app reads it", () => {
  const src = read("./proof-yes.ts");
  assert.match(src, /export async function proofYes\([^)]*\)[^{]*\{\n  if \(process\.env\.EXPO_PUBLIC_VYRE_PROOF_YES !== "1"\) return null;\n/);
  assert.ok(src.indexOf("vyre-proof-yes-enabled") > src.indexOf("!== \"1\") return null"), "the marker is set only after the flag check");
  const walk = (/** @type {string} */ d) => fs.readdirSync(new URL(d, import.meta.url), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${d}${e.name}/`)) : [`${d}${e.name}`]);
  for (const root of ["../../src/", "../../screens/", "../../app/"]) for (const f of walk(root)) {
    if (!/\.(ts|tsx|js)$/.test(f) || /\.test\./.test(f)) continue;
    const t = read(f);
    if (/EXPO_PUBLIC_VYRE_PROOF_YES/.test(t)) assert.ok(/proof-yes\.ts$/.test(f), `${f} reads the proof yes flag`);
  }
});

test("only the proof's own web export is built with the flag, and the release export is searched for the marker and the flag name", () => {
  const app = read("../../../../.github/workflows/app.yml");
  assert.match(app, /grep -rlE "vyre-proof-yes-enabled\|EXPO_PUBLIC_VYRE_PROOF_YES" dist\b/, "the release web export is searched");
  const fr = read("../../../../.github/workflows/first-run-e2e.yml");
  assert.match(fr, /EXPO_PUBLIC_VYRE_PROOF_YES: "1"/, "the proof export carries the flag");
  assert.match(fr, /grep -rl "vyre-proof-yes-enabled" "\$RUNNER_TEMP\/proof-web"/, "and must show the marker (positive control)");
  const rel = read("../../../../.github/workflows/release.yml");
  assert.ok(!/PROOF_YES/.test(rel), "the release workflow never sets it");
});

test("a release-kind sealing process refuses a software key (the server side of the rule is tested where it lives)", () => {
  const seal = read("../../../../kernel/seal/seal.test.js");
  assert.match(seal, /SW-2: a real sealing child from a release-stamped copy ignores VYRE_SEAL_DEV/);
  assert.match(seal, /software_refused/);
});
