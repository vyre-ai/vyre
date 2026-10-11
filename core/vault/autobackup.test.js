// @ts-check
// The Vault's automatic backup and its restore drill (G20). Fixtures are fictional.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { restore } from "./backup.js";
import { enrol, run, tick, due, status, drill, unseal, dirOf, DAY_MS } from "./autobackup.js";
import { SCRATCH } from "../../test/scratch.mjs";

const FAST = { N: 1 << 12, r: 8, p: 1 };
const CODE = "kkkkmmmmnnnnppppqqqqrrrrss";
const SECRETS = { "example-api": "fixture-api-Zq81vXr2Lm0pWn", "example-note": "recovery-code-kkkk-7777-example" };

function makeVault(t, name = "a") {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-autobackup-"));
  const db = open(path.join(home, "vyre.db"));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file" } }, emit: () => {} });
  return { home, vault };
}
async function filled(t) {
  const a = makeVault(t);
  await a.vault.put({ name: "example-api", kind: "api-key", fields: { value: SECRETS["example-api"] }, hosts: ["https://api.example.com"], description: "the example API" }, "cli");
  await a.vault.put({ name: "example-note", kind: "note", fields: { text: SECRETS["example-note"] } }, "cli");
  return a;
}

test("enrolling with the recovery code, a backup is made, sealed, mode 0600, and opens only with that code", async t => {
  const { vault } = await filled(t);
  assert.equal(status(vault).enrolled, false);
  await assert.rejects(run(vault), /not turned on/);
  await assert.rejects(enrol(vault, { code: "not a code" }), /not a recovery code/);
  await enrol(vault, { code: CODE });
  const r = await run(vault, { params: FAST });
  assert.equal(r.items, 3, "two items and the key item");
  const file = path.join(dirOf(vault), r.file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, "utf8");
  for (const v of Object.values(SECRETS)) assert.ok(!text.includes(v), "no secret in the file");
  assert.throws(() => unseal(text, "qqqqrrrrssssttttuuuuvvvvww"), /does not open/);
  assert.throws(() => unseal("{}", CODE), /not a Vyre automatic backup/);
  const opened = unseal(text, CODE);
  assert.equal(opened.items, 3);
  assert.equal(status(vault).last?.file, r.file);
});

test("a backup opens on a computer that lost the vault's own key: the code is enough", async t => {
  const { vault } = await filled(t);
  await enrol(vault, { code: CODE });
  const r = await run(vault, { params: FAST });
  const fresh = makeVault(t, "fresh");
  const o = unseal(fs.readFileSync(path.join(dirOf(vault), r.file), "utf8"), CODE);
  const got = await restore(fresh.vault, o.blob, o.passphrase, { mode: "replace" });
  assert.deepEqual(got.added.sort(), ["example-api", "example-note", "vyre-backup-key"]);
  assert.equal((await fresh.vault.fields(fresh.vault.row("example-api"))).value, SECRETS["example-api"]);
});

test("daily: due at the start and after a day, not before; only the newest `keep` files stay", async t => {
  const { vault } = await filled(t);
  assert.equal(due(vault), false, "not enrolled: nothing is due");
  await enrol(vault, { code: CODE, keep: 2 });
  const t0 = Date.UTC(2026, 9, 12, 3, 0, 0);
  assert.equal(due(vault, t0), true, "enrolled and never backed up");
  assert.ok(await tick(vault, { now: t0, params: FAST }));
  assert.equal(due(vault, t0 + DAY_MS - 1000), false, "made today");
  assert.equal(await tick(vault, { now: t0 + 3_600_000 }), null);
  assert.equal(due(vault, t0 + DAY_MS + 1000), true);
  await run(vault, { now: t0 + DAY_MS, params: FAST });
  await run(vault, { now: t0 + 2 * DAY_MS, params: FAST });
  const files = status(vault).files;
  assert.equal(files.length, 2, `kept the newest 2: ${files.join(", ")}`);
  assert.ok(files[0] > "vault-20261013", "the oldest was removed");
});

test("the drill restores into a scratch vault and compares: a healthy vault passes; later changes are 'newer'; a lost item fails it", async t => {
  const { vault } = await filled(t);
  await enrol(vault, { code: CODE });
  await run(vault, { params: FAST });
  assert.equal(status(vault).drill, null, "no drill yet");
  const ok = await drill(vault, { code: CODE });
  assert.equal(ok.ok, true, ok.note);
  assert.equal(ok.matched, 3);
  assert.equal(status(vault).drill?.ok, true, "the result is kept for the Settings line");
  assert.deepEqual(fs.readdirSync(path.dirname(vault.dir)).filter(f => f.startsWith("vyre-drill")), [], "the scratch home is gone");

  // an item changed after the backup is newer, not a failure
  await new Promise(r => setTimeout(r, 20));
  await vault.put({ name: "example-note", kind: "note", fields: { text: "a newer note written after the backup" } }, "cli");
  const later = await drill(vault, { code: CODE });
  assert.equal(later.ok, true, later.note);
  assert.deepEqual(later.newer, ["example-note"]);

  // an item that was in the backup and is gone from the live vault fails the drill, and says which
  vault.remove({ name: "example-api" }, "cli");
  const bad = await drill(vault, { code: CODE });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ["example-api"]);
  assert.equal(status(vault).drill?.ok, false);
  await assert.rejects(drill(vault, { code: "qqqqrrrrssssttttuuuuvvvvww" }), /does not open/);
});

test("through a real daemon: status, enrol, run and the drill are tools; a home with no enrolment makes no vault key", async t => {
  const { start } = await import("../daemon/index.js");
  const { tempHome, present } = await import("../../test/helpers.js");
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const call = async (/** @type {string} */ tool, input = {}) => { const r = await d.registry.call(tool, input, "cli"); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; };
  assert.equal((await call("vault.autobackup.status")).enrolled, false);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false, "asking the status made no key");
  await call("vault.put", { name: "example-api", kind: "api-key", value: SECRETS["example-api"] });
  await call("vault.autobackup.enrol", { code: CODE });
  const ran = await call("vault.autobackup.run");
  assert.ok(ran.file && ran.items >= 2);
  const st = await call("vault.autobackup.status");
  assert.deepEqual([st.enrolled, st.last.file, st.files.length], [true, ran.file, 1]);
  const dr = await call("vault.autobackup.drill", { code: CODE });
  assert.equal(dr.ok, true, dr.note);
  assert.equal((await call("vault.autobackup.status")).drill.ok, true);
});
