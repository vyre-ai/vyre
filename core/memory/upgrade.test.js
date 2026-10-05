// The Personal to My Cloud upgrade, memory's part: plan is read only and stable, the move carries every sealed object (hash-checked), a re-run is safe, a conflict is named and stops only that object.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { FileBackend } from "./identity/home.js";
import { planOf, carry, objectsUnder } from "./upgrade.js";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function server() {
  const objects = new Map();
  return { objects, transport: {
    async get(name) { return objects.get(name) || null; },
    async put(name, bytes, { ifMatch }) { const cur = objects.get(name); if ((cur ? sha(cur) : null) !== ifMatch) return { ok: false }; objects.set(name, Buffer.from(bytes)); return { ok: true }; },
  } };
}
function local(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-up-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = new FileBackend(dir);
  b.put("identity/alex/manifest.json", "{\"m\":1}"); b.put("identity/alex/snap-1.json", "ciphertext one");
  b.put("backup/alex/ring.json", "ring"); b.put("backup/alex/chunks/aa11", "chunk"); b.put("backup/alex/manifests/0000000001.json", "manifest");
  b.put("personal/alex/key.json", "key"); b.put("personal/alex/rec/ff00", "record");
  b.put("identity/other/manifest.json", "someone else");
  return b;
}

test("upgrade: the plan counts only this person's sealed objects, read only and the same when asked again", t => {
  const b = local(t);
  const a = planOf(b, "alex"), again = planOf(b, "alex");
  assert.deepEqual(a, again);
  assert.equal(a.counts.objects, 7);
  assert.equal(a.counts.bytes, "{\"m\":1}".length + "ciphertext one".length + "ring".length + "chunk".length + "manifest".length + "key".length + "record".length);
  assert.deepEqual(a.blockers, []);
  assert.deepEqual(planOf(b, "alex", { unsaved: () => true }).blockers.length, 1);
  assert.deepEqual(planOf(null, "alex"), { counts: { objects: 0, bytes: 0 }, blockers: [] });
  assert.ok(!objectsUnder(b, "identity/alex").some(n => n.includes("other")));
});

test("upgrade: every object is copied and checked, keys unchanged; a re-run skips what is there; a different object is named, the others still move; a transport that corrupts is caught", async t => {
  const b = local(t), s = server();
  const r = await carry(b, s.transport, "alex");
  assert.deepEqual([r.objects, r.skipped, r.failed.length], [7, 0, 0]);
  assert.equal(s.objects.size, 7);
  assert.equal(s.objects.get("personal/alex/rec/ff00").toString(), "record");
  assert.ok(!s.objects.has("identity/other/manifest.json"), "another person's objects stay");
  const again = await carry(b, s.transport, "alex");
  assert.deepEqual([again.objects, again.skipped, again.failed.length], [0, 7, 0]);
  // a different object already there: named, the rest unaffected
  s.objects.set("backup/alex/ring.json", Buffer.from("something else"));
  const conflict = await carry(b, s.transport, "alex");
  assert.deepEqual(conflict.failed, [{ name: "backup/alex/ring.json", why: "a different object is already there" }]);
  // a transport that stores something other than what it was given
  const liar = { async get(n) { return Buffer.from("not it"); }, async put() { return { ok: true }; } };
  const bad = await carry(b, liar, "alex");
  assert.equal(bad.objects, 0);
  assert.ok(bad.failed.every(f => f.why === "it did not match after copying"));
});
