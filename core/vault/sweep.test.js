// @ts-check
// The leak sweep (ADR 0028): vault values and known credential shapes in files, git history and
// shell history, skipping dependencies and binaries, and never saying a value.
// Every value here is made at run time.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { recorded } from "./testing.js";
import { prepare, sweepText, sweepFiles, shellHistories } from "./sweep.js";
import { SCRATCH } from "../../test/scratch.mjs";

const hex = n => crypto.randomBytes(n).toString("hex");
// Key shapes assembled at run time, so none sits whole in the source.
const stripeKey = () => ["sk", "live", hex(14)].join("_");
const ghToken = () => ["ghp", hex(18)].join("_");

test("sweepText: vault values by item, shapes by type, separators inside values, nothing said twice", () => {
  const a = hex(16), url = `postgres://kit:${hex(10)}@db.northwind.test/app`;
  const values = prepare([[a, "harlow-api"], [url, "northwind-db"], ["short", "tiny"], ["1234567890123", "digits"]]);
  assert.equal(values.fast.size, 1);
  assert.equal(values.slow.length, 1);
  const stray = stripeKey();
  const text = [
    `const key = "${a}"; // and again ${a}`,
    `DATABASE=${url}`,
    `stripe.setKey('${stray}')`,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "nothing here, short and 1234567890123",
  ].join("\n");
  const found = sweepText(text, values, "src/app.js");
  assert.deepEqual(found, [
    { file: "src/app.js", line: 1, item: "harlow-api" },
    { file: "src/app.js", line: 2, item: "northwind-db" },
    { file: "src/app.js", line: 3, type: "api-key", provider: "stripe" },
    { file: "src/app.js", line: 4, type: "private-key" },
  ]);
  for (const v of [a, url, stray]) assert.ok(!JSON.stringify(found).includes(v));
});

test("vault.sweep: files, git history and the shell's history; dependencies and binaries skipped", async t => {
  const { run, db } = await recorded(t);
  const proj = fs.mkdtempSync(path.join(SCRATCH, "vyre-sweep-"));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const token = ghToken(), dbPw = hex(12), gone = hex(16), stray = stripeKey();
  await run("vault.put", { name: "kit-github", kind: "pat", value: token });
  await run("vault.put", { name: "harlow-db", kind: "db-url", fields: { url: `postgres://juno:${dbPw}@db.harlow.test/intake`, password: dbPw } });
  await run("vault.put", { name: "northwind-old", kind: "secret", value: gone });
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true }); fs.writeFileSync(path.join(proj, rel), s); };

  const git = (...a) => execFileSync("git", ["-C", proj, "-c", "user.name=alex", "-c", "user.email=alex@harlow.test", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
  git("init", "-q");
  w("config.js", `export const old = "${gone}";\n`);
  git("add", "."); git("commit", "-qm", "first");
  w("config.js", "export const old = process.env.OLD;\n");
  git("add", "."); git("commit", "-qm", "moved to env");

  w(".env", `GITHUB_TOKEN=${token}\nPORT=3000\n`);
  w("scripts/deploy.sh", `psql "postgres://juno:${dbPw}@db.harlow.test/intake"\ncurl -u ${stray}: https://api.stripe.test\n`);
  w("node_modules/dep/index.js", `module.exports = "${token}";\n`);
  w("assets/logo.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token)]).toString("latin1"));

  const r = await run("vault.sweep", { path: proj, history: true });
  const files = r.findings.filter(f => f.where === "file").map(f => [f.file, f.line, f.item ?? `${f.type}/${f.provider}`]).sort();
  assert.deepEqual(files, [
    [".env", 1, "kit-github"],
    [path.join("scripts", "deploy.sh"), 1, "harlow-db"],
    [path.join("scripts", "deploy.sh"), 2, "api-key/stripe"],
  ]);
  const hist = r.findings.filter(f => f.where === "history");
  assert.deepEqual(hist.map(f => [f.file, f.item, f.line]), [["config.js", "northwind-old", 1]]);
  assert.match(hist[0].commit, /^[0-9a-f]{12}$/);
  assert.equal(r.commits, 2);
  assert.ok(r.scanned >= 3);

  // Not a repository: said plainly, files still swept.
  const plain = fs.mkdtempSync(path.join(SCRATCH, "vyre-sweep-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  fs.writeFileSync(path.join(plain, "notes.txt"), `token ${token}\n`);
  const p = await run("vault.sweep", { path: plain, history: true });
  assert.equal(p.history, "not a git repository");
  assert.deepEqual(p.findings.map(f => f.item), ["kit-github"]);

  const said = JSON.stringify([r, p, db.prepare("SELECT * FROM vault_audit").all()]);
  for (const v of [token, dbPw, gone, stray]) assert.ok(!said.includes(v), "a value leaked");
});

test("sweep: the shell's history files, in a temp home", () => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-sweep-home-"));
  try {
    const token = ghToken();
    fs.writeFileSync(path.join(home, ".zsh_history"), `: 1790000000:0;export GITHUB_TOKEN=${token}\n: 1790000001:0;ls\n`);
    fs.mkdirSync(path.join(home, ".local", "share", "fish"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "share", "fish", "fish_history"), "- cmd: ls\n");
    assert.deepEqual(shellHistories(home).map(f => path.relative(home, f)), [".zsh_history", path.join(".local", "share", "fish", "fish_history")]);
    const found = sweepFiles(path.join(home, ".zsh_history"), prepare([[token, "kit-github"]])).findings;
    assert.deepEqual(found.map(f => [f.line, f.item]), [[1, "kit-github"]]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
