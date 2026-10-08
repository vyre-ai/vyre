// @ts-check
// The release workflow produces what the updater reads (launch): the pin script, the Ed25519 signature every updater verifies, the gate, in that order,
// and the cosign identity unchanged (a keyless `cosign sign --yes` in this workflow, which is what the boxes' identity regex names).
import "../scripts/mac-test-guard.mjs";
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
  assert.match(yml, /check-release-dist\.mjs dist --pulled --modules --installer --android --android-release --setup \$\{MAC_FLAG:-\} --pubkey/, "a publish is gated with images required and the signature checked against the pinned key");
  assert.ok(!/\$\{VYRE_IMAGE:-\$BOX\}/.test(yml), "the old sed that kept a variable is gone");
  // The identity boxes demand is this workflow at a version tag: images are signed here with `cosign sign --yes` (keyless).
  assert.match(yml, /cosign sign --yes "\$ref"/);
  const cosignRegex = fs.readFileSync(path.join(REPO, "scripts/install-box.sh"), "utf8").match(/^COSIGN_ID='(.*)'$/m)?.[1] || "";
  assert.ok(cosignRegex.includes("workflows/release\\.yml@refs/tags/v"), "the installer's identity names this workflow file at a version tag");
});

test("release.yml: a publishing run builds and signs only a commit on main or the 0.2 stage line, or a proper patch checked by check-release-lineage, all before the notes step", () => {
  const guard = yml.indexOf("git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main");
  assert.ok(guard > 0 && guard < yml.indexOf("- name: Version, channel, notes"));
  assert.match(yml, /origin\/work\/stage-0\.2/);
  assert.match(yml, /node scripts\/check-release-lineage\.mjs "\$GITHUB_SHA" "\$GITHUB_REF_NAME"/);
  assert.match(yml, /\+refs\/heads\/hotfix\/\$GITHUB_REF_NAME:refs\/remotes\/origin\/hotfix\/\$GITHUB_REF_NAME/, "only this tag's own hotfix branch is fetched, not any hotfix/*");
  assert.doesNotMatch(yml, /hotfix\/\*/, "no wildcard over hotfix branches");
  assert.match(yml, /if: github\.event_name == 'push' && vars\.VYRE_RELEASES == 'go'\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n\s+run: \|\n\s+git fetch --no-tags origin main work\/stage-0\.2/);
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
  for (const p of [".github/workflows", "scripts/sign-manifest.mjs", "scripts/write-release-json.mjs", "scripts/pin-release-compose.mjs", "scripts/check-release-dist.mjs", "scripts/build-app-out.mjs", "scripts/strip-wrapper.mjs", "box/vyre", "apps/app/package-lock.json", "scripts/lock-changes.mjs", "core/vyre-core/release.js", "scripts/mac-app-package.sh", "scripts/mac-app", "scripts/install-mac-server.sh", "local/capsule/native/Lumen.entitlements", "local/capsule/native/build.sh", "local/capsule/native/Package.swift", "local/capsule/native/Package.resolved"]) assert.ok(step.includes(p), `the diff covers ${p}`);
  assert.match(step, /Lumen sources changed since the base: .*local\/capsule\/native\/Sources/, "the summary counts the changed Lumen source files");
  assert.match(step, /TRUNCATED/, "a truncated diff says so");
});

test("release.yml: the Windows installer is built in this run, required by the release job, and added to dist before SHA256SUMS is made and signed", () => {
  assert.match(yml, /\n  windows:\n    needs: prepare\n    uses: \.\/\.github\/workflows\/capsule-win\.yml/);
  assert.match(yml, /needs: \[prepare, images, manifests, app-web, windows, mac, android\]/);
  assert.match(yml, /needs\.windows\.result == 'success'/);
  const add = yml.indexOf("Add the Windows installer to dist"), sums = yml.indexOf("- name: release.json, SHA256SUMS");
  assert.ok(add > 0 && add < sums, "the installer is in dist before the signed list is made");
  assert.match(yml, /cp "\$RUNNER_TEMP\/windows\/\$exe" dist\/VyreSetup\.exe/);
});

