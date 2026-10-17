// @ts-check
// The agent's Chrome profile: Chrome's own password manager, autofill and leak check are off, nothing offers to save a password, and downloads go to one fixed folder
// and are never opened for the agent. The holder (image/agentd-chrome.py) writes these into the profile before it starts Chrome, on every start, so a profile
// that was made earlier, or that has been through sleep and wake, has them too. The holder needs Docker and a display to run, so this test reads it.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOLDER = fs.readFileSync(path.join(HERE, "image", "agentd-chrome.py"), "utf8");

/** The holder's PREFS literal, read as JSON. The folder it names for downloads is a variable in the holder; here it is a marker. */
function prefs() {
  const m = /^PREFS = (\{.*?\n\})$/ms.exec(HOLDER);
  assert.ok(m, "the holder has a PREFS table");
  const json = m[1].replace(/\bFalse\b/g, "false").replace(/\bTrue\b/g, "true").replace(/\bDOWNLOADS\b/g, '"<downloads>"').replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json);
}

test("chrome profile: the password manager, its offer to save, its leak check and autofill are all off", () => {
  const p = prefs();
  assert.equal(p.credentials_enable_service, false, "Chrome does not offer to save passwords");
  assert.equal(p.credentials_enable_autosignin, false);
  assert.equal(p.profile.password_manager_enabled, false);
  assert.equal(p.profile.password_manager_leak_detection, false);
  assert.equal(p.autofill.profile_enabled, false, "no saved addresses");
  assert.equal(p.autofill.credit_card_enabled, false, "no saved cards");
  assert.equal(p.signin.allowed, false, "no sign-in to a Google account, so no synced passwords");
  assert.equal(p.sync.requested, false);
});

test("chrome profile: downloads go to one fixed folder, with no question and no automatic opening", () => {
  const p = prefs();
  assert.equal(p.download.default_directory, "<downloads>");
  assert.equal(p.savefile.default_directory, "<downloads>");
  assert.equal(p.download.prompt_for_download, false);
  assert.equal(p.download.extensions_to_open, "", "no file type opens by itself when it lands");
  assert.equal(p.plugins.always_open_pdf_externally, false);
  assert.match(HOLDER, /^DOWNLOADS = "\/var\/lib\/vyre\/downloads\/ag%d" % N$/m, "the folder is built from the agent's own uid, not from anything a client sends");
});

test("chrome profile: the settings are written on every start, before Chrome reads the profile, so sleep and wake keep them", () => {
  const merged = HOLDER.indexOf("merge(prefs, PREFS)");
  const written = HOLDER.indexOf("json.dump(prefs, f)");
  const started = HOLDER.indexOf("subprocess.Popen(");
  assert.ok(merged > 0 && written > merged && started > written, "merged, written, then Chrome starts");
  // an earlier profile is read and merged into, never thrown away: the logins and tabs of a woken agent stay
  assert.match(HOLDER, /json\.load\(f\)/);
  assert.match(HOLDER, /"--restore-last-session"/, "waking reopens the tabs where they were");
  assert.doesNotMatch(HOLDER, /os\.(remove|unlink)\(prefs_file\)|shutil\.rmtree/, "the profile is never wiped on start");
  // and the settings are the holder's own: nothing from the environment or a client's message reaches the table
  assert.doesNotMatch(HOLDER.slice(HOLDER.indexOf("PREFS = {"), HOLDER.indexOf("def merge")), /environ|argv|recv/);
});

test("chrome pages: the password and autofill pages are refused by Chrome's own policy, and the policy blocks nothing else of chrome://", () => {
  const docker = fs.readFileSync(path.join(HERE, "image", "Dockerfile"), "utf8");
  const m = /printf '%s\\n' (.*?)\n\s+> \/etc\/chromium\/policies\/managed\/vyre\.json/s.exec(docker);
  assert.ok(m);
  const policy = JSON.parse([...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).join(""));
  assert.equal(policy.PasswordManagerEnabled, false);
  assert.equal(policy.PasswordLeakDetectionEnabled, false);
  assert.equal(policy.AutofillAddressEnabled, false);
  assert.equal(policy.AutofillCreditCardEnabled, false);
  for (const u of ["chrome://password-manager", "chrome://settings/passwords", "chrome://settings/autofill"]) assert.ok(policy.URLBlocklist.includes(u), u);
  assert.ok(!policy.URLBlocklist.some((/** @type {string} */ u) => u === "chrome://*" || u === "*"), "other chrome:// pages stay open");
});
