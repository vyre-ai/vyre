// @ts-check
// When the Space helper cannot regenerate a Space's compose file it says why: docker's exit code and the first line the generator printed, cut down because they come from a process in a container
// and are shown to a person and read by vyred. Before, docker's error was thrown away and every failure read "the compose file could not be regenerated". Same rig as test/space-helper.test.js.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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
  assert.deepEqual(fs.readdirSync(priv).filter(n => /^gen-(err|rc)\./.test(n)), [], "no error file is left in root's folder");
});

test("space helper: with no valid image id recorded and no running container to read one from, the failure says so", opts, async t => {
  const r = rig(t);
  await r.prime();
  fs.rmSync(path.join(r.SP, "private", "image"), { force: true });
  r.flag("ctr-down");
  const id = r.ask("up harlow\n");
  await r.helper();
  const st = r.status(id);
  assert.notEqual(st.state, "ok");
  assert.match(st.message, /the compose file could not be regenerated: no valid image id is recorded yet/);
});

test("space helper: the generator's stderr is kept in root's folder only, with a size limit, and nothing is written in /tmp", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.flag("gen-fails", "x".repeat(400_000));
  r.flag("gen-exit", "1");
  const before = new Set(fs.readdirSync("/tmp"));
  const id = r.ask("up harlow\n");
  await r.helper();
  const st = r.status(id);
  assert.match(st.message, /^the compose file could not be regenerated: /);
  assert.ok(st.message.length <= 240);
  assert.deepEqual(fs.readdirSync("/tmp").filter(n => !before.has(n) && /\.rc$|gen-err|gen-rc/.test(n)), [], "no file at a name derived from another in /tmp");
  const src = fs.readFileSync(new URL("../box/vyre", import.meta.url), "utf8");
  assert.ok(!/mktemp "\$SP_PRIV\/gen-err\.XXXXXX" 2>\/dev\/null \|\| mktemp\)/.test(src), "no shared-folder fallback");
  assert.match(src, /head -c 4096 >"\$ge"/, "the stderr file is size-limited");
});

test("space helper: a recorded image that is gone (a reinstalled server) is recorded again from the container that runs now, so the FIRST request for a Space's store works", opts, async t => {
  const r = rig(t);
  await r.prime();
  const running = "sha256:" + "a".repeat(64), stale = "sha256:" + "b".repeat(64);
  assert.equal(fs.readFileSync(path.join(r.SP, "private", "image"), "utf8").trim(), running, "the install recorded the running image");
  // The install before this one left its image id, and that image no longer exists.
  fs.writeFileSync(path.join(r.SP, "private", "image"), stale + "\n");
  r.flag("gone", stale);
  const id = r.ask("up harlow\n");
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  const st = r.status(id);
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.equal(fs.readFileSync(path.join(r.SP, "private", "image"), "utf8").trim(), running, "the record is the container's image again");
  // When the record is already current nothing is recorded again.
  const before = r.calls().split("\n").filter(l => /^pull /.test(l)).length;
  const id2 = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(id2).state, "ok");
  assert.equal(r.calls().split("\n").filter(l => /^pull /.test(l)).length, before, "no second record");
});

test("space helper: when root's folder will not give the generator's temp files nothing is removed that is not ours (the null device is never an rm argument) and the message stays generic", opts, async t => {
  const r = rig(t);
  await r.prime();
  const real = spawnSync("sh", ["-c", "command -v mktemp; command -v rm"], { encoding: "utf8" }).stdout.trim().split("\n");
  const bin = path.join(r.F, "bin");
  fs.writeFileSync(path.join(bin, "mktemp"), `#!/bin/sh\ncase "$*" in *gen-err*|*gen-rc*) exit 1 ;; esac\nexec ${real[0]} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "rm"), `#!/bin/sh\necho "$*" >>"${r.F}/rm-calls"\nexec ${real[1]} "$@"\n`, { mode: 0o755 });
  r.flag("gen-fails", "boom");
  r.flag("gen-exit", "1");
  const id = r.ask("up harlow\n");
  await r.helper();
  const st = r.status(id);
  assert.equal(st.message, "the compose file could not be regenerated");
  const rmCalls = fs.existsSync(path.join(r.F, "rm-calls")) ? fs.readFileSync(path.join(r.F, "rm-calls"), "utf8") : "";
  assert.ok(!/\/dev\/null/.test(rmCalls), "rm was never asked to remove the null device:\n" + rmCalls);
});
