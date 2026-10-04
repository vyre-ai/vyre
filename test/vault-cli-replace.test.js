// @ts-check
// `vyre vault edit` on an API credential, against a real vyred in a temp home:
// an API credential is never read back, so edit refuses it in plain words and offers replacing
// the key, which keeps its hosts.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upPresent } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "vyre");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

/** Run a program with piped stdin, collecting both streams. */
function spawnIt(bin, args, env, input) {
  return new Promise(resolve => {
    const p = spawn(bin, args, { env });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
const vyre = (home, args, input) => spawnIt(process.execPath, [BIN, ...args], { ...process.env, VYRE_HOME: home, NO_COLOR: "1" }, input);

function home(t, config) {
  const h = fs.mkdtempSync(path.join(SCRATCH, "vyre-test-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify(config));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); });
  return h;
}

/** --json prints exactly one line on stdout, and it parses. */
function one(r) {
  const lines = r.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got: ${r.out}`);
  return JSON.parse(lines[0]);
}


test("vault edit: an API credential cannot be edited, only its key replaced, and its hosts stay", async t => {
  const h = home(t, { name: "owner-box", vault: { keystore: "file" } });
  assert.equal((await upPresent(h)).code, 0);
  const config = JSON.stringify({ auth: { type: "bearer" }, hosts: ["graph.example.test"] });
  const made = await vyre(h, ["call", "vault.put", JSON.stringify({ name: "ms-graph", kind: "api-credential", fields: { config, secret: fake("key") } })]);
  assert.equal(made.code, 0, made.all);
  // Editing anything but the key is refused in plain words, and nothing changes.
  const other = await vyre(h, ["vault", "edit", "ms-graph", "--description", "x"]);
  assert.notEqual(other.code, 0);
  assert.match(other.all, /API credential: it cannot be edited, only its key replaced/);
  const wrongField = await vyre(h, ["vault", "edit", "ms-graph", "--field", "config"], fake("x"));
  assert.notEqual(wrongField.code, 0);
  // Replacing the key works and says what stayed.
  const replaced = await vyre(h, ["vault", "edit", "ms-graph", "--field", "secret"], fake("newkey"));
  assert.equal(replaced.code, 0, replaced.all);
  assert.match(replaced.all, /key replaced, hosts and readers unchanged/);
  // The stored config came along: another host is refused for the credential's hosts.
  const foreign = await vyre(h, ["call", "vault.request", JSON.stringify({ credential: "ms-graph", method: "GET", url: "https://elsewhere.example.test/x" })]);
  assert.match(foreign.all, /host/i);
  // An ordinary item still edits as before.
  assert.equal((await vyre(h, ["vault", "add", "api-token", "--kind", "api-key"], fake("tok"))).code, 0);
  assert.equal((await vyre(h, ["vault", "edit", "api-token", "--description", "for the bakery"])).code, 0);
});
