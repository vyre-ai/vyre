// @ts-check
// After `npm i -g` over an install, the vyred started before it runs the old code. `vyre up`
// sees its build differ from the installed one and restarts it, and only ever stops Vyre's own
// pid. And `vyre assistant` makes the assistant that `vyre up`'s ending used to leave "not set up".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const vyre = (args, env) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" } }, (e, stdout, stderr) => resolve({ code: e ? e.code ?? 1 : 0, out: stdout + stderr })));

/** A temp home with a running vyred, and VYRE_HOME pointed at it for in-process calls. */
async function running(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, network: { onboardPort: 0 } }));
  const env = { VYRE_HOME: root, VYRE_TAILSCALE_BIN: path.join(root, "no-tailscale") };
  const prev = { home: process.env.VYRE_HOME, ts: process.env.VYRE_TAILSCALE_BIN };
  Object.assign(process.env, env);
  t.after(async () => {
    await vyre(["down"], env);
    if (prev.home === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = prev.home;
    if (prev.ts === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev.ts;
  });
  assert.equal((await vyre(["up"], env)).code, 0);
  const { request } = await import("../core/daemon/client.js");
  const health = async () => (await request("GET", "/v1/health", undefined, { root })).data;
  return { root, env, health };
}

test("upgrade: a vyred running another build than the one installed is restarted by vyre up, and says so", async t => {
  const { root, health } = await running(t);
  const before = await health();
  const { up } = await import("../core/cli/commands/up.js");
  const { VERSION } = await import("../core/daemon/index.js");
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  // The installed package, as a release stamps it: a commit the running vyred is not on.
  const installed = () => ({ version: VERSION, commit: "0123456789abcdef", dirty: false, stamped: true });
  assert.equal(await up([], { build: installed }), 0);
  t.mock.restoreAll();
  const after = await health();
  assert.notEqual(after.pid, before.pid, "a new vyred");
  assert.match(lines.join("\n"), new RegExp(`updated · restarted vyred \\(${VERSION}.* → ${VERSION} · 0123456\\)`));
  assert.ok(fs.existsSync(path.join(root, "vyre.db")));

  // The same stamp as the running one: left alone.
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  const same = () => ({ version: VERSION, commit: after.commit, dirty: false, stamped: true });
  if (after.commit && after.dirty === false) {
    await up([], { build: same });
    assert.equal((await health()).pid, after.pid, "same build, same vyred");
  }
  t.mock.restoreAll();
});

test("upgrade: a pid file that names someone else's process stops nothing", async t => {
  const { root, health } = await running(t);
  const h = await health();
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => { try { other.kill(); } catch {} });
  const pidFile = path.join(root, "vyred.pid");
  const saved = fs.readFileSync(pidFile, "utf8");
  fs.writeFileSync(pidFile, String(other.pid));
  const { stop } = await import("../core/cli/daemonctl.js");
  const r = await stop({ pid: h.pid });
  assert.equal(r.ok, false);
  assert.match(String(r.why), /stopped nothing/);
  assert.doesNotThrow(() => process.kill(/** @type {number} */ (other.pid), 0), "the other process is untouched");
  assert.equal((await health()).pid, h.pid, "vyred is untouched too");
  fs.writeFileSync(pidFile, saved);
});

test("assistant: none yet says the command; a name makes it as onboarding does; then it is named", async t => {
  const { env } = await running(t);
  const none = await vyre(["assistant"], env);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /no assistant yet[\s\S]*vyre assistant Juno/);
  const made = await vyre(["assistant", "Juno"], env);
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /made your assistant Juno \(juno\)/);
  const again = await vyre(["assistant", "--json"], env);
  const a = JSON.parse(again.out);
  assert.deepEqual([a.name, a.kind, a.projects], ["juno", "assistant", "*"]);
  assert.match((await vyre(["assistant", "Kit"], env)).out, /already have an assistant/);
});

test("assistant: the ending points at the command instead of a dead end", async () => {
  const { ending } = await import("../core/cli/ending.js");
  assert.match(ending({ address: "https://alex.vyre.run", assistant: null }).join("\n"), /your assistant  none yet: vyre assistant <name>/);
  assert.match(ending({ address: "https://alex.vyre.run", assistant: "juno" }).join("\n"), /your assistant  juno/);
});