test("release.yml: the Lumen Mac app is built in this run on every channel, and its dmgs reach dist Developer ID signed and notarized, or ad hoc signed and said to be sideloaded", () => {
  assert.match(yml, /\n  mac:\n    needs: prepare\n    uses: \.\/\.github\/workflows\/mac-app\.yml/);
  assert.match(yml, /sign: \$\{\{ needs\.prepare\.outputs\.publish == 'true' \}\}/, "the Apple environment is used on a publish only");
  assert.match(yml, /\(needs\.mac\.result == 'success' \|\| needs\.mac\.result == 'skipped'\)/, "a beta or rc run skips the Mac job and still releases");
  const add = yml.indexOf("Add the Lumen Mac files to dist"), sums = yml.indexOf("- name: release.json, SHA256SUMS");
  assert.ok(add > 0 && add < sums, "the dmgs are in dist before the signed list is made");
  const step = yml.slice(add, yml.indexOf("\n      - name:", add + 10));
  for (const f of ["Vyre-Lumen-$arch.dmg", "Vyre-Lumen-$arch.zip"]) assert.ok(step.includes(f), `${f} is copied into dist`);
  for (const k of ["signed=developer-id", "notarized=yes", "gatekeeper=accepted"]) assert.ok(step.includes(k), `a dmg needs ${k}`);
  assert.ok(step.includes("signed=adhoc"), "an ad hoc build is released too");
  assert.match(step, /sideload/, "and the notes say it is sideloaded");
  assert.match(step, /MAC_FLAG=--mac/, "the gate asks for the dmgs only when they were added");
  assert.match(yml, /--setup \$\{MAC_FLAG:-\} --pubkey/);
  // Apple secrets: none in release.yml at all. They live in the "apple" environment and only mac-app.yml's package step receives them.
  assert.ok(!yml.includes("APPLE_"), "release.yml names no Apple secret");
  const mac = fs.readFileSync(path.join(REPO, ".github/workflows/mac-app.yml"), "utf8");
  assert.match(mac, /environment: \$\{\{ inputs\.sign && 'apple' \|\| '' \}\}/);
  assert.ok(!/\n    secrets:/.test(mac), "mac-app.yml takes no secret from its caller");
  // Build and sign are two jobs: build has no environment and no secret; package (fresh checkout) is the only one with either.
  const buildJob = mac.slice(mac.indexOf("\n  build:\n"), mac.indexOf("\n  package:\n"));
  assert.ok(buildJob.length > 100 && !/environment:|secrets\.|APPLE_/.test(buildJob), "the build job holds no environment and no secret");
  assert.ok(buildJob.includes("build.sh app") && buildJob.includes("upload-artifact"), "the build job builds and uploads the unsigned app");
  const packageJob = mac.slice(mac.indexOf("\n  package:\n"), mac.indexOf("\n  collect:\n"));
  assert.match(packageJob, /needs: (build|\[build, web\])\n/);
  assert.ok(!/build\.sh|swiftc|xcodebuild|npm /.test(packageJob), "no build tool runs in the job that holds the secrets");
  assert.match(packageJob, /sh scripts\/mac-app-package\.sh/);
  assert.match(mac, /collect:\n[^\n]*\n    needs: package\n/);
  const pkg = mac.indexOf("- name: Package, sign if there is an identity");
  const refs = [...mac.matchAll(/secrets\.APPLE_[A-Z0-9_]+/g)].map(m => m.index);
  assert.equal(refs.length, 6);
  for (const r of refs) assert.ok(r > pkg && r < mac.indexOf("\n      - name:", pkg + 10), "an Apple secret is read only by the package step");
  // Its own push and dispatch triggers never sign: `sign` exists only as a workflow_call input, defaulting to false, so no environment and no secret.
  assert.match(mac, /sign:\n        description: [^\n]*\n        type: boolean\n        default: false/);
  // dispatch may take the version to stamp (a rehearsal), never anything that could turn signing on
  const dispatch = (mac.match(/workflow_dispatch:\n((?: {4}.*\n)*)/) || ["", ""])[1];
  assert.ok(!/\bsign\b|environment|secret/i.test(dispatch), "dispatch has no input that could turn signing on");
  const gate = yml.slice(add, yml.indexOf("\n      - name:", add + 10));
  assert.match(gate, /MAC_SIGNING: \$\{\{ vars\.MAC_SIGNING \}\}/);
  assert.match(gate, /\[ "\$MAC_SIGNING" = required \]/);
  assert.ok(gate.indexOf('"$MAC_SIGNING" = required') < gate.indexOf('cp "$RUNNER_TEMP/mac/$f"'), "a required signing failure is raised before anything is copied");
  for (const m of mac.matchAll(/^          (APPLE_[A-Z0-9_]+): (.*)$/gm)) assert.match(m[2], /inputs\.sign && secrets\.APPLE_[A-Z0-9_]+ \|\| ''/);
});

