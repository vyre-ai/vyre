// @ts-check
// .env import (ADR 0028, decision 1): one env-set per file, only secrets moved, a folder scan that
// skips dependencies and templates, a token over every file, and the rewrite to vault:// refs.
// Every value here is a made-up sample built at run time.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recorded } from "./testing.js";
import { envEntries, envItemName, readEnv, rewriteEnv, findEnvFiles, isEnvName } from "./envfiles.js";
import { parseEnvFile } from "./refs.js";
import { SCRATCH } from "../../test/scratch.mjs";

const hex = n => crypto.randomBytes(n).toString("hex");
// Key-shaped strings are assembled here so none sits whole in the source.
const openai = () => ["sk", "proj", hex(24)].join("-");
const stripe = () => ["sk", "live", hex(14)].join("_");
const dbUrl = () => `postgres://harlow:${hex(12)}@db.harlow.test:5432/intake`;

const ENV = values => [
  "# Harlow intake",
  "PORT=3000",
  "NODE_ENV=production",
  `export OPENAI_API_KEY=${values.openai}`,
  `STRIPE_SECRET_KEY="${values.stripe}"`,
  "PUBLIC_SITE=https://harlow.test",
  `DATABASE_URL=${values.db} # the main db`,
  `SESSION_SECRET='${values.session}'`,
  "",
].join("\n");

test("envfiles: names, entries with spans, secrets vs config, rewrite keeps everything else", () => {
  assert.equal(envItemName("/w/harlow-intake/.env"), "harlow-intake.env");
  assert.equal(envItemName("/w/harlow-intake/.env.local"), "harlow-intake.env.local");
  assert.equal(envItemName("/w/harlow-intake/apps/web/.env", "/w/harlow-intake"), "harlow-intake-apps-web.env");
  assert.equal(envItemName("/w/northwind/prod.env"), "northwind-prod.env");
  assert.equal(envItemName(".env.local"), "env.local");
  assert.equal(envItemName(undefined), "env");
  assert.ok(isEnvName(".env") && isEnvName(".env.production") && isEnvName("prod.env") && !isEnvName("env.js") && !isEnvName(".envrc"));

  const multi = 'A=1\nKEY="line one\nline two"\n# c\nB=2\n';
  const { entries } = envEntries(multi);
  assert.deepEqual(entries.map(e => [e.key, e.start, e.end]), [["A", 0, 1], ["KEY", 1, 3], ["B", 4, 5]]);
  assert.equal(rewriteEnv(multi, "x.env", ["KEY"]), "A=1\nKEY=vault://x.env/KEY\n# c\nB=2\n");

  const v = { openai: openai(), stripe: stripe(), db: dbUrl(), session: hex(20) };
  const r = readEnv(ENV(v), { file: "/w/harlow-intake/.env" });
  assert.ok(r.item);
  assert.equal(r.item.name, "harlow-intake.env");
  assert.equal(r.item.kind, "env-set");
  assert.deepEqual(r.item.fields, { OPENAI_API_KEY: v.openai, STRIPE_SECRET_KEY: v.stripe, DATABASE_URL: v.db, SESSION_SECRET: v.session });
  assert.deepEqual(r.kept.sort(), ["NODE_ENV", "PORT", "PUBLIC_SITE"]);
  assert.equal(r.item.description, "from .env · 4 values");
  const byKey = Object.fromEntries(r.vars.map(x => [x.key, x]));
  assert.equal(byKey.OPENAI_API_KEY.provider, "openai");
  assert.equal(byKey.STRIPE_SECRET_KEY.provider, "stripe");
  assert.equal(byKey.DATABASE_URL.type, "db-url");
  assert.equal(byKey.PORT.secret, false);
  // What the preview shows carries no value.
  const shown = JSON.stringify({ vars: r.vars, kept: r.kept, d: r.item.description });
  for (const x of Object.values(v)) assert.ok(!shown.includes(x.slice(-12)));

  // The rewrite: secrets become refs (export and all), config and comments stay, and the result
  // reads back through the same parser `vyre vault run --env-file` uses.
  const out = rewriteEnv(ENV(v), "harlow-intake.env", Object.keys(r.item.fields));
  for (const x of Object.values(v)) assert.ok(!out.includes(x));
  assert.match(out, /^# Harlow intake\nPORT=3000\nNODE_ENV=production\nexport OPENAI_API_KEY=vault:\/\/harlow-intake.env\/OPENAI_API_KEY\n/);
  const back = Object.fromEntries(parseEnvFile(out).map(e => [e.key, e.refs]));
  assert.deepEqual(back.DATABASE_URL, ["vault://harlow-intake.env/DATABASE_URL"]);
  assert.deepEqual(back.PORT, []);
  // CRLF files stay CRLF.
  assert.equal(rewriteEnv("A=1\r\nS=x\r\n", "i", ["S"]), "A=1\r\nS=vault://i/S\r\n");
});

test("envfiles: the scan skips dependencies, build output and templates, and does not follow links", t => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-envscan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, s = "X=1\n") => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  put(".env"); put("apps/web/.env.local"); put(".env.example"); put("node_modules/pkg/.env"); put("dist/.env"); put(".git/.env"); put("src/app.js");
  fs.symlinkSync(path.join(root, "apps"), path.join(root, "linked"));
  const f = findEnvFiles(root);
  assert.deepEqual(f.files.map(p => path.relative(root, p)), [".env", path.join("apps", "web", ".env.local")]);
  assert.deepEqual(f.templates.map(p => path.relative(root, p)), [".env.example"]);
  assert.equal(f.truncated, false);
  assert.equal(findEnvFiles(root, { limit: 1 }).truncated, true);
});

