// @ts-check
// The box's system verbs from core/cli/commands/up.js as a person runs them: the real bin/vyre in
// a child process with VYRE_HOME at a temp home. backup and restore need no vyred (one run shows
// restore refusing while one is up). `vyre name` and `vyre owner` talk to a fake vyred: a socket
// in the temp home that answers the names.* tools from a table, so nothing reaches Tailscale,
// Cloudflare or Let's Encrypt. `vyre uninstall --system` only ever runs as a dry run or as a
// refusal: nothing here touches /etc or systemctl.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as config from "../../config/index.js";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string, stdout: string }>} */
const run = (root, args, env = {}, input = undefined) => new Promise(resolve => {
  const child = execFile(process.execPath, [BIN, ...args], { cwd: root, env: { ...process.env, VYRE_HOME: root, VYRE_TMPDIR: SCRATCH, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", ...env }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout }));
  // execFile's stdin isn't a TTY, so `vyre backup`/`restore` read a piped passphrase line from
  // it (readPassphrase, core/cli/commands/up.js); every other verb ignores an unread stdin.
  if (input !== undefined) child.stdin.end(input.endsWith("\n") ? input : input + "\n");
  else child.stdin.end();
});

/** A backup passphrase good enough for the 12-character minimum, piped on stdin. */
const PASSPHRASE = "correct horse battery staple";

/** A home with a config, a store holding one row, and a sealed vault file. */
function seeded(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "harlow-legal", transcripts: [] }));
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("CREATE TABLE notes (body TEXT)");
  db.prepare("INSERT INTO notes VALUES (?)").run("Northwind Bakery renewal is in March");
  db.close();
  fs.mkdirSync(path.join(root, "vault"));
  fs.writeFileSync(path.join(root, "vault", "sealed.bin"), "sealed for juno");
  fs.mkdirSync(path.join(root, "logs"));
  fs.writeFileSync(path.join(root, "logs", "vyred.out"), "not worth keeping");
  return root;
}

const note = root => {
  const db = new DatabaseSync(path.join(root, "vyre.db"), { readOnly: true });
  try { return /** @type {any} */ (db.prepare("SELECT body FROM notes").get()).body; } finally { db.close(); }
};

test("backup and restore: a round trip between two temp homes; restore refuses a store without --force, and while vyred runs", async t => {
  const from = seeded(t);
  const file = path.join(from, "..", `${path.basename(from)}-backup.tar.gz`);
  t.after(() => fs.rmSync(file, { force: true }));

  const b = await run(from, ["backup", file, "--json"], {}, PASSPHRASE);
  assert.equal(b.code, 0, b.out);
  const made = JSON.parse(b.stdout);
  assert.equal(made.file, path.resolve(file));
  assert.deepEqual(made.included, ["config.json", "vyre.db", "vault"]);
  assert.ok(made.bytes > 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "it holds the sealed backup");
  const text = await run(from, ["backup", file], {}, PASSPHRASE);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /KB · config\.json, vyre\.db, vault/);
  assert.match(text.out, /passphrase; keep the two apart/);

  const to = tempHome(t);
  const none = await run(to, ["restore"]);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /next: vyre restore <file> \[--force\]/);

  const wrong = await run(to, ["restore", file], {}, "the wrong passphrase entirely");
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /does not open/);
  assert.ok(!fs.existsSync(path.join(to, "vyre.db")), "nothing written on a failed open");

  const r = await run(to, ["restore", file], {}, PASSPHRASE);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /restored · vyre up to start/);
  assert.equal(note(to), "Northwind Bakery renewal is in March");
  assert.equal(fs.readFileSync(path.join(to, "vault", "sealed.bin"), "utf8"), "sealed for juno");
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, "config.json"), "utf8")).name, "harlow-legal");
  assert.equal(fs.existsSync(path.join(to, "logs", "vyred.out")), false, "logs stay out");

  // A store is already there: only --force replaces it, and the refusal says so.
  const again = await run(to, ["restore", file], {}, PASSPHRASE);
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /already exists/);
  assert.match(again.out, /next: vyre restore .* --force, to replace it/);
  const db = new DatabaseSync(path.join(to, "vyre.db"));
  db.prepare("UPDATE notes SET body = ?").run("changed after the backup");
  db.close();
  const forced = await run(to, ["restore", file, "--force"], {}, PASSPHRASE);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(note(to), "Northwind Bakery renewal is in March", "--force put the backup's store back");

  // With vyred running on that home, restore refuses before touching anything.
  const live = tempHome(t);
  const d = await start({ root: live, log: () => {} });
  t.after(() => d.stop());
  const busy = await run(live, ["restore", file, "--force"], {}, PASSPHRASE);
  assert.equal(busy.code, 1, busy.out);
  assert.match(busy.out, /vyred is running/);
  assert.match(busy.out, /next: vyre down, then try again/);
});

