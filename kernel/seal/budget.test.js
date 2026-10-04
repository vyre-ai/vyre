// @ts-check
// The kernel's line budget for K3 (KERNEL-brief.md section 6: sealing process about 800 lines, inference door and ledger about 700), and the
// dependency rule: nothing here imports a module, a library or the vault. Only node: built-ins and files inside kernel/. Counted as non-blank,
// non-comment lines of non-test files; a new file or a raised cap needs reviewer-2's sign-off.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname), KERNEL = path.resolve(HERE, "..");
const code = f => fs.readFileSync(path.join(KERNEL, f), "utf8").split("\n").filter(l => l.trim() && !l.trim().startsWith("//")).length;
const GROUPS = {
  leases: { cap: 120, files: ["seal/leases.js"] },
  attest: { cap: 250, files: ["seal/appattest.js", "seal/strength.js"] },
  // BG-1 (reviewer-2's sign-off, RC1): 900 is the CEILING for the sealing group, raised from 800 for what RC1 had to put inside the sealing process: the one key-strength rule (strength.js, by method and signer,
  // with the unattested phone-key mark), the nested payload hash, the invitee's first-key join and its undo, and the dry presence check. It is a ceiling, not a target: further growth needs reviewer-2's sign-off.
  sealing: { cap: 900, files: ["seal/process.js", "seal/store.js", "seal/proof.js", "seal/wire.js", "seal/classes.js", "seal/normalise.js", "seal/client.js"] },
  door: { cap: 700, files: ["door/door.js", "door/stream.js", "seal/ledger.js"] },
  adapters: { cap: 300, files: ["seal/uses.js", "seal/placement.js"] },
  // The host CLI's wipe (`sudo vyre admin wipe`): destroys the sealing master key and folder with the daemon stopped. Never imported by the daemon.
  host: { cap: 30, files: ["seal/wipe.js"] },
};
const nonTest = dir => fs.readdirSync(path.join(KERNEL, dir)).filter(f => f.endsWith(".js") && !/\.test\.js$|^testing\.js$/.test(f)).map(f => `${dir}/${f}`);

test("each group stays inside its line budget", () => {
  for (const [name, g] of Object.entries(GROUPS)) { const n = g.files.reduce((a, f) => a + code(f), 0); assert.ok(n <= g.cap, `${name}: ${n} lines, cap ${g.cap}`); }
});
test("every non-test file is in a group (a new file is a new decision)", () => {
  const listed = new Set(Object.values(GROUPS).flatMap(g => g.files));
  assert.deepEqual([...nonTest("seal"), ...nonTest("door")].filter(f => !listed.has(f)), []);
});
test("kernel/seal and kernel/door import only node built-ins and each other", () => {
  for (const f of [...nonTest("seal"), ...nonTest("door")]) for (const m of fs.readFileSync(path.join(KERNEL, f), "utf8").matchAll(/from "([^"]+)"/g)) {
    const spec = m[1];
    if (spec.startsWith("node:")) continue;
    if (spec === "../identity/chain.js") continue; // the identity chain verifier: pure WebCrypto, hash pinned in kernel/identity (R-8)
    assert.ok(spec.startsWith("./") || spec.startsWith("../seal/") || spec.startsWith("../door/"), `${f} imports ${spec}`);
  }
});