test("vault.import of a folder: preview per file, the token covers every file, rewrite after storing, no value leaks", async t => {
  const { tmp, db, events, run } = await recorded(t);
  const proj = path.join(tmp, "harlow-intake");
  fs.mkdirSync(path.join(proj, "apps", "web"), { recursive: true });
  fs.mkdirSync(path.join(proj, "node_modules", "dep"), { recursive: true });
  const a = { openai: openai(), stripe: stripe(), db: dbUrl(), session: hex(20) };
  const b = { openai: openai(), stripe: stripe(), db: dbUrl(), session: hex(20) };
  const rootEnv = path.join(proj, ".env"), webEnv = path.join(proj, "apps", "web", ".env.local");
  fs.writeFileSync(rootEnv, ENV(a), { mode: 0o600 });
  fs.writeFileSync(webEnv, ENV(b));
  fs.writeFileSync(path.join(proj, "node_modules", "dep", ".env"), `DEP_TOKEN=${hex(20)}\n`);
  fs.writeFileSync(path.join(proj, ".env.example"), "OPENAI_API_KEY=\n");
  const all = [...Object.values(a), ...Object.values(b)];

  const preview = await run("vault.import.preview", { file: proj });
  assert.equal(preview.format, "env");
  assert.deepEqual(preview.add, ["harlow-intake.env", "harlow-intake-apps-web.env.local"]);
  assert.equal(preview.counts["env-set"], 2);
  assert.deepEqual(preview.files.map(f => [path.relative(proj, f.file), f.item, f.state]),
    [[".env", "harlow-intake.env", "add"], [path.join("apps", "web", ".env.local"), "harlow-intake-apps-web.env.local", "add"]]);
  assert.deepEqual(preview.templates.map(f => path.basename(f)), [".env.example"]);
  assert.equal(preview.files[0].vars.find(v => v.key === "PORT").secret, false);

  // Any file changing after the preview refuses the import.
  fs.appendFileSync(webEnv, "LATER=1\n");
  await assert.rejects(run("vault.import", { file: proj, token: preview.token }), /changed since the preview/);
  fs.writeFileSync(webEnv, ENV(b));

  const done = await run("vault.import", { file: proj, token: preview.token, rewrite: true });
  assert.deepEqual(done.added, ["harlow-intake.env", "harlow-intake-apps-web.env.local"]);
  assert.deepEqual(done.rewritten, [rootEnv, webEnv]);
  assert.match(done.advice, /vyre run -- <command>/);
  assert.equal(fs.statSync(rootEnv).mode & 0o777, 0o600);
  const after = fs.readFileSync(rootEnv, "utf8");
  for (const x of Object.values(a)) assert.ok(!after.includes(x));
  assert.match(after, /^STRIPE_SECRET_KEY=vault:\/\/harlow-intake\.env\/STRIPE_SECRET_KEY$/m);
  assert.match(after, /^PORT=3000$/m);
  // No backup of the old file anywhere in the project.
  assert.deepEqual(fs.readdirSync(proj).sort(), [".env", ".env.example", "apps", "node_modules"]);

  const env = (await run("vault.inject", { items: [{ name: "harlow-intake.env" }] })).env;
  assert.equal(env.OPENAI_API_KEY, a.openai);
  assert.equal(env.DATABASE_URL, a.db);
  assert.equal(env.PORT, undefined);

  // Scanned again: the rewritten files hold nothing secret, so nothing is added.
  const again = await run("vault.import.preview", { file: proj });
  assert.deepEqual(again.add, []);

  // An .env file on its own, with the same values as the vault: same, and the rewrite still runs.
  const lone = path.join(tmp, "northwind", ".env");
  fs.mkdirSync(path.dirname(lone));
  fs.writeFileSync(lone, ENV(a));
  await run("vault.import", { file: lone });
  fs.writeFileSync(lone, ENV(a));
  const same = await run("vault.import", { file: lone, rewrite: true });
  assert.deepEqual(same.same, ["northwind.env"]);
  assert.deepEqual(same.rewritten, [lone]);
  // A changed value is a conflict: skipped by default, and its file is left alone.
  fs.writeFileSync(lone, ENV({ ...a, session: hex(20) }));
  const conflict = await run("vault.import", { file: lone, rewrite: true });
  assert.deepEqual(conflict.conflicts, ["northwind.env"]);
  assert.deepEqual(conflict.unchanged, [lone]);
  assert.ok(fs.readFileSync(lone, "utf8").includes(a.openai));

  const rewriteCsv = path.join(tmp, "x.csv");
  fs.writeFileSync(rewriteCsv, "name,url,username,password\nx,https://x.test,alex,pw\n");
  await assert.rejects(run("vault.import", { file: rewriteCsv, rewrite: true }), /rewrite is for \.env files/);

  const said = JSON.stringify([preview, done, again, same, conflict, events,
    db.prepare("SELECT * FROM vault_audit").all(), db.prepare("SELECT name, kind, description FROM vault_items").all()]);
  for (const x of all) assert.ok(!said.includes(x), "a value leaked");
});
