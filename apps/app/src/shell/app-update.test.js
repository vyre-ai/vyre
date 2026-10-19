// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DOWNLOADING, compareVersions, downloadUrl, latestAppRelease, pickAppRelease, runAppUpdate } from "./app-update.js";

const dmgs = (/** @type {string} */ v) => [{ name: "Vyre-aarch64.dmg" }, { name: "Vyre-x86_64.dmg" }, { name: `Vyre-${v}-aarch64.dmg` }, { name: "vyre-linux-x64.tar.gz" }];
const LIST = [
  { tag_name: "v0.6.3-rc.1", prerelease: true, assets: dmgs("0.6.3-rc.1") },
  { tag_name: "v0.6.2", assets: dmgs("0.6.2") },
  { tag_name: "v0.6.1", assets: dmgs("0.6.1") },
  { tag_name: "v0.6.4", draft: true, assets: dmgs("0.6.4") },
  { tag_name: "v0.6.5", assets: [{ name: "vyre-linux-x64.tar.gz" }] },
];

test("versions compare by number, and a stable release is newer than its own pre-releases", () => {
  assert.ok(compareVersions("0.6.2", "0.6.1") > 0);
  assert.ok(compareVersions("v0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.6.2", "0.6.2-rc.1") > 0);
  assert.equal(compareVersions("0.6.2", "v0.6.2"), 0);
  assert.equal(compareVersions("nonsense", "0.6.2"), 0);
});

test("the Mac app is offered the newest stable release that has a dmg for this Mac: no draft, no pre-release, no release without a Mac app", () => {
  assert.deepEqual(pickAppRelease(LIST, "0.6.1", "aarch64"), { version: "0.6.2", url: "https://github.com/vyre-ai/vyre/releases/download/v0.6.2/Vyre-aarch64.dmg" });
  assert.deepEqual(pickAppRelease(LIST, "0.6.1", "x86_64")?.url, "https://github.com/vyre-ai/vyre/releases/download/v0.6.2/Vyre-x86_64.dmg");
  assert.deepEqual(pickAppRelease(LIST, "0.6.1", null), { version: "0.6.2", url: "https://github.com/vyre-ai/vyre/releases/tag/v0.6.2" }, "an unknown chip gets the release's page, which lists both");
  assert.equal(pickAppRelease(LIST, "0.6.2", "aarch64"), null, "current");
  assert.equal(pickAppRelease(LIST, "", "aarch64"), null, "no version from the shell: nothing to compare");
  assert.equal(pickAppRelease(null, "0.6.1", "aarch64"), null);
  assert.equal(downloadUrl("v0.6.2", "aarch64"), "https://github.com/vyre-ai/vyre/releases/download/v0.6.2/Vyre-aarch64.dmg");
});

test("the release list is read from GitHub; when it cannot be, the version the server says is out is used, stable only", async () => {
  /** @type {string[]} */ const asked = [];
  const ok = /** @type {any} */ (async (/** @type {string} */ url) => { asked.push(url); return { ok: true, json: async () => LIST }; });
  assert.deepEqual(await latestAppRelease({ fetch: ok, current: "0.6.1", arch: "aarch64" }), { version: "0.6.2", url: "https://github.com/vyre-ai/vyre/releases/download/v0.6.2/Vyre-aarch64.dmg" });
  assert.match(asked[0], /^https:\/\/api\.github\.com\/repos\/vyre-ai\/vyre\/releases/);
  const down = /** @type {any} */ (async () => { throw new TypeError("Load failed"); });
  assert.deepEqual(await latestAppRelease({ fetch: down, current: "0.6.1", arch: "x86_64", hint: "0.6.2" }), { version: "0.6.2", url: "https://github.com/vyre-ai/vyre/releases/download/v0.6.2/Vyre-x86_64.dmg" });
  assert.equal(await latestAppRelease({ fetch: down, current: "0.6.1", arch: "x86_64", hint: "0.6.3-rc.1" }), null, "a pre-release hint is not a Mac app");
  assert.equal(await latestAppRelease({ fetch: down, current: "0.6.2", hint: "0.6.2" }), null);
  assert.equal(await latestAppRelease({ fetch: ok, current: undefined }), null);
});

test("Update shows Downloading, hands the dmg to the browser, and ends with the steps that finish it", async () => {
  /** @type {any[]} */ const steps = [];
  /** @type {string[]} */ const opened = [];
  const release = { version: "0.6.2", url: "https://github.com/vyre-ai/vyre/releases/download/v0.6.2/Vyre-aarch64.dmg" };
  const out = await runAppUpdate({ open: async (u) => { opened.push(u); return { ok: true }; }, release, onStep: (s) => steps.push(s), setTimeout: () => 0 });
  assert.deepEqual(opened, [release.url]);
  assert.deepEqual(steps[0], { busy: true, line: DOWNLOADING });
  assert.equal(out.ok, true);
  assert.match(out.line, /downloading Vyre 0\.6\.2\. Open the downloaded Vyre and drag it to Applications/);
  assert.deepEqual(steps[1], { busy: false, line: out.line, ok: true });
  assert.doesNotMatch(out.line, /—/);
});

test("Update never does nothing: a refusal, a missing bridge and a shell that never answers each end in a plain error with where to get it", async () => {
  const release = { version: "0.6.2", url: "https://x" };
  const refused = await runAppUpdate({ open: async () => { throw new Error("Your Mac did not open your browser."); }, release, setTimeout: () => 0 });
  assert.deepEqual([refused.ok, refused.line], [false, "The download did not start (your Mac did not open your browser). Get Vyre 0.6.2 from github.com/vyre-ai/vyre/releases and drag it to Applications."]);
  const none = await runAppUpdate({ open: null, release });
  assert.equal(none.ok, false);
  assert.match(none.line, /this window cannot open your browser/);
  /** @type {(() => void) | null} */ let fire = null;
  /** @type {any[]} */ const steps = [];
  const hung = runAppUpdate({ open: () => new Promise(() => {}), release, onStep: (s) => steps.push(s), setTimeout: (f) => { fire = f; return 0; } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(steps, [{ busy: true, line: DOWNLOADING }], "still showing Downloading while it waits");
  /** @type {any} */ (fire)();
  const out = await hung;
  assert.equal(out.ok, false);
  assert.match(out.line, /the app did not answer/);
  assert.equal(steps.at(-1).busy, false);
});
