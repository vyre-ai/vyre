// @ts-check
// The vault and Drive actions on the kernel: the registry fragment, what a credential use costs, and the path and segment guards.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ACTIONS, credentialAction, safePath, segment } from "./uses.js";
import { overlaps, assertPlacement, writeReference, sealDir } from "./placement.js";
import { tmp, SPACE } from "./testing.js";

test("the registry fragment: unique actions, reveal is admin, delivery and sharing are outward, only the fill step is sealed_ok", () => {
  assert.equal(new Set(ACTIONS.map(a => a.action)).size, ACTIONS.length);
  const by = Object.fromEntries(ACTIONS.map(a => [a.action, a]));
  assert.equal(by["seal.reveal"].risk, "admin"); assert.equal(by["seal.deliver"].risk, "outward.send"); assert.equal(by["vault.share"].risk, "outward.share"); assert.equal(by["drive.delete"].risk, "outward.delete");
  assert.deepEqual(ACTIONS.filter(a => a.sealed_ok).map(a => a.action), ["seal.use"]);
  for (const a of ACTIONS) assert.match(a.action, /^[a-z]+\.[a-z]+$/);
});

test("placement: the sealing folder is private and outside every sandbox root, as the box compose file lays it out", () => {
  const compose = fs.readFileSync(path.resolve(import.meta.dirname, "../../box/compose.yml"), "utf8");
  const mounts = [...compose.matchAll(/^\s+- (vyre-[a-z-]+):(\/[^\s:]+)/gm)].map(m => ({ vol: m[1], at: m[2] }));
  const at = v => mounts.find(m => m.vol === v)?.at;
  const home = at("vyre-home");
  assert.equal(home, "/home/vyre");
  const dir = sealDir(`${home}/.vyre`), sandboxes = [at("vyre-work"), at("vyre-agent-home"), at("vyre-accounts"), "/home/vyre-agent", "/home/acct", "/work"].filter(Boolean);
  assert.deepEqual(overlaps(dir, sandboxes), [], "no sandbox root holds the sealing folder");
  assert.deepEqual(overlaps("/work/seal", sandboxes).length > 0, true, "the check does fire");
  // The tailscale container mounts only /work (VyreDrive), never vyre-home.
  const tail = compose.slice(compose.indexOf("tailscale:"), compose.indexOf("\n  vyre:")).split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  assert.ok(!tail.includes("vyre-home"));
});

test("placement: other users cannot read the folder, and a reference file holds the output's name and slots but never a value", () => {
  const d = tmp("place"); fs.chmodSync(d, 0o755);
  assert.throws(() => assertPlacement(d, []), /readable by other users/);
  fs.chmodSync(d, 0o700); assertPlacement(d, []);
  assert.throws(() => assertPlacement(d, [path.dirname(d)]), /overlap/);
  const f = writeReference(d, "Engagement letter (Jane).docx", { output_ref: `vyre://${SPACE}/sealed-output/out_abc`, sealed_slots: [{ slot: "ssn", class: "us-ssn" }] });
  const t = fs.readFileSync(f, "utf8");
  assert.ok(f.endsWith("Engagement_letter__Jane_.docx.sealed.json")); assert.match(t, /out_abc/); assert.ok(!/\d{3}-\d{2}-\d{4}/.test(t));
});

test("K3 item 2: what a credential is used for decides its risk: a read is a read, any other request is outward", async () => {
  const by = Object.fromEntries(ACTIONS.map(a => [a.action, a]));
  const act = (kind, method) => by[credentialAction(kind, method)];
  assert.equal(act("fill").risk, "write"); assert.equal(act("totp").risk, "write");
  assert.equal(act("api", "GET").risk, "read"); assert.equal(act("api", "head").risk, "read");
  assert.equal(act("api").risk, "read");
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "PROPFIND", ""]) assert.equal(act("api", m).risk, "outward.send", JSON.stringify(m));
  assert.equal(act("surprise").risk, "outward.send", "an unknown kind is outward");
  assert.equal(act("run").risk, "admin");
  assert.equal(credentialAction("api", "POST"), "vault.call");
});

test("K3 item 3: dot segments, encoded dots and slashes, backslashes and control characters never reach a path or a URN", () => {
  for (const bad of ["../x", "a/../../credential/x", "a/./b", "a/%2e%2e/b", "a/%2E%2E/b", "a%2fb", "a%5cb", "a\\b", "a\u0000b", "a\nb", "/abs", "a//b", "", "..", "a/..", "\u2024\u2024/x"]) assert.throws(() => safePath(bad), /bad_input/, JSON.stringify(bad));
  for (const ok of ["projects/jane/engagement.pdf", "a b/c-d_e.txt", "..hidden/x", "x..y/z"]) assert.equal(safePath(ok), ok);
  for (const bad of ["a/b", "..", ".", "%2e", "a%2fb", "a\\b", ""]) assert.throws(() => segment(bad), /bad_input/, bad);
});

test("R-5: Windows reserved names and trailing dots or spaces are refused in a path", () => {
  for (const bad of ["a/CON", "a/nul.txt", "a/b.", "a/b ", "COM1", "lpt9.log", "x/Aux"]) assert.throws(() => safePath(bad), /bad_input/, bad);
  for (const ok of ["a/console.txt", "a/comma", "a/b.c"]) assert.equal(safePath(ok), ok);
});
