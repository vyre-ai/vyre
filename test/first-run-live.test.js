// @ts-check
// The two live paths on a real daemon: creating a space returns its id and makes its vault, and adding a computer dials that space's server and stays live there.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_TEST_MASTER_KDF = "cheap";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const PASSWORD = "correct horse battery";
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

async function directory() {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { child.stdout.on("data", (d) => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", (c) => rej(new Error(`the stand-in exited early (${c})`))); });
  return { base: `http://127.0.0.1:${port}`, close: () => child.kill("SIGTERM") };
}

/** @param {import("node:test").TestContext} t @param {any} config @param {string[]} lines */
async function up(t, config, lines) {
  let stop = async () => {};
  const root = tempHome(t, { stop: () => stop() });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  const d = await start({ root, kernel: true, log: (m) => lines.push(String(m)) });
  stop = () => d.stop();
  return { d, root };
}

test("creating a space on a live daemon returns the space id and makes that space's vault", { timeout: 120000 }, async (t) => {
  const dir = await directory();
  const lines = /** @type {string[]} */ ([]);
  const { d } = await up(t, { machine: "server", name: "juniper", transcripts: [], vault: { keystore: "file" }, names: { directory: dir.base }, modules: { disable: ["recall", "memory", "learn"] } }, lines);
  t.after(() => dir.close());
  const call = (tool, input = {}, caller = "cli") => d.registry.call(tool, input, caller);
  const made = await call("identity.create", { username: "alex", password: PASSWORD });
  assert.ok(!made.error, JSON.stringify(made.error));
  const opened = await call("onboard.space.open", { kind: "linux", name: "juniper" });
  assert.ok(!opened.error, `${JSON.stringify(opened.error)} ${lines.slice(-20).join(" | ")}`);
  const code = String(opened.data.command || "").match(/VYRE_CODE=([A-Za-z0-9_-]+)/);
  assert.ok(code, opened.data.command);
  const redeemed = await call("wink.server.install-redeem", { code: code[1] }, "module:relay");
  assert.ok(!redeemed.error, `${JSON.stringify(redeemed.error)} ${lines.filter((l) => /adopt|install|owner|space/i.test(l)).slice(-20).join(" | ")}`);
  const status = await call("wink.install.status", {});
  assert.ok(!status.error, JSON.stringify(status.error));
  assert.match(String(status.data.space || ""), /^spc_[a-z2-7]{8,}$/, JSON.stringify(status.data));
  assert.equal(status.data.space, d.kernel.id.space);
  const polled = await call("onboard.space.poll", { id: opened.data.id });
  assert.ok(!polled.error, JSON.stringify(polled.error));
  assert.equal(polled.data.online, true);
  assert.equal(polled.data.space, status.data.space);
  const vault = await call("vault.space.status", { space: status.data.space });
  assert.ok(!vault.error, JSON.stringify(vault.error));
  assert.equal(vault.data.exists, true);
  assert.equal(vault.data.generation, 1);
  const again = await call("onboard.space.poll", { id: opened.data.id });
  assert.ok(!again.error, JSON.stringify(again.error));
  assert.equal(again.data.online, true);
});
