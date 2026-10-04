// @ts-check
// The local stand-in for the names directory (scripts/standin-directory.mjs): started as a real process on a loopback port, a real identity is claimed over real HTTP with the
// production client and identity code, resolves, and a second claim of the same name is refused. Nothing here touches vyre.run.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { idDirectory, memorySeen } from "../lib/identity/directory.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { createIdentityOps } from "../core/spaces/identity-ops.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("the stand-in directory: a real process on loopback; claim, resolve and a taken name over real HTTP with the production client", async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const base = `http://127.0.0.1:${port}`;
  const make = () => {
    const home = tempHome(t);
    const store = fileIdentityStore(path.join(home, "spaces"));
    const seen = memorySeen();
    const dir = idDirectory({ base, seen });
    return { dir, store, ops: createIdentityOps({ store, dir, seen, now: Date.now, stretch: { memoryKiB: 64, passes: 1 } }) };
  };
  const alex = make(), other = make();
  const made = await alex.ops.create({ name: "alex", deviceLabel: "walk" });
  assert.match(made.recoveryCode, /^[a-z2-7-]{32}$/);
  const r = await other.dir.resolve("alex");
  assert.equal(r.ok, true);
  assert.equal(r.id, alex.store.status().id);
  await assert.rejects(other.ops.create({ name: "alex" }), e => /** @type {any} */ (e).code === "taken");
  assert.equal((await other.dir.check("alex")).status, "taken");
});
