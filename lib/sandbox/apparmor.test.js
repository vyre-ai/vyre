import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { wallSteps, wallUninstallSteps, PROFILE, PROFILE_PATH } from "./apparmor.js";

const host = ({ files = [], restricted = "0" } = {}) => ({ platform: "linux", has: p => files.includes(p), readFile: () => `${restricted}\n` });

test("no steps off Linux, and none when bubblewrap is there and nothing is restricted", () => {
  assert.deepEqual(wallSteps({ platform: "darwin" }), []);
  assert.deepEqual(wallSteps(host({ files: ["/usr/bin/bwrap"] })), []);
});

test("a Debian box without bubblewrap installs it, and says so otherwise", () => {
  const s = wallSteps(host({ files: ["/usr/bin/apt-get"] }));
  assert.deepEqual(s[0].argv, ["apt-get", "install", "-y", "bubblewrap"]);
  assert.equal(s[0].optional, true);
  assert.match(wallSteps(host())[0].text, /install bubblewrap/);
});

test("where user namespaces are restricted, a profile for bwrap alone is written and loaded", () => {
  const s = wallSteps(host({ files: ["/usr/bin/bwrap", "/usr/sbin/apparmor_parser"], restricted: "1" }));
  assert.equal(s[0].path, PROFILE_PATH);
  assert.equal(s[0].content, PROFILE);
  assert.deepEqual(s[1].argv, ["apparmor_parser", "-r", PROFILE_PATH]);
  assert.match(PROFILE, /profile vyre-bwrap \/usr\/bin\/bwrap flags=\(unconfined\)/);
  assert.match(PROFILE, /\buserns,/);
  assert.ok(!/\bcapability\b|network|ptrace/.test(PROFILE.replace(/#.*$/gm, "")), "the profile grants user namespaces and nothing else");
});

test("the profile is not written when the system already ships one for bwrap", () => {
  assert.deepEqual(wallSteps(host({ files: ["/usr/bin/bwrap", "/usr/sbin/apparmor_parser", "/etc/apparmor.d/bwrap-userns-restrict"], restricted: "1" })), []);
});

test("uninstall unloads and removes only the profile Vyre wrote", () => {
  const s = wallUninstallSteps();
  assert.deepEqual(s.map(x => x.do), ["run", "remove"]);
  assert.equal(s[1].path, PROFILE_PATH);
});

test("when the profile will not unload, uninstall says the file is gone but it may stay loaded until a reboot", async () => {
  const { apply } = await import("../../core/names/system.js");
  const lines = [];
  const removed = [];
  const fs = { rmSync: p => removed.push(p) };
  const exec = argv => { if (argv[0] === "apparmor_parser") throw new Error("apparmor_parser: profile not loaded"); };
  const r = await apply(wallUninstallSteps(), { dryRun: false, out: l => lines.push(l), exec, fs });
  assert.deepEqual(removed, [PROFILE_PATH], "the file is removed anyway");
  assert.ok(lines.some(l => /The profile file is removed, but the profile may stay loaded until the next reboot\./.test(l)), lines.join(" | "));
  assert.equal(r.failed.length, 1);
});
