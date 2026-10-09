// @ts-check
// The app module half of the Space helper, split into four files (one ran past the per-file time limit): this one is the catalog, its record and the requests. The rig and the fakes are test/space-helper-apps-rig.js.
// catalog, walled off the way a Space's store is. Run with sh against a temp folder; docker and nsenter are the fakes of test/space-helper-apps-rig.js (the Space helper's own fakes behind them), the
// generated compose file is the REAL one from core/appmods/host-plan.js. Linux only (stat -c). Real iptables, real Docker and a real DocuSeal need a box: see the live test, VYRE_APPMODS_LIVE=1.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appRig, lineOf } from "./space-helper-apps-rig.js";
import { opts, UID } from "./space-helper-rig.js";

const SECRET = /api_token=tok_|login_password=pw_|hook_token=|SECRET_KEY_BASE=[0-9a-f]{64}/;
/** A rig with the helper installed and the catalog recorded (the real DocuSeal line). */
async function ready(/** @type {import("node:test").TestContext} */ t, over = {}) {
  const r = appRig(t);
  for (const [k, v] of Object.entries(over)) r.flag(k, v);
  await r.prime();
  return r;
}
const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");


test("app helper: the catalog is recorded at install, field by field, from the image: the real DocuSeal line, its image pulled by digest", opts, async t => {
  const r = await ready(t);
  const line = r.catalogLine().trim();
  const f = line.split(" ");
  assert.equal(f.length, 13, line);
  assert.deepEqual(f.slice(0, 1).concat(f.slice(2, 7)), ["documents", "3000", "1536", "1.5", "512", "43001"]);
  assert.match(f[1], /^docuseal\/docuseal:[0-9.]+@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(f.slice(7), ["docuseal-bootstrap.rb", "bin/rails+runner", "api_token+login_password", "/", "200+302", "120"]);
  assert.ok(!(fs.existsSync(path.join(r.F, "pulled")) && read(path.join(r.F, "pulled")).includes("documents")), "recording the catalog pulls no app image: a server that never installs an app does not carry one");
  assert.equal(fs.statSync(path.join(r.priv, "app-modules")).mode & 0o777, 0o600);
});

test("app helper: a catalog line that fails any field records NO app, and the install still succeeds (Twenty does not wait on an app)", opts, async t => {
  const bad = {
    "an image with no digest": lineOf({ image: "docuseal/docuseal:3.3.1" }), "an uppercase digest": lineOf({ image: "docuseal/docuseal@sha256:" + "E".repeat(64) }),
    "an image with a space": lineOf({ image: "documents/docu seal@sha256:" + "e".repeat(64) }), "a name with a capital": lineOf({ name: "Docuseal" }), "a one letter name": lineOf({ name: "d" }),
    "a port of 0": lineOf({ port: "0" }), "a port over 65535": lineOf({ port: "65536" }), "a port with a leading zero": lineOf({ port: "03000" }),
    "memory under 64": lineOf({ mem: "63" }), "memory over 8192": lineOf({ mem: "8193" }), "cpus of 0": lineOf({ cpus: "0" }), "cpus over 8": lineOf({ cpus: "8.5" }), "cpus in words": lineOf({ cpus: "one" }),
    "pids under 32": lineOf({ pids: "31" }), "a hook port under 43000": lineOf({ hook: "42999" }), "a hook port over 43999": lineOf({ hook: "44000" }),
    "a script with a slash": lineOf({ script: "../x.rb" }), "a script with a capital": lineOf({ script: "Boot.rb" }), "a command word with a quote": lineOf({ exec: "bin/rails+run'ner" }),
    "a command with a dollar": lineOf({ exec: "sh+$HOME" }), "an output name with a dash": lineOf({ outs: "api-token" }), "a script and no command": lineOf({ exec: "-" }),
    "a health path with no slash": lineOf({ hpath: "health" }), "a health code with letters": lineOf({ hok: "2xx" }), "a start time of 0": lineOf({ hstart: "0" }), "a start time over 600": lineOf({ hstart: "601" }),
    "twelve fields": lineOf().split(" ").slice(0, 12).join(" "), "fourteen fields": lineOf() + " x",
  };
  const r = appRig(t);
  for (const [what, line] of Object.entries(bad)) {
    r.flag("hostplan-list", line + "\n");
    const p = /** @type {any} */ (await r.run(["space-helper", "install"]));
    assert.equal(p.code, 0, `${what}: the install still goes through: ${p.out}`);
    assert.equal(r.catalogLine(), "", `${what}: nothing is recorded`);
    assert.match(p.out, /no app modules were recorded/, what);
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /no such app/, what);
  }
});

