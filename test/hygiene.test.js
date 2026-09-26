// @ts-check
// Repository hygiene: nothing personal and no secrets in shipped code.
//
// The forbidden words are stored encoded so this file does not match itself. They are the
// names of the people and businesses whose machines Vyre was first built on; none may appear in
// code anyone installs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = ["bin", "core", "harness", "local", "deck", "modules"];
const FORBIDDEN = ["aXJmYWQ=", "bXlsZWdhbGFjYWRlbXk=", "cmFucWw=", "aXZ5cw==", "a2F6YWxhdw==", "dGVjaG1hbmFnZXI="]
  .map(b => Buffer.from(b, "base64").toString("utf8"));
const SECRET = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function files(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|json|md|mjs|cjs|sh|html|css)$|^vyre$/.test(e.name)) out.push(p);
  }
  return out;
}

test("hygiene: shipped code names no one and carries no secrets", () => {
  const hits = [];
  for (const dir of SHIPPED) for (const f of files(path.join(ROOT, dir))) {
    const text = fs.readFileSync(f, "utf8").toLowerCase();
    for (const w of FORBIDDEN) if (text.includes(w)) hits.push(`${path.relative(ROOT, f)}: personal name`);
    if (SECRET.test(fs.readFileSync(f, "utf8"))) hits.push(`${path.relative(ROOT, f)}: looks like a secret`);
  }
  assert.deepEqual(hits, []);
});
