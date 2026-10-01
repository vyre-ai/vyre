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

test("release.yml: images are pinned by script, SHA256SUMS is signed with the Ed25519 key, the gate runs before the cosign blob and publish", () => {
  const at = s => { const i = yml.indexOf(s); assert.ok(i >= 0, `release.yml has no "${s}"`); return i; };
  const pin = at("node scripts/pin-release-compose.mjs"), sign = at("node scripts/sign-manifest.mjs"), gate = at("node scripts/check-release-dist.mjs dist --pulled"), blob = at("cosign sign-blob --yes"), publish = at("gh release create");
  assert.ok(pin < sign && sign < gate && gate < blob && blob < publish, "order: pin, Ed25519 sign, gate, cosign blob, publish");
  assert.match(yml, /VYRE_SIGNING_KEY: \$\{\{ env\.PUBLISH == 'true' && secrets\.VYRE_RELEASE_SIGNING_KEY \|\| '' \}\}/, "the key is the release environment's secret, only on a publish");
  assert.match(yml, /check-release-dist\.mjs dist --pulled --installer --pubkey/, "a publish is gated with images required and the signature checked against the pinned key");
  assert.ok(!/\$\{VYRE_IMAGE:-\$BOX\}/.test(yml), "the old sed that kept a variable is gone");
  // The identity boxes demand is this workflow at a version tag: images are signed here with `cosign sign --yes` (keyless).
  assert.match(yml, /cosign sign --yes "\$ref"/);
  const cosignRegex = fs.readFileSync(path.join(REPO, "scripts/install-box.sh"), "utf8").match(/^COSIGN_ID='(.*)'$/m)?.[1] || "";
  assert.ok(cosignRegex.includes("workflows/release\\.yml@refs/tags/v"), "the installer's identity names this workflow file at a version tag");
});

test("release.yml: a publishing run builds and signs only a commit that is on main or the 0.2 stage line, checked before the notes step", () => {
  const guard = yml.indexOf("git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main");
  assert.ok(guard > 0 && guard < yml.indexOf("- name: Version, channel, notes"));
  assert.match(yml, /origin\/work\/stage-0\.2/);
  assert.match(yml, /if: github\.event_name == 'push' && vars\.VYRE_RELEASES == 'go'\n\s+run: \|\n\s+git fetch --no-tags origin main work\/stage-0\.2/);
});

test("release.yml: the step that holds the signing key runs only checked-in scripts, with no inline code", () => {
  const i = yml.indexOf("- name: release.json, SHA256SUMS, and on a publish");
  const step = yml.slice(i, yml.indexOf("\n      - name:", i + 10));
  assert.ok(!/node -e|node --eval|python|perl -e/.test(step), "no inline interpreter code in the step that sees the key");
  assert.match(step, /node scripts\/write-release-json\.mjs/);
  assert.match(step, /node scripts\/sign-manifest\.mjs/);
});

test("release.yml and capsule-win.yml: every action is pinned by commit sha (the key signs whatever those jobs built)", () => {
  const win = fs.readFileSync(path.join(REPO, ".github/workflows/capsule-win.yml"), "utf8");
  const loose = [...(yml + "\n" + win).matchAll(/uses: ([^\s@]+)@(\S+)/g)].filter(m => !/^[0-9a-f]{40}$/.test(m[2]) && !m[1].startsWith("./"));
  assert.deepEqual(loose.map(m => `${m[1]}@${m[2]}`), []);
});

