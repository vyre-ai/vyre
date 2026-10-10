// @ts-check
// The kernel's line budget for K3 (KERNEL-brief.md section 6: sealing process about 800 lines, inference door and ledger about 700), and the
// dependency rule: nothing here imports a module, a library or the vault. Only node: built-ins and files inside kernel/. Counted as non-blank,
// non-comment lines of non-test files; a new file or a raised cap needs reviewer-3's sign-off.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname), KERNEL = path.resolve(HERE, "..");
const code = f => fs.readFileSync(path.join(KERNEL, f), "utf8").split("\n").filter(l => l.trim() && !l.trim().startsWith("//")).length;
const GROUPS = {
  leases: { cap: 120, files: ["seal/leases.js"] },
  // KP-2 (reviewer-3 asked for the proposal): entry-proof.js joins the attestation group (33 lines, the glue that asks Apple's and Android's verifiers whether a paired device's chip key is real), so the cap goes 250 -> 260 (255 used).
  attest: { cap: 260, files: ["seal/appattest.js", "seal/strength.js", "seal/entry-proof.js"] },
  // The Android Keystore attestation verifier (276 lines): about 110 of them are Google's four pinned attestation roots as data (PEM), the rest is the DER walk, the chain and key-description checks and the revocation list. Own group, cap 300.
  androidattest: { cap: 300, files: ["seal/androidattest.js"] },
  // BG-1 (reviewer-2's sign-off, RC1): 900 is the CEILING for the sealing group, raised from 800 for what RC1 had to put inside the sealing process: the one key-strength rule (strength.js, by method and signer,
  // with the unattested phone-key mark), the nested payload hash, the invitee's first-key join and its undo, and the dry presence check. It is a ceiling, not a target: further growth needs reviewer-3's sign-off. 0.3.1 trims it back under 800 (team/BACKLOG.md).
  // SX-1 (platform, 0.2.9; signed off by the lead acting as reviewer, 6 Oct 2026): 960, raised from 900 for moving a sealed value to a Space on another server without its plaintext leaving a sealing process (wrapKey, export, exportApprove, import: the Personal to
  // My Cloud upgrade). That is 61 lines of the 60 asked for; the group sat at 861 before it.
  // R031-83 (lead, 10 Oct 2026): 1005, raised from 960 for a Space's backup bundle and the move of its sealed values between servers, each inside the sealing process because the values never leave it in plaintext:
  //   spaceDump (process.js, 'space.dump': every sealed value of one Space, re-sealed under a bundle key the owner's code derives; refuses a model-originated call),
  //   spaceRestore ('space.restore': opens a bundle and seals each value under THIS box's own keys, so a restore never reuses a key of the old box),
  //   'pool.key' widened to the hosted Space's id (spc_) beside a person's (per_): the pool key a hosted Space's values are sealed under, and
  //   client.js: the three request methods the daemon calls those with. link's removal of 10 dead lease lines brings the group to about 994; 1005 leaves no room to grow and is not a target.
  sealing: { cap: 1005, files: ["seal/process.js", "seal/store.js", "seal/proof.js", "seal/wire.js", "seal/classes.js", "seal/normalise.js", "seal/client.js"] },
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
