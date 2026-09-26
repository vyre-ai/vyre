// @ts-check
// These tests never show a dialog. They build with a stub swiftc, except one real compile on a Mac
// that only runs the helper's --check mode.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build, available, authenticate } from "./index.js";

const FAKE_HELPER = `#!/bin/sh
case "$1" in
  --check) echo ok; exit 0;;
  ok) echo ok; exit 0;;
  deny) echo denied; exit 1;;
  na) echo unavailable; exit 2;;
  hang) exec sleep 30;;
  *) exit 7;;
esac
`;

function stub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-touchid-test-"));
  const swiftc = path.join(dir, "swiftc");
  fs.writeFileSync(swiftc, `#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
cat > "$out" <<'HELPER'
${FAKE_HELPER}HELPER
chmod 700 "$out"
`, { mode: 0o700 });
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { mode: 0o700 });
  return { dir, swiftc, out };
}

test("exit codes map to results", async (t) => {
  const s = stub();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  await build({ dir: s.out, swiftc: s.swiftc, platform: "darwin" });
  assert.equal(await available(), true);
  assert.deepEqual(await authenticate("ok"), { ok: true });
  assert.deepEqual(await authenticate("deny"), { ok: false, reason: "denied" });
  assert.deepEqual(await authenticate("na"), { ok: false, reason: "unavailable" });
  assert.deepEqual(await authenticate("other"), { ok: false, reason: "error" });
  assert.deepEqual(await authenticate("hang", { timeout: 0.1 }), { ok: false, reason: "timeout" });
});

test("a swapped helper is refused, then rebuilt", async (t) => {
  const s = stub();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const h = await build({ dir: s.out, swiftc: s.swiftc, platform: "darwin" });
  assert.deepEqual(await authenticate("deny"), { ok: false, reason: "denied" });
  fs.writeFileSync(h.path, "#!/bin/sh\necho ok\nexit 0\n", { mode: 0o700 });
  assert.deepEqual(await authenticate("deny"), { ok: false, reason: "helper changed" });
  assert.deepEqual(await authenticate("deny"), { ok: false, reason: "denied" });
  fs.rmSync(h.path);
  assert.equal(await available(), false);
  assert.equal(await available(), true);
});

test("refuses a build folder others can read", async (t) => {
  const s = stub();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  fs.chmodSync(s.out, 0o755);
  await assert.rejects(build({ dir: s.out, swiftc: s.swiftc, platform: "darwin" }), /not a private folder/);
  assert.equal(await available(), false);
});

test("not available off macOS or without swiftc", async (t) => {
  const s = stub();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  await assert.rejects(build({ dir: s.out, swiftc: s.swiftc, platform: "linux" }), /macOS/);
  assert.equal(await available(), false);
  assert.deepEqual(await authenticate("ok"), { ok: false, reason: "unavailable" });
  await assert.rejects(build({ dir: s.out, swiftc: path.join(s.dir, "missing"), platform: "darwin" }), /not found/);
  assert.equal(await available(), false);
});

const real = process.platform === "darwin" && fs.existsSync("/usr/bin/swiftc");
test("real compile, --check only", { skip: !real && "needs macOS and /usr/bin/swiftc", timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-touchid-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await build({ dir, swiftc: "/usr/bin/swiftc", platform: "darwin" });
  let word = "";
  try { word = execFileSync(h.path, ["--check"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch (e) { word = String(/** @type {any} */ (e).stdout).trim(); }
  t.diagnostic(`--check said ${word}`);
  assert.ok(word === "ok" || word === "unavailable");
  assert.equal(await available(), word === "ok");
});
