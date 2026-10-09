// @ts-check
// What the app's import screen relies on (R031-66, R031-67): the app sends the BYTES of the export the person picked (no path on this box), an assistant cannot, and several .env files
// from a scan import and rewrite under one call. Every value is a made-up sample built at run time.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recorded } from "./testing.js";

const hex = n => crypto.randomBytes(n).toString("hex");
const stripe = () => ["sk", "live", hex(14)].join("_");

test("the app's callers can preview, import and scan; the bytes of a file come from the app, never from Claude", async t => {
  const { tools, run } = await recorded(t);
  for (const name of ["vault.import.preview", "vault.import", "vault.env.scan"]) {
    const callers = tools.get(name).callers;
    for (const c of ["capsule", "deck", "mobile", "device"]) assert.ok(callers.includes(c), `${name} is open to ${c}`);
  }
  const content = Buffer.from("name,url,username,password\nAcme,https://acme.test,juno,pw\n").toString("base64");
  await assert.rejects(async () => run("vault.import.preview", { content, filename: "x.csv" }, "mcp"), /never passed through Claude/);
  await assert.rejects(async () => run("vault.import", { content, filename: "x.csv" }, "mcp"), /never passed through Claude/);
  await assert.rejects(async () => run("vault.import.preview", {}), /give a file path, or the file's content/);
});

test("an export sent as bytes previews and imports like a file, with a token bound to those bytes and no value in the answers", async t => {
  const { run } = await recorded(t);
  const pw1 = "sample-" + hex(8), pw2 = "sample-" + hex(8);
  const csv = `name,url,username,password\nAcme Billing,https://billing.acme.test,juno,${pw1}\nHarlow Portal,https://portal.harlow.test,kit,${pw2}\n`;
  const content = Buffer.from(csv).toString("base64");

  const p = await run("vault.import.preview", { content, filename: "Chrome Passwords.csv" }, "capsule");
  assert.equal(p.format, "chrome-csv");
  assert.equal(p.counts.login, 2);
  assert.equal(p.add.length, 2);
  assert.deepEqual(p.same, []);
  assert.ok(!JSON.stringify(p).includes(pw1) && !JSON.stringify(p).includes(pw2));

  // Other bytes, same token check: the import is refused.
  const other = Buffer.from(csv + `Later,https://later.test,x,${hex(6)}\n`).toString("base64");
  await assert.rejects(run("vault.import", { content: other, filename: "Chrome Passwords.csv", token: p.token }, "capsule"), /changed since the preview/);

  const done = await run("vault.import", { content, filename: "Chrome Passwords.csv", token: p.token }, "capsule");
  assert.equal(done.added.length, 2);
  assert.match(done.advice, /^Delete the exported file now/);
  assert.ok(!JSON.stringify(done).includes(pw1));
  assert.equal((await run("vault.list", {})).items.length, 2);

  // Again: everything is already here.
  const again = await run("vault.import.preview", { content, filename: "Chrome Passwords.csv" }, "capsule");
  assert.equal(again.add.length, 0);
  assert.equal(again.same.length, 2);
  await assert.rejects(run("vault.import", { content, filename: "x.csv", rewrite: true }, "capsule"), /rewrite is for .env files/);
});

test("several .env files import and rewrite under one call; a bad path is reported and the rest still go", async t => {
  const { tmp, run } = await recorded(t);
  const a = path.join(tmp, "alpha"), b = path.join(tmp, "beta");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const keyA = stripe(), keyB = stripe();
  fs.writeFileSync(path.join(a, ".env"), `PORT=3000\nSTRIPE_SECRET_KEY=${keyA}\n`);
  fs.writeFileSync(path.join(b, ".env"), `STRIPE_SECRET_KEY=${keyB}\n`);
  const r = await run("vault.import", { files: [path.join(a, ".env"), path.join(tmp, "gone", ".env"), path.join(b, ".env")], rewrite: true }, "capsule");
  assert.equal(r.added.length, 2);
  assert.equal(r.rewritten.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(r.unchanged, [path.join(tmp, "gone", ".env")]);
  assert.ok(!fs.readFileSync(path.join(a, ".env"), "utf8").includes(keyA));
  assert.match(fs.readFileSync(path.join(a, ".env"), "utf8"), /^STRIPE_SECRET_KEY=vault:\/\//m);
  assert.ok(!JSON.stringify(r).includes(keyA) && !JSON.stringify(r).includes(keyB));
  await assert.rejects(async () => run("vault.import", { files: ["relative/.env"] }, "capsule"), /absolute paths/);
});
