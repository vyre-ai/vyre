// @ts-check
// native fill tests: the Node side only, with a fake type helper that records hashes of what it
// was handed. Nothing here types into an app. The password is a canary that may appear only on
// the helper's stdin.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fillNative, hostsOf, appsOf, appLabel } from "./native.js";
import { Helper } from "./mac/helper.js";
import { writeFakes } from "./mac/fakes.js";
import { SCRATCH } from "../../test/scratch.mjs";

const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const PW = `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;

function rig(t, typeMode = "ok") {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-native-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = writeFakes(dir, { typeMode });
  const rows = {
    "site-login": { name: "site-login", kind: "login", url: "https://mail.example.com/login", hosts: "[]" },
    "app-login": { name: "app-login", kind: "login", hosts: "[]", meta: JSON.stringify({ apps: ["com.example.Notes"] }) },
    "bare-login": { name: "bare-login", kind: "login", hosts: "[]" },
    "api-token": { name: "api-token", kind: "api-key", hosts: "[]" },
  };
  const vault = { row: n => rows[n], fields: async () => ({ username: "alex@example.com", password: PW }) };
  const helper = new Helper({ name: "type", dir, command: f.helpers.type });
  const recorded = () => JSON.parse(fs.readFileSync(f.state.type, "utf8"));
  return { vault, helper, recorded };
}

const safari = { bundle: "com.apple.Safari", pid: 4242 };

test("a browser gets the login's exact origins; the value goes to stdin and never comes back", async t => {
  const { vault, helper, recorded } = rig(t);
  const out = await fillNative({ vault, helper, platform: "darwin", name: "site-login", app: safari });
  assert.deepEqual(out, { filled: ["username", "password"], via: "ax", app: "com.apple.Safari" });
  assert.ok(!JSON.stringify(out).includes(PW));
  const r = recorded();
  assert.equal(r.password, sha(PW), "the helper got the password on stdin");
  assert.deepEqual(r.hosts, ["https://mail.example.com"]);
  assert.equal(r.browser, "safari");
  assert.equal(r.pid, 4242);
});

test("an app fills only when the login lists its bundle id", async t => {
  const { vault, helper, recorded } = rig(t);
  const ok = await fillNative({ vault, helper, platform: "darwin", name: "app-login", app: { bundle: "com.example.Notes", pid: 7 } });
  assert.deepEqual(ok.filled, ["username", "password"]);
  assert.equal(recorded().browser, null);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "app-login", app: { bundle: "com.example.Other", pid: 7 } }), /not set up for Other/);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "bare-login", app: { bundle: "com.example.Notes", pid: 7 } }), /not set up/);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "bare-login", app: safari }), /no web address/);
});

test("refusals: not a login, bad app, off a Mac, and the helper's own words", async t => {
  const { vault, helper } = rig(t);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "api-token", app: safari }), /no login named/);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "nope", app: safari }), /no login named/);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "site-login", app: { bundle: "bad id;", pid: 1 } }), /bundle id/);
  await assert.rejects(fillNative({ vault, helper, platform: "darwin", name: "site-login", app: { bundle: "com.apple.Safari", pid: 0 } }), /bundle id/);
  await assert.rejects(fillNative({ vault, helper, platform: "linux", name: "site-login", app: safari }), /on a Mac only/);
  await assert.rejects(fillNative({ vault, helper: null, platform: "darwin", name: "site-login", app: safari }), /swiftc/);

  for (const mode of ["not_trusted", "wrong_origin", "app_changed"]) {
    const r = rig(t, mode);
    await assert.rejects(fillNative({ vault: r.vault, helper: r.helper, platform: "darwin", name: "site-login", app: safari }),
      e => e.code === mode && e.message === `fixed words for ${mode}` && !e.message.includes(PW));
  }
});

test("hostsOf, appsOf and appLabel", () => {
  assert.deepEqual(hostsOf({ url: "https://a.example.com/x", hosts: '["https://b.example.com"]' }).sort(), ["https://a.example.com", "https://b.example.com"]);
  assert.deepEqual(appsOf({ apps: '["com.example.A"]' }), ["com.example.A"]);
  assert.deepEqual(appsOf({ meta: { apps: ["com.example.B", 3] } }), ["com.example.B"]);
  assert.equal(appLabel("com.apple.Safari"), "Safari");
  assert.equal(appLabel(""), "the app");
});