test("release.yml: the approver's signing-path diff is written in the prepare job (before the environment approval) and covers the signing scripts, the wrapper and the phone app's lockfile", () => {
  const i = yml.indexOf("What changed in the signing path since the last published release, for the approver");
  assert.ok(i > 0, "the step exists");
  const prepare = yml.indexOf("  prepare:"), images = yml.indexOf("\n  images:");
  assert.ok(prepare < i && i < images, "it is a step of the prepare job, which needs no approval");
  const step = yml.slice(i, yml.indexOf("\n      - name:", i + 10));
  for (const p of [".github/workflows", "scripts/sign-manifest.mjs", "scripts/write-release-json.mjs", "scripts/pin-release-compose.mjs", "scripts/check-release-dist.mjs", "scripts/build-app-out.mjs", "scripts/strip-wrapper.mjs", "box/vyre", "apps/app/package-lock.json", "scripts/lock-changes.mjs", "core/vyre-core/release.js"]) assert.ok(step.includes(p), `the diff covers ${p}`);
  assert.match(step, /TRUNCATED/, "a truncated diff says so");
});

test("release.yml: the Windows installer is built in this run, required by the release job, and added to dist before SHA256SUMS is made and signed", () => {
  assert.match(yml, /\n  windows:\n    needs: prepare\n    uses: \.\/\.github\/workflows\/capsule-win\.yml/);
  assert.match(yml, /needs: \[prepare, images, manifests, app-web, windows\]/);
  assert.match(yml, /needs\.windows\.result == 'success'/);
  const add = yml.indexOf("Add the Windows installer to dist"), sums = yml.indexOf("- name: release.json, SHA256SUMS");
  assert.ok(add > 0 && add < sums, "the installer is in dist before the signed list is made");
  assert.match(yml, /cp "\$RUNNER_TEMP\/windows\/\$exe" dist\/VyreSetup\.exe/);
});

test("release.yml: no step needs a secret or a file that does not exist: the only secret is the Ed25519 release key, and minisign is gone", () => {
  const secrets = [...new Set([...yml.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]))];
  assert.deepEqual(secrets, ["VYRE_RELEASE_SIGNING_KEY"]);
  assert.ok(!/minisign/i.test(yml), "no minisign step, key or public key reference");
  // Every repo path a step reads exists in the tree (release/notes is optional on a dry run; the publish path checks it itself).
  for (const f of ["release/min_from", "scripts/sign-manifest.mjs", "scripts/write-release-json.mjs", "scripts/pin-release-compose.mjs", "scripts/check-release-dist.mjs", "scripts/build-app-out.mjs", "scripts/lock-changes.mjs"]) assert.ok(yml.includes(f) ? fs.existsSync(path.join(REPO, f)) : true, `${f} is referenced and missing`);
});

test("release.yml: the approver summary names what is being released on its right side, and the whole diff is uploaded uncut as signing-diff.txt", () => {
  const i = yml.indexOf("What changed in the signing path since the last published release, for the approver");
  const step = yml.slice(i, yml.indexOf("\n      - name: The whole signing-path diff", i));
  assert.match(step, /echo "### Signing path: \$\{prev:-nothing \(no published release yet\)\} -> \$head_label"/, "base -> release, not base against itself");
  assert.match(step, /dry run, commit \$\(git rev-parse --short=8 HEAD\)/, "a dry run names its commit");
  assert.match(step, /signing-diff\/signing-diff\.txt/);
  assert.match(yml, /name: signing-diff\n\s+path: signing-diff\/signing-diff\.txt/);
  assert.ok(yml.indexOf("name: signing-diff") < yml.indexOf("- name: Box files and vyre.tgz"), "uploaded from the prepare job, before any approval");
});

test("release.yml: the hosted phone app is sealed for a stable release only (its manifest takes x.y.z, and a prerelease is never served there)", () => {
  const i = yml.indexOf("Seal and sign the hosted phone app");
  const step = yml.slice(i, yml.indexOf("\n      - name:", i + 10) > 0 ? yml.indexOf("\n      - name:", i + 10) : undefined);
  assert.match(step, /if: env\.CHANNEL == 'stable'/);
  const upload = yml.slice(yml.indexOf("- uses: actions/upload-artifact", i), yml.indexOf("- uses: actions/upload-artifact", i) + 400);
  assert.match(upload, /if: env\.CHANNEL == 'stable'/, "and so is its upload");
});
