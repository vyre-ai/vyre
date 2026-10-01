// @ts-check
// The release workflow produces what the updater reads (launch): the pin script, the Ed25519 signature every updater verifies, the gate, in that order,
// and the cosign identity unchanged (a keyless `cosign sign --yes` in this workflow, which is what the boxes' identity regex names).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8");

test("release.yml: images are pinned by script, SHA256SUMS is signed with the Ed25519 key, the gate runs before minisign, cosign and publish", () => {
  const at = s => { const i = yml.indexOf(s); assert.ok(i >= 0, `release.yml has no "${s}"`); return i; };
  const pin = at("scripts/pin-release-compose.mjs"), sign = at("scripts/sign-manifest.mjs"), gate = at("scripts/check-release-dist.mjs"), minisign = at("minisign -S"), blob = at("cosign sign-blob"), publish = at("gh release create");
  assert.ok(pin < sign && sign < gate && gate < minisign && minisign < blob && blob < publish, "order: pin, Ed25519 sign, gate, minisign, cosign blob, publish");
  assert.match(yml, /VYRE_SIGNING_KEY: \$\{\{ env\.PUBLISH == 'true' && secrets\.VYRE_RELEASE_SIGNING_KEY \|\| '' \}\}/, "the key is the release environment's secret, only on a publish");
  assert.match(yml, /check-release-dist\.mjs dist --pulled --pubkey/, "a publish is gated with images required and the signature checked against the pinned key");
  assert.ok(!/\$\{VYRE_IMAGE:-\$BOX\}/.test(yml), "the old sed that kept a variable is gone");
  // The identity boxes demand is this workflow at a version tag: images are signed here with `cosign sign --yes` (keyless).
  assert.match(yml, /cosign sign --yes "\$ref"/);
  const cosignRegex = fs.readFileSync(path.join(REPO, "scripts/install-box.sh"), "utf8").match(/^COSIGN_ID='(.*)'$/m)?.[1] || "";
  assert.ok(cosignRegex.includes("workflows/release\\.yml@refs/tags/v"), "the installer's identity names this workflow file at a version tag");
});
