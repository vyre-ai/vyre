// @ts-check
// The two live paths on a real daemon: creating a space returns its id and makes its vault, and adding a computer dials that space's server and stays live there.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { createRelay } from "../relay/node/server.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { claimServerSpace } from "../apps/app/src/identity/claim-space.js";

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

test("adding a computer dials the space server and the computer stays live there", { timeout: 180000 }, async (t) => {
  const dir = await directory();
  const relay = createRelay();
  const relayUrl = await relay.listen();
  const serverLines = /** @type {string[]} */ ([]);
  const computerLines = /** @type {string[]} */ ([]);
  const serverBox = await up(t, { machine: "server", name: "juniper-server", transcripts: [], vault: { keystore: "file" }, names: { directory: dir.base }, relay: { enabled: true, url: relayUrl }, modules: { disable: ["recall", "memory", "learn"] } }, serverLines);
  const computerBox = await up(t, { machine: "server", name: "alex-computer", transcripts: [], vault: { keystore: "file" }, names: { directory: dir.base }, relay: { enabled: false }, modules: { disable: ["recall", "memory", "learn"] } }, computerLines);
  const server = serverBox.d;
  const computer = computerBox.d;
  const computerRoot = computerBox.root;
  t.after(() => relay.close());
  t.after(() => dir.close());
  const person = await computer.registry.call("identity.create", { username: "alex", password: PASSWORD }, "cli");
  assert.ok(!person.error, JSON.stringify(person.error));
  const issued = await computer.registry.call("wink.install.issue", { os: "linux" }, "cli");
  assert.ok(!issued.error, `${JSON.stringify(issued.error)} ${computerLines.slice(-20).join(" | ")}`);
  const code = String(issued.data.line || "").match(/VYRE_CODE=([A-Za-z0-9_-]+)/);
  assert.ok(code, issued.data.line);
  const redeemed = await server.registry.call("wink.server.install-redeem", { code: code[1] }, "module:relay");
  assert.ok(!redeemed.error, `${JSON.stringify(redeemed.error)} ${serverLines.filter((l) => /adopt|install|owner/i.test(l)).slice(-20).join(" | ")}`);
  const deadline = Date.now() + 20000;
  let connected = null;
  while (Date.now() < deadline) {
    connected = await server.registry.call("relay.status", {}, "cli");
    if (connected.data && connected.data.connected && connected.data.route) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(connected && connected.data && connected.data.connected, JSON.stringify(connected && connected.data));
  const route = await server.registry.call("relay.route.id", {}, "module:wink");
  assert.ok(!route.error, JSON.stringify(route.error));
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const rootPublic = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  const store = fileIdentityStore(path.join(computerRoot, "spaces"));
  const st = store.status();
  await claimServerSpace({
    identity: { id: String(st.id), name: st.name, eid: String(st.eid), ops: store.ops(), key: { sign: async (m) => new Uint8Array(await store.sign(Buffer.from(m))) } },
    name: "juniper", base: dir.base, route: { relay: relayUrl, route: String(route.data.route), box: String(route.data.box) },
    host: async () => ({ space: server.kernel.id.space, rootPublic }),
  });
  const added = await computer.registry.call("onboard.computer.add", { url: "https://juniper.vyre.run", username: "alex", password: PASSWORD }, "cli");
  assert.ok(!added.error, `${JSON.stringify(added.error)} ${serverLines.filter((l) => /chain hello|refused|relay/i.test(l)).slice(-30).join(" | ")} || ${computerLines.slice(-15).join(" | ")}`);
  assert.equal(added.data.live, true);
  assert.equal("password" in added.data, false);
  assert.equal("carry" in added.data, false);
  assert.equal(added.data.devices.length, 1);
  const id = added.data.devices[0];
  const listed = await server.registry.call("relay.devices.all", {}, "module:wink");
  assert.ok(!listed.error, JSON.stringify(listed.error));
  const hit = listed.data.devices.find((/** @type {any} */ d) => d.id === id);
  assert.ok(hit, JSON.stringify(listed.data.devices));
  assert.equal(hit.online, true);
  const row = server.registry.deps.db.prepare("SELECT via_chain FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id);
  assert.ok(row && row.via_chain, "the computer is on the server by its identity");
});
