// @ts-check
// R031-00c: "grep finds one of each". Four jobs, one mechanism each: the role list, the secret detector, the grant model, the approval path. The first two pass today. The grant model (owner:
// connect-anything) and the approval path (owner: session-transfer) are marked `todo` with what they find; the owner removes the `todo` in the commit that lands the work, and the test then holds.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["core", "lib", "kernel", "records", "harness", "apps/app/screens", "apps/app/src"];

/** Source files (js, mjs, ts, tsx), no tests, fixtures or type files. @param {string[]} dirs */
function sources(dirs = DIRS) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "testing" && e.name !== "test" && e.name !== "fixtures") walk(p); }
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && !/\.(test|d)\.(js|ts|tsx|mjs)$|^test-kit\.js$/.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return out.map((f) => path.relative(ROOT, f));
}
/** The code lines of a file: comment-only lines dropped. @param {string} rel */
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
/** @param {string[]} files @param {RegExp} re @param {Set<string>} allowed */
const find = (files, re, allowed) => files.filter((f) => !allowed.has(f)).flatMap((f) => code(f).filter(({ l }) => re.test(l)).map(({ n }) => `${f}:${n}`));

test("A. one role list: only the contracts, and four named special lists, spell out the role sequence (details in test/one-role-list.test.js)", () => {
  const allowed = new Set(["kernel/contracts/index.js", "core/wink/pairing.js", "lib/publish/flow.js", "core/vault/shared.js", "apps/app/screens/assistants/create-card-model.ts"]);
  assert.deepEqual(find(sources(), /["']owner["']\s*,\s*["']admin["']|["']admin["']\s*,\s*["']manager["']\s*,\s*["']member["']/, allowed), []);
});

test("B. one secret detector: a token shape or a private key header is spelled only in lib/credential-shapes.js (the app's redactor, the Chrome extension copy and the Swift capsule are named below)", () => {
  const allowed = new Set([
    "lib/credential-shapes.js",
    "apps/app/screens/connections/model.ts",   // the app cannot bundle lib/; pinned to the table by test/credential-pins.test.js
    "lib/siteops/redact.js",                   // generated into the Chrome extension by scripts/sync-copies.mjs; pinned by the same test
  ]);
  const shapes = /\bghp_|github_pat_|xox\[?[abprs]|\bsk_live|\bAKIA|\bsk-ant-|-----BEGIN [A-Z0-9 \[\]*]*PRIVATE KEY/;
  assert.deepEqual(find(sources(), shapes, allowed), [], "use lib/credential-shapes.js (classify, findRules, redact, hasPrivateKey, privateKeyBlock, anthropicKind), or add the file with the reason");
});

test("C. one grant model: the vault, publish, wink and bridges grants are kernel grants", { todo: "owner: connect-anything (INVENTORY.md 00c, C); remove this todo when the second models are gone" }, () => {
  const second = [
    ["core/wink/grants.js", /checkGrantInput/], ["lib/publish/secrets.js", /export function grantSecret/], ["core/vault/index.js", /tool\("vault\.grant"/], ["core/bridges/index.js", /ctx\.tool\("bridges\.accept"/],
  ].filter(([f, re]) => fs.existsSync(path.join(ROOT, /** @type {string} */ (f))) && /** @type {RegExp} */ (re).test(fs.readFileSync(path.join(ROOT, /** @type {string} */ (f)), "utf8"))).map(([f]) => f);
  assert.deepEqual(second, [], "a second grant model is still defined here");
});

test("D. one approval path: gate.held, vault.pending and threads.asks are cards in core/approvals, not stores of their own", { todo: "owner: session-transfer (INVENTORY.md 00c, D, one-yes step C); remove this todo when they are cards" }, () => {
  const own = [
    ["core/gate/index.js", /ctx\.tool\("gate\.held"/], ["core/vault/index.js", /tool\("vault\.pending"/], ["core/switchboard/index.js", /tool\("threads\.answer"/],
  ].filter(([f, re]) => /** @type {RegExp} */ (re).test(fs.readFileSync(path.join(ROOT, /** @type {string} */ (f)), "utf8"))).map(([f]) => f);
  assert.deepEqual(own, [], "a separate approval store is still defined here");
});
