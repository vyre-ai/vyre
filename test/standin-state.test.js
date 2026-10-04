// @ts-check
// The stand-in names directory with --state: a claim survives a restart of the process.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome } from "./helpers.js";
import { idDirectory, memorySeen } from "../lib/identity/directory.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { createIdentityOps } from "../core/spaces/identity-ops.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
/** @param {string} state @param {import("node:test").TestContext} t */
async function start(state, t) {
  const child = spawn(process.execPath, ["scripts/standin-directory.mjs", "--port", String(PORT), "--state", state, "--claims-per-ip", "50"], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", () => rej(new Error("stand-in exited"))); });
  return child;
}

test("stand-in directory --state: an identity claimed before a restart resolves after it", async t => {
  const home = tempHome(t);
  const state = path.join(home, "dir-state.bin");
  let child = await start(state, t);
  const seen = memorySeen();
  const dir = idDirectory({ base: `http://127.0.0.1:${PORT}`, fetch: (u, i) => fetch(u, i), now: () => Date.now(), seen });
  const store = fileIdentityStore(path.join(home, "spaces"));
  const ops = createIdentityOps({ store, dir, seen, now: () => Date.now(), emit: () => {}, stretch: { memoryKiB: 64, passes: 1 } });
  const made = await ops.create({ name: "statetest", deviceLabel: "t" });
  assert.equal(made.status.name, "statetest");
  await new Promise(r => setTimeout(r, 800));
  await new Promise(r => { child.on("exit", r); child.kill("SIGTERM"); });
  child = await start(state, t);
  const r = await dir.resolve(made.status.name, {});
  assert.equal(r.ok, true, JSON.stringify(r));
});
