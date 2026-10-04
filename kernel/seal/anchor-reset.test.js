// BL-2 / AN-1: the offline reset a restore from backup needs (scripts/admin-anchor-reset.mjs), against the REAL sealing process: the request names the exact act, a wrong or used proof changes
// nothing, the owner's proof resets the anchor and leaves one sealed `anchor.reset` event in the home's log, and a model's or another person's proof is refused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startSealer } from "./client.js";
import { signer, enrolDevice, tmp } from "./testing.js";
import { chainCtx } from "./wire.js";
import { createSqliteEventLog } from "../store/sqlite-log.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "admin-anchor-reset.mjs");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_" + "a".repeat(26);
/** Start the script and wait for its request line; `answer(proof)` writes the proof and resolves with the exit. */
const session = (home, extra = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [SCRIPT, "--home", home, "--wait", "20", ...extra], { env: { PATH: process.env.PATH, VYRE_SEAL_DEV: "1", VYRE_SEAL_UNATTESTED: "1" } });
  let err = "", out = ""; child.stderr.on("data", d => { err += d; });
  const exit = new Promise(r => child.on("exit", status => r({ status, stderr: err, stdout: out })));
  const rl = createInterface({ input: child.stdout });
  rl.once("line", l => { out += l; resolve({ request: JSON.parse(l).request, answer: async proof => { child.stdin.write((typeof proof === "string" ? proof : JSON.stringify(proof)) + "\n"); child.stdin.end(); return exit; }, exit }); });
  child.on("exit", () => reject(new Error("exited before a request: " + err)));
});
const run = (args, env = {}, input) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", input, env: { PATH: process.env.PATH, VYRE_SEAL_DEV: "1", VYRE_SEAL_UNATTESTED: "1", ...env } });

test("admin anchor-reset: the request names the act; the owner's proof resets the anchor and leaves a sealed event; a wrong or reused proof, and a stranger's, change nothing", async t => {
  const home = tmp("home");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "kernel"), { recursive: true });
  fs.writeFileSync(path.join(home, "kernel", "space.json"), JSON.stringify({ space: SPACE, owner: OWNER, made_at: 1 }));
  const db = new DatabaseSync(path.join(home, "vyre.db"));
  createSqliteEventLog({ db, space: SPACE }); db.close();
  const sealDir = path.join(home, "kernel", "seal");
  const probe = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true });
  if (typeof probe.anchor.reset !== "function") { await probe.close(); t.skip("this sealing process has no anchor.reset (work/sealing)"); return; }
  const mine = signer(OWNER);
  const ownerChain = { space: SPACE, hops: [{ actor: { kind: "person", id: OWNER, space: SPACE }, via: { surface: "cli" } }] };
  const { chain } = await (async () => {
    const { person } = await import("./testing.js");
    return { chain: person(OWNER, "deck", SPACE) };
  })();
  await enrolDevice(probe, mine, { person: OWNER });
  await probe.anchor.advance({ space: SPACE, seq: 500, head: "h".repeat(32) });
  assert.deepEqual(await probe.anchor.read({ space: SPACE }), { seq: 500, head: "h".repeat(32) });
  await probe.close();

  // the request: what the owner's device must sign (printed with no sealing process started)
  const req = run(["--home", home, "--request"]);
  assert.equal(req.status, 0, req.stderr);
  const asked = JSON.parse(req.stdout);
  assert.equal(asked.op, "anchor.reset"); assert.equal(asked.space, SPACE); assert.equal(asked.person, OWNER); assert.deepEqual(asked.fields, {});
  assert.equal(asked.chain_hash, chainCtx(ownerChain).chain_hash);
  assert.equal(asked.chain_hash, chainCtx(chain).chain_hash, "the same chain hash a kernel-built owner chain has");

  const readAnchor = async () => { const s = startSealer({ dir: sealDir, timeoutMs: 8000, dev: true, unattested: true }); try { return await s.anchor.read({ space: SPACE }); } finally { await s.close(); } };
  const events = () => { const d = new DatabaseSync(path.join(home, "vyre.db")); try { return d.prepare("SELECT event FROM kernel_events WHERE space = ?").all(SPACE).map(r => JSON.parse(r.event)); } finally { d.close(); } };
  // refused: a tampered proof, a proof for another act, an unenrolled key, junk: the anchor stays
  const stranger = signer("per_" + "b".repeat(26));
  for (const [what, make] of [["a tampered proof", () => mine.proof(chain, "anchor.reset", {}, { tamper: true })], ["a proof for another act", () => mine.proof(chain, "presence.revoke", { key_id: "x" })], ["an unenrolled key", () => stranger.proof(chain, "anchor.reset", {})], ["junk", () => "not json"]]) {
    const s = await session(home);
    assert.equal(s.request.op, "anchor.reset");
    const r = await s.answer(make());
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.match(r.stderr, /refused: /, `${what}: ${r.stderr}`);
  }
  assert.deepEqual(await readAnchor(), { seq: 500, head: "h".repeat(32) }, "nothing changed");
  assert.equal(events().filter(e => e.type === "anchor.reset").length, 0);

  // a proof made BEFORE the process started is refused (the used list is in memory), so a proof is made from the request line
  const early = mine.proof(chain, "anchor.reset", {});
  const sEarly = await session(home);
  assert.equal((await sEarly.answer(early)).status, 2, "a proof issued before the process started is not taken");

  // the owner's proof, made after the request: the anchor reads null, one sealed event names the person
  const s1 = await session(home);
  const good = mine.proof(chain, "anchor.reset", {});
  const done = await s1.answer(good);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(await readAnchor(), null);
  const ev = events().filter(e => e.type === "anchor.reset");
  assert.equal(ev.length, 1, "exactly one anchor.reset in the log");
  assert.equal(ev[0].data.by, OWNER);
  // a proof is used once
  const s2 = await session(home);
  assert.equal((await s2.answer(good)).status, 2);
  assert.equal(events().filter(e => e.type === "anchor.reset").length, 1);
});

test("admin anchor-reset: bad arguments and a folder that is no home are refused without touching anything", () => {
  assert.equal(run([]).status, 64);
  assert.equal(run(["--home", "relative", "--request"]).status, 64);
  assert.equal(run(["--home", "/tmp", "--request", "--wait", "5"]).status, 64);
  assert.equal(run(["--home", "/tmp", "--wat"]).status, 64);
  const empty = tmp("nohome");
  try { const r = run(["--home", empty, "--request"]); assert.equal(r.status, 2); assert.match(r.stderr, /no_home/); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
