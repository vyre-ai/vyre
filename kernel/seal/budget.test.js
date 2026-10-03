// @ts-check
// The kernel's line budget for K3 (KERNEL-brief.md section 6: sealing process about 800 lines, inference door and ledger about 700), and the
// dependency rule: nothing here imports a module, a library or the vault. Only node: built-ins and files inside kernel/. Counted as non-blank,
// non-comment lines of non-test files; a new file or a raised cap needs reviewer-2's sign-off.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname), KERNEL = path.resolve(HERE, "..");
const code = f => fs.readFileSync(path.join(KERNEL, f), "utf8").split("\n").filter(l => l.trim() && !l.trim().startsWith("//")).length;
const GROUPS = {
  sealing: { cap: 800, files: ["seal/process.js", "seal/store.js", "seal/proof.js", "seal/wire.js", "seal/classes.js", "seal/normalise.js", "seal/client.js"] },
  door: { cap: 700, files: ["door/door.js", "seal/ledger.js"] },
  adapters: { cap: 300, files: ["seal/uses.js", "seal/placement.js"] },
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
    if (spec === "../../names/worker/chain.js") continue; // the identity chain: pure WebCrypto, reviewer-2 to sign off (R-8)
    assert.ok(spec.startsWith("./") || spec.startsWith("../seal/") || spec.startsWith("../door/"), `${f} imports ${spec}`);
  }
});