test("app helper: names and hook ports are unique across the catalog, and a hook port the vyre container already listens on is refused", opts, async t => {
  const a = lineOf(), b = lineOf({ name: "other", hook: "43002" });
  const cases = {
    "the same name twice": [a, lineOf({ hook: "43002" })], "the same hook port twice": [a, lineOf({ name: "other" })],
  };
  for (const [what, lines] of Object.entries(cases)) {
    const r = appRig(t);
    r.flag("hostplan-list", lines.join("\n") + "\n");
    const p = /** @type {any} */ (await r.run(["space-helper", "install"]));
    assert.equal(p.code, 0, p.out);
    assert.equal(r.catalogLine(), "", `${what}: nothing is recorded`);
    assert.match(p.out, /listed twice|used by two apps/, what);
  }
  const ok = appRig(t);
  ok.flag("hostplan-list", [a, b].join("\n") + "\n");
  await ok.run(["space-helper", "install"]);
  assert.equal(ok.catalogLine().trim().split("\n").length, 2, "two distinct apps are both recorded");
  // vyre listens on 43001 (hex A7F9) already
  const lp = appRig(t);
  lp.flag("hostplan-list", a + "\n");
  lp.flag("listen", "  sl  local_address rem_address   st tx_queue\n   0: 00000000:A7F9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000\n   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000\n");
  const p = /** @type {any} */ (await lp.run(["space-helper", "install"]));
  assert.equal(p.code, 0, p.out);
  assert.equal(lp.catalogLine(), "");
  assert.match(p.out, /hook port 43001 is a port the vyre container already uses/);
  // an app whose image cannot be pulled fails its app-up, with nothing created
  const pf = await ready(t, { "pull-fails-app": "1" });
  const o = await pf.appUp();
  assert.equal(o.st.state, "failed");
  assert.match(o.st.message, /image could not be pulled/);
  assert.ok(!/compose .* (create|up)/.test(pf.calls()));
});

test("app helper: a request is `app-up|app-stop|app-down <module>` for a recorded module and nothing else", opts, async t => {
  const r = await ready(t);
  const bad = {
    "a module that is not recorded": "app-up nothere\n", "a capital": "app-up Docuseal\n", "a dot": "app-up docu.seal\n", "a slash": "app-up ../x\n", "an equals sign": "app-up documents=1\n",
    "a space": "app-up docu seal\n", "two words after": "app-up documents now\n", "one letter": "app-up d\n", "a Space name": "app-up harlow\n", "a Twenty name": "app-up documents-twenty\n",
    "an unknown verb": "app-purge documents\n", "app-up with a flag": "app-up --privileged\n", "a verb in capitals": "APP-UP documents\n", "no newline": "app-up documents", "two lines": "app-up documents\napp-down documents\n",
  };
  const asked = Object.entries(bad).map(([what, text]) => [what, r.ask(text)]);
  await r.helper();
  for (const [what, id] of asked) {
    const st = r.status(id);
    assert.ok(st && st.state === "failed", `${what}: ${JSON.stringify(st)}`);
  }
  assert.ok(!/compose .* (create|up)/.test(r.calls()), "nothing was started by any of them");
  // requests that are not the daemon's: a mode that allows others, a stale one
  const odd = Object.entries({ "a request with group access": { mode: 0o660 }, "a request older than five minutes": { age: 400 } }).map(([what, opt]) => [what, r.ask("app-up documents\n", opt)]);
  await r.helper();
  for (const [what, id] of odd) {
    const st = r.status(id);
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /refused/, what);
  }
  assert.ok(!/compose .* (create|up)/.test(r.calls()), "nor by these");
});