test("mac-app-package.sh: skip lines per missing secret, the dmg container signed, notarized and stapled, Gatekeeper checked and failing the build", () => {
  const sh = fs.readFileSync(path.join(REPO, "scripts/mac-app-package.sh"), "utf8");
  assert.match(sh, /skip: Developer ID signing and notarization/);
  // No secret is a command-line argument: no -P "$...", no --password, no keychain password from a variable, no Apple ID path.
  assert.ok(!/-P "\$/.test(sh) && !/--password/.test(sh) && !/security [^\n]*-p "\$/.test(sh) && !/-k "\$pw"/.test(sh), "no password on a command line");
  assert.match(sh, /-passin env:APPLE_DEVELOPER_ID_P12_PASSWORD/);
  assert.match(sh, /notarytool store-credentials vyre-notary --key/);
  assert.match(sh, /notarytool submit "\$1" --keychain-profile vyre-notary --keychain "\$kc"/);
  assert.ok(!/APPLE_APP_PASSWORD|APPLE_ID\b/.test(sh.replace(/#.*\n/g, "\n")), "no Apple ID password path");
  assert.match(sh, /skip: notarization/);
  assert.match(sh, /codesign --force --timestamp --sign "\$APPLE_DEVELOPER_ID_IDENTITY" --keychain "\$kc" "\$dmg"/, "the dmg is signed");
  assert.match(sh, /notarize "\$dmg"; xcrun stapler staple "\$dmg"/, "the dmg is notarized and stapled");
  assert.match(sh, /status: Accepted/, "the verdict is read, not just the exit status");
  for (const c of ['spctl -a -t exec -vv "$stage"', 'xcrun stapler validate "$stage"', 'spctl -a -t open --context context:primary-signature -vv "$dmg"', 'xcrun stapler validate "$dmg"']) assert.ok(sh.includes(c), c);
  assert.ok(!/stapler staple "\$dmg" \|\| true/.test(sh), "a failed staple is no longer ignored");
  assert.match(sh, /gatekeeper=%s/, "the status file records the Gatekeeper result");
});

test("release.yml: no step needs a secret or a file that does not exist: the only secret is the Ed25519 release key, and minisign is gone", () => {
  const secrets = [...new Set([...yml.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]))];
  // The Ed25519 release key, and the Android release keystore (the debug-signed APK is signed again with it on a publish): both only in the release job, which is the one in the protected environment.
  assert.deepEqual(secrets, ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD", "VYRE_RELEASE_SIGNING_KEY"]);
  const releaseJob = yml.indexOf("\n  release:\n");
  assert.ok(releaseJob > 0 && yml.indexOf("secrets.ANDROID_KEYSTORE_B64") > releaseJob, "the Android keystore is read only in the release job");
  assert.match(yml.slice(releaseJob, yml.indexOf("secrets.ANDROID_KEYSTORE_B64")), /environment: \$\{\{ needs\.prepare\.outputs\.publish == 'true' && 'release' \|\| '' \}\}/, "that job is the one in the release environment");
  assert.match(yml, /shred -u "\$ks"/, "the keystore file is deleted after use");
  assert.ok(!/echo[^\n]*ANDROID_KEY(STORE)?_(PASSWORD|B64)/.test(yml), "no secret is echoed");
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

test("release.yml: prepare refuses a release whose package, lockfile and plugin versions disagree", () => {
  const i = yml.indexOf('the tag says $version but package.json says $pkg');
  assert.ok(i > 0 && yml.indexOf("node scripts/bump-version.mjs --check", i) > i);
  assert.ok(yml.indexOf("node scripts/bump-version.mjs --check") < yml.indexOf("- name: Box files and vyre.tgz"));
});

test("release.yml: the signed module list is checked against the tarball and the built image before the release is signed", () => {
  const i = yml.indexOf("The signed module list matches the tarball and the BUILT image");
  assert.ok(i > 0 && i < yml.indexOf("release.json, SHA256SUMS, and on a publish the Ed25519 signature"), "checked before SHA256SUMS is signed");
  const step = yml.slice(i, yml.indexOf("\n      - name:", i + 20));
  assert.match(step, /verify-list-trees\.mjs "\$d" dist\/modules\.json/);
  assert.match(step, /docker cp "\$id:\/opt\/vyre\/\."/);
  assert.match(step, /verify-list-trees\.mjs "\$RUNNER_TEMP\/image-root" dist\/modules\.json/);
});

test("release.yml: a tag that already has a release is refused in prepare before anything is built, a patch run shows the whole diff, and the Mac status is bound to the file hashes", () => {
  const guard = yml.indexOf("A tag that already has a release (published or draft) is never signed again");
  assert.ok(guard > 0 && guard < yml.indexOf("The tag's commit is on main or the 0.2 stage line") && guard < yml.indexOf("- name: Version, channel, notes"), "the guard is the first step after setup");
  assert.match(yml.slice(guard, guard + 900), /gh release list .*--json tagName/);
  assert.match(yml, /PATCH RELEASE from hotfix\/\$TAG, NOT from main/);
  assert.match(yml, /git diff "\$base" HEAD > signing-diff\/whole-diff\.txt/);
  assert.match(yml, /sed -n "s\/\^sha256:\$f=\/\/p" "\$st"/, "the release job recomputes the hashes the status lists");
  const mac = fs.readFileSync(path.join(REPO, ".github/workflows/mac-app.yml"), "utf8");
  assert.ok(!/\$\{\{ *inputs\.version *\}\}"/.test(mac.replace(/IN_VERSION: \$\{\{ inputs\.version \}\}/g, "")), "no inputs expression inside a script");
  assert.match(mac, /printf 'sha256:%s=%s/);
});

test("release.yml: the Android APK is built in this run, checked, required in dist under both names, and the notes say it is sideloaded", () => {
  assert.match(yml, /\n  android:\n    needs: prepare\n/);
  const job = yml.slice(yml.indexOf("\n  android:\n"), yml.indexOf("\n  # Join the per-arch digests"));
  assert.match(job, /assembleRelease/);
  assert.ok(!/secrets\./.test(job) && !/environment:/.test(job), "the Android job holds no secret and no environment");
  assert.match(job, /Vyre-android\.apk/);
  assert.match(job, /check-apk-nothing-central/);
  const add = yml.indexOf("Add the Android app to dist"), sums = yml.indexOf("- name: release.json, SHA256SUMS");
  assert.ok(add > 0 && add < sums, "the APK is in dist before the signed list is made");
  const step = yml.slice(add, yml.indexOf("\n      - name:", add + 10));
  assert.match(step, /refusing to release without it/);
  assert.match(step, /sideload/);
});
