// @ts-check
// The folder the daemon writes for the host helper (lib/publish/server-folder.js): its shape, its modes, and that no path comes from a caller.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestText, writeServerFolder, removeServerFolder, DEP_RE } from "./server-folder.js";

const SPC = "spc_abcdefghijkl", DEP = "dep_0123456789abcdef";
const tmp = (/** @type {import("node:test").TestContext} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sf-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const F = { name: "northwind", version: 3, port: 8080, memoryMb: 512, cpus: 0.5, pids: 256, health: { path: "/", ok: [200, 404], startS: 60 } };

test("the settings are exactly the keys the helper knows, one per line", () => {
  assert.equal(requestText(F), "name=northwind\nversion=3\nport=8080\nmem=512\ncpus=0.5\npids=256\nhealth_path=/\nhealth_ok=200+404\nhealth_start=60\nsecrets=-\n");
  assert.match(requestText({ ...F, secrets: ["A_KEY", "B_KEY"] }), /secrets=A_KEY\+B_KEY\n$/);
  assert.match(requestText({ ...F, health: { path: "/", ok: [200] } }), /health_start=60/);
  assert.ok(DEP_RE.test(DEP) && !DEP_RE.test("dep_xyz"));
});

test("the folder holds the settings, the context and the secrets with modes only the daemon can read, replaces an earlier one, and refuses a path that leaves it", t => {
  const home = tmp(t);
  const dir = writeServerFolder({ home, space: SPC, deployment: DEP, request: requestText(F), files: [{ path: "Dockerfile", content: "FROM a" }, { path: "src/a.js", content: Buffer.from("x") }], secrets: { GREETING: "hi" } });
  assert.equal(dir, path.join(home, "publish", SPC, "servers", DEP));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["ctx", "request", "secrets"]);
  assert.equal(fs.readFileSync(path.join(dir, "ctx", "src", "a.js"), "utf8"), "x");
  assert.equal(fs.statSync(path.join(dir, "secrets", "GREETING")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  writeServerFolder({ home, space: SPC, deployment: DEP, request: requestText(F) });
  assert.deepEqual(fs.readdirSync(dir), ["request"], "the earlier folder is replaced, not added to");
  assert.throws(() => writeServerFolder({ home, space: SPC, deployment: DEP, request: "", files: [{ path: "../../escape", content: "x" }] }), /leaves the folder/);
  assert.throws(() => writeServerFolder({ home, space: SPC, deployment: DEP, request: "", secrets: { lower: "x" } }), /environment variable/);
  assert.throws(() => writeServerFolder({ home, space: "../etc", deployment: DEP, request: "" }), /not a Space/);
  assert.throws(() => writeServerFolder({ home, space: SPC, deployment: "dep_../x", request: "" }), /not a deployment/);
  removeServerFolder({ home, space: SPC, deployment: DEP });
  assert.ok(!fs.existsSync(dir));
  removeServerFolder({ home, space: "../etc", deployment: DEP });
});