/**
 * A fake vyred for `vyre name` and `vyre owner`: answers POST /v1/tools/<tool> on the home's
 * socket from `tools`, and records each call with its caller.
 */
async function fakeVyred(t, root, tools) {
  const p = config.ensure(root);
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", async () => {
      const tool = decodeURIComponent(String(req.url).replace(/^\/v1\/tools\//, ""));
      const input = raw ? JSON.parse(raw) : {};
      calls.push({ tool, input, caller: req.headers["x-vyre-caller"] });
      const answer = tools[tool] ? await tools[tool](input) : { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      res.writeHead(answer.error ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(r => server.listen(p.socket, () => r(undefined)));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return calls;
}

test("name: status, check, claim and release reach the names tools; usage mistakes are exit 2", async t => {
  const root = tempHome(t);
  let state = { name: null, address: null, phase: "idle" };
  const calls = await fakeVyred(t, root, {
    "names.status": async () => ({ data: state }),
    "names.check": async ({ name }) => ({ data: name === "taken" ? { name, valid: true, available: false, why: "someone else has it" } : { name, valid: true, available: true, address: `https://${name}.vyre.run` } }),
    "names.claim": async ({ name }) => { state = { ...state, address: `https://${name}.vyre.run`, phase: "claiming" }; return { data: { ...state } }; },
    "names.release": async () => ({ error: { code: "presence_required", message: "releasing the name needs you here" } }),
  });

  const s = await run(root, ["name"]);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /no name · idle/);
  assert.deepEqual(JSON.parse((await run(root, ["name", "--json"])).stdout), state);

  assert.match((await run(root, ["name", "check", "alex"])).out, /https:\/\/alex\.vyre\.run is free/);
  assert.match((await run(root, ["name", "check", "taken"])).out, /taken: someone else has it/);

  const claim = await run(root, ["name", "claim", "alex", "--json"]);
  assert.equal(claim.code, 0, claim.out);
  assert.deepEqual(JSON.parse(claim.stdout), { address: "https://alex.vyre.run", phase: "claiming", name: null });
  // Text mode prints the address and nothing about a recovery code: there is none (instant recovery is the way back).
  const claimText = await run(root, ["name", "claim", "alex"]);
  assert.ok(!/recovery code/i.test(claimText.out));
  // The tool's refusal: a person must be here, exit 3, with the next step.
  const rel = await run(root, ["name", "release"]);
  assert.equal(rel.code, 3, rel.out);
  assert.match(rel.out, /releasing the name needs you here/);
  assert.match(rel.out, /next: run it in your own terminal/);

  const noName = await run(root, ["name", "claim"]);
  assert.equal(noName.code, 2, noName.out);
  assert.match(noName.out, /next: vyre name check alex/);
  assert.equal((await run(root, ["name", "frobnicate"])).code, 2);

  assert.deepEqual(calls.map(c => [c.tool, c.input]), [
    ["names.status", {}], ["names.status", {}], ["names.check", { name: "alex" }], ["names.check", { name: "taken" }],
    ["names.claim", { name: "alex" }], ["names.claim", { name: "alex" }], ["names.release", {}],
  ], "usage mistakes never reach vyred");
  assert.ok(calls.every(c => c.caller === "cli"));
});

test("uninstall --system: needs --system; a dry run prints the plan and changes nothing; without root it refuses", async t => {
  const root = tempHome(t);
  const bare = await run(root, ["uninstall"]);
  assert.equal(bare.code, 2, bare.out);
  assert.match(bare.out, /vyre uninstall needs --system/);

  const dry = await run(root, ["uninstall", "--system", "--dry-run", "--purge"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would run systemctl disable --now vyre\.service/);
  assert.match(dry.out, /would remove \/etc\/systemd\/system\/vyre\.service/);
  assert.match(dry.out, /purge: .*\.vyre is deleted/);
  assert.match(dry.out, /would remove .*\.vyre$/m);
  assert.doesNotMatch(dry.out, /did not succeed/);

  // Without root and without --dry-run it stops before any step. Run as root this would really
  // uninstall, so it is only checked as another account.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const refused = await run(root, ["uninstall", "--system"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /run it with sudo, or add --dry-run/);
  assert.doesNotMatch(refused.out, /remove /);
});

const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("up.js commands: vyre commands lists vyre name's verbs; the others take flags and arguments", async t => {
  const root = tempHome(t);
  const d = JSON.parse((await run(root, ["commands", "--all", "--json"])).stdout);
  const of = n => d.commands.find(c => c.name === n);
  assert.deepEqual(of("name").verbs.map(v => v.verb), ["status", "check", "claim", "release"]);
  assert.deepEqual(of("name").verbs.find(v => v.verb === "claim").args, [{ name: "n", required: true }]);
  assert.deepEqual(of("name").verbs.filter(v => v.read).map(v => v.verb), ["status", "check"]);
  for (const n of ["up", "backup", "restore", "uninstall"]) assert.deepEqual(of(n).verbs, [], `${n} has no verbs`);
  assert.deepEqual(of("up").flags.map(f => f.name), ["box", "connect", "no-capsule", "keep-link", "dry-run", "json"]);
  assert.deepEqual(of("up").flags.find(f => f.name === "connect"), { name: "connect", value: "addr" });
  assert.deepEqual(of("restore").args, [{ name: "file", required: true }]);
});

test("up.js commands --view: up --dry-run is a card, name a card, name status the same as name, backup a card", async t => {
  const root = seeded(t);
  const up = await run(root, ["up", "--dry-run", "--view"]);
  assert.equal(up.code, 0, up.out);
  const u = frames(up.stdout);
  assert.deepEqual([u[0].cmd, u[0].view.kind, u[0].data.role, u[0].data.ready], ["up", "card", "box", false]);
  assert.equal(u.length, 2, "the object, then done: no prose");
  const calls = await fakeVyred(t, root, { "names.status": async () => ({ data: { name: "harlow-legal", address: "https://harlow-legal.vyre.run", phase: "serving" } }) });
  const n = frames((await run(root, ["name", "--view"])).stdout);
  assert.deepEqual([n[0].cmd, n[0].view.kind, n[0].view.state, n[0].view.fields.find(f => f.label === "Address").value], ["name", "card", "ok", "https://harlow-legal.vyre.run"]);
  assert.deepEqual(JSON.parse((await run(root, ["name", "status", "--json"])).stdout), n[0].data);
  assert.deepEqual(calls.map(c => c.tool), ["names.status", "names.status"]);
  const file = path.join(SCRATCH, `up-view-${process.pid}-${Date.now()}.tar.gz`);
  t.after(() => fs.rmSync(file, { force: true }));
  const b = frames((await run(root, ["backup", file, "--view"], {}, PASSPHRASE)).stdout);
  assert.deepEqual([b[0].cmd, b[0].view.kind, b[0].data.file], ["backup", "card", file]);
});

test("backup: shows the size of the project files up front, includes them by default, and --skip-projects leaves them out", async t => {
  const from = seeded(t);
  const work = path.join(tempHome(t), "work");
  fs.mkdirSync(path.join(work, "harlow-intake"), { recursive: true });
  fs.writeFileSync(path.join(work, "harlow-intake", "notes.md"), "Northwind Bakery intake notes");
  const file = path.join(from, "..", `${path.basename(from)}-with-work.vyre`);
  t.after(() => fs.rmSync(file, { force: true }));
  const env = { VYRE_WORK_DIR: work };

  const full = await run(from, ["backup", file], env, PASSPHRASE);
  assert.equal(full.code, 0, full.out);
  assert.match(full.out, new RegExp(`project files in ${work.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\d+ KB \\(1 files\\)`), "the size comes before the passphrase prompt");
  assert.match(full.out, /project files \(work\)/);

  const skipped = await run(from, ["backup", file, "--skip-projects", "--json"], env, PASSPHRASE);
  assert.equal(skipped.code, 0, skipped.out);
  assert.deepEqual(JSON.parse(skipped.stdout).projects, []);

  const again = await run(from, ["backup", file], env, PASSPHRASE);
  assert.equal(again.code, 0, again.out);
  const to = tempHome(t), back = path.join(tempHome(t), "back");
  const r = await run(to, ["restore", file, "--work-to", back], {}, PASSPHRASE);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(back, "work", "harlow-intake", "notes.md"), "utf8"), "Northwind Bakery intake notes");
});
