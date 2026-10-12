// @ts-check
// When the Space helper cannot regenerate a Space's compose file it says why: docker's exit code and the first line the generator printed, cut down because they come from a process in a container
// and are shown to a person and read by vyred. Before, docker's error was thrown away and every failure read "the compose file could not be regenerated". Same rig as test/space-helper.test.js.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rig, opts } from "./space-helper-rig.js";

test("space helper: a generator that dies says its exit code and a clean, capped first line; a path into root's folders is cut to its last name", opts, async t => {
  const r = rig(t);
  await r.prime();
  const priv = path.join(r.SP, "private");
  // A long line with control characters, a bell, an escape, non-ASCII and a path into root's private folder; a second line that must not appear.
  const evil = `Error: \u0007cannot import \u001b[31m${priv}/spaces/harlow/compose.yml \u00e9\u00e8 ${"x".repeat(400)}\nsecond line SECRET`;
  r.flag("gen-fails", evil);
  r.flag("gen-exit", "137");
  const id = r.ask("up harlow\n");
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  const st = r.status(id);
  assert.notEqual(st.state, "ok", JSON.stringify(st));
  assert.match(st.message, /^the compose file could not be regenerated: docker exit 137, Error/);
  assert.match(st.message, /compose\.yml/, "the last name of the path stays");
  assert.ok(!st.message.includes("private"), "no path into root's folders: " + st.message);
  assert.ok(!st.message.includes("SECRET"), "only the first line");
  assert.match(st.message, /^[\x20-\x7e]*$/, "plain printable ASCII, one line");
  assert.ok(st.message.length <= 240, st.message.length + "");
  assert.ok(st.message.length > 100, "the line is kept, not dropped");
  assert.deepEqual(fs.readdirSync(priv).filter(n => /^gen-err\./.test(n)), [], "no error file is left in root's folder");
});

test("space helper: with no valid image id recorded the failure says so", opts, async t => {
  const r = rig(t);
  await r.prime();
  fs.rmSync(path.join(r.SP, "private", "image"), { force: true });
  const id = r.ask("up harlow\n");
  await r.helper();
  const st = r.status(id);
  assert.notEqual(st.state, "ok");
  assert.match(st.message, /the compose file could not be regenerated: no valid image id is recorded yet/);
});
