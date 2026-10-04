// @ts-check
// AN-1, the whole path, with real parts: a restore from backup puts the database behind the anchor the sealing process keeps outside it, a PACKAGED home then refuses to start and says which command to run, the
// owner's anchor.reset through scripts/admin-anchor-reset.mjs (the very script `sudo vyre admin anchor-reset` runs, as a real child process, reading the owner's proof from stdin) lets it start with the data from the
// backup intact, leaves exactly one sealed `anchor.reset` event, and the same proof used a second time is refused. Stand-ins, said plainly: the "packaged" kernel is a development tree handed a release-stamped packageRoot
// (the daemon's own isPackaged test), the owner's phone is a SOFTWARE signer (dev-kind sealing process, VYRE_SEAL_SOFTWARE), and the box wrapper (docker compose around the script) is not exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { bootHomeKernel, homeIdentity } from "./home.js";
import { startSealer } from "./seal/client.js";
import { signer, enrolDevice } from "./seal/testing.js";
import { tempHome } from "../test/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "admin-anchor-reset.mjs");

/** Run the admin script as the box wrapper does; give back its request line, then take the owner's proof on stdin and say how it ended. */
function runScript(/** @type {string} */ home, /** @type {string} */ sealDir, /** @type {(request: any) => any} */ makeProof) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, "--home", home, "--seal-dir", sealDir, "--wait", "60"], { env: { ...process.env, VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1" } });
    let out = "", err = "", sent = false;
    child.stdout.on("data", d => { out += d; if (!sent && out.includes("\n")) { sent = true; const req = JSON.parse(out.split("\n")[0]).request; child.stdin.end(JSON.stringify(makeProof(req)) + "\n"); } });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => resolve({ code, out, err }));
  });
}

test("AN-1: restore from backup -> a packaged home refuses and names the command -> admin anchor-reset with the owner's proof -> it starts, data intact, one anchor.reset event, the same proof refused again", { timeout: 240_000 }, async t => {
  const root = tempHome(t), dbFile = path.join(root, "vyre.db"), sdir = path.join(root, "kernel", "seal");
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-")); t.after(() => fs.rmSync(pkg, { recursive: true, force: true }));
  fs.mkdirSync(path.join(pkg, "lib")); fs.writeFileSync(path.join(pkg, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const id = homeIdentity(root), owner = id.owner;
  const alex = signer(owner, undefined, "software");
  let sealer = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  t.after(async () => { await sealer.close().catch(() => {}); });
  const log = /** @type {string[]} */ ([]);
  const boot = (/** @type {any} */ s) => bootHomeKernel({ db: new DatabaseSync(dbFile), root, sealer: s, log: m => log.push(m), isFirstParty: () => false, pathRule: true, packageRoot: pkg });
  const note = (/** @type {any} */ k, /** @type {number} */ n) => k.log.append(k.chains.fromFacts({ kind: "module", module: "walk", first_party: true }), { type: "note.added", sv: 1, subject: `vyre://${id.space}/note/${n}`, data: { n }, vis: "owner", red: "internal" });
  const events = (/** @type {any} */ k, /** @type {string} */ type) => k.log.read({ type });

  const say = (/** @type {string} */ m) => console.log(`# AN-1: ${m}`);
  // 1. install and write data; the owner's (software) key is enrolled; a checkpoint moves the anchor; back up the home
  let k = await boot(sealer);
  await enrolDevice(sealer, alex);
  for (let n = 1; n <= 3; n++) note(k, n);
  await k.checkpoints.sign();
  say("installed, 3 notes written, owner software key enrolled, checkpoint signed (anchor moved), home backed up");
  k.db?.close?.();
  const backup = path.join(root, "backup.db"); fs.copyFileSync(dbFile, backup);
  // 2. life goes on past the backup: more data, another checkpoint (the anchor moves past what the backup holds)
  k = await boot(sealer);
  for (let n = 4; n <= 7; n++) note(k, n);
  await k.checkpoints.sign();
  const before = events(k, "note.added").length;
  assert.equal(before, 7);
  say("4 more notes and a checkpoint after the backup: 7 notes, anchor ahead of the backup");
  // 3. the routine restore: the old copy goes over the database
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(backup, dbFile);
  say("backup restored over the database");
  // 4. the packaged home refuses to start, and the message names the command
  await assert.rejects(() => boot(sealer), (/** @type {any} */ e) => e.code === "log_rolled_back" && /anchor_rolled_back/.test(e.message) && /sudo vyre admin anchor-reset/.test(e.message), "the refusal names the command");
  say("packaged boot REFUSED: log_rolled_back, anchor_rolled_back, names `sudo vyre admin anchor-reset`");
  // 5. the owner runs it (the daemon is stopped: the sealing process is closed first, as the wrapper does)
  await sealer.close();
  const proofs = /** @type {any[]} */ ([]);
  const first = await runScript(root, sdir, req => { assert.equal(req.op, "anchor.reset"); assert.equal(req.person, owner); const p = alex.proof(req.chain, "anchor.reset", {}); proofs.push(p); return p; });
  assert.equal(first.code, 0, `exit 0 expected: ${first.err}`);
  assert.ok(first.out.includes('"reset":true'), first.out);
  say(`admin script exit ${first.code}: ${first.out.trim().split("\n").pop()}`);
  // 6. it starts; the data from the backup is there; exactly one sealed anchor.reset event, naming the owner
  sealer = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  k = await boot(sealer);
  assert.equal(k.boot.ok, true);
  assert.deepEqual(events(k, "note.added").map((/** @type {any} */ e) => e.data.n), [1, 2, 3], "the data in the backup is intact");
  const resets = events(k, "anchor.reset");
  assert.equal(resets.length, 1, "exactly one anchor.reset event");
  assert.equal(resets[0].data.by, owner);
  say("packaged boot OK after the reset: notes [1,2,3] intact, exactly one anchor.reset event by the owner");
  k.db?.close?.();
  await sealer.close();
  // 7. the same proof, used again, is refused and nothing changes
  const again = await runScript(root, sdir, () => proofs[0]);
  assert.equal(again.code, 2, `refused: ${again.err}`);
  assert.match(again.err, /^refused: (needs_presence|expired)/m);
  sealer = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  k = await boot(sealer);
  say(`the same proof again: exit ${again.code}, ${again.err.trim().split("\n").filter(l => l.startsWith("refused")).join(" ")}`);
  assert.equal(events(k, "anchor.reset").length, 1, "still exactly one");
  k.db?.close?.();
});
