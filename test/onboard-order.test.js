// @ts-check
// The 0.3 order, on a REAL daemon (the registry, the vault, the onboarding module and the wink module, in a temp home): a server with no owner takes no sign-in and no name; once it has an
// owner, the person's own session (with their presence) signs the AI account in and the status says connected; a model, another module or a second person (an agent) can do none of it.
// Not covered here: the device pairing exchange itself (core/wink/pairing.test.js) and the owner's session from signin.dev on a dev-kind box (a stand-in): the owner is marked by the
// tailnet owner flag the module also honours (network.ownerSeen), and the presence is the test stand-in (test/helpers present).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
const KEY = "sk-ant-api03-" + "a".repeat(60);
const code = (/** @type {any} */ r) => (r && r.error && r.error.code) || (r && r.data ? "OK" : "none");

/** @param {import("node:test").TestContext} t @param {any} network */
async function box(t, network = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, network: { onboardPort: 0, ...network } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  return d;
}

test("a server with no owner takes no sign-in, no name and no finish, from any caller", { timeout: 60_000 }, async t => {
  const d = await box(t);
  assert.equal((await d.registry.call("onboard.status", {}, "deck")).data.owned, false, "a fresh server says it has no owner");
  for (const caller of ["deck", "cli", "local", "module:onboard", "mcp", "module:other"]) {
    for (const [tool, input] of [["onboard.claude", { mode: "api-key", key: KEY }], ["onboard.name", { action: "claim", name: "alexbox", confirm: true }], ["onboard.finish", {}]]) {
      const r = await d.registry.call(/** @type {string} */ (tool), input, caller);
      assert.ok(r.error, `${caller} ${tool} must be refused, got ${code(r)}`);
      assert.ok(/^(pair_first|denied|presence_required|no_such_tool)$/.test(r.error.code || ""), `${caller} ${tool}: ${r.error.code} ${r.error.message}`);
    }
  }
  const items = (await d.registry.call("vault.list", {}, "cli")).data.items;
  assert.ok(!items.some((/** @type {any} */ i) => i.name === "anthropic-api-key"), "nothing was stored");
});

test("once the server has an owner, the person's own session signs the AI account in and the status says connected", { timeout: 60_000 }, async t => {
  const d = await box(t, { ownerSeen: true });
  const before = await d.registry.call("onboard.status", {}, "deck");
  assert.ok(before.data, JSON.stringify(before.error));
  assert.equal(before.data.owned, true);
  const put = await d.registry.call("onboard.claude", { mode: "api-key", key: KEY }, "deck");
  assert.ok(put.data, `the owner's session: ${JSON.stringify(put.error)}`);
  assert.equal(put.data.state, "done", JSON.stringify(put.data)); assert.equal(put.data.signedIn, true, JSON.stringify(put.data)); assert.equal(put.data.via, "api-key");
  assert.ok(!JSON.stringify(put).includes(KEY), "the key never comes back");
  const after = (await d.registry.call("onboard.status", {}, "deck")).data;
  const c = after.detail && after.detail.claude;
  assert.ok(c && c.signedIn === true && c.state === "done" && c.via === "api-key", JSON.stringify(after.detail));
  assert.equal(after.steps.claude, "done");
  assert.equal(after.owned, true, "the status says the server has an owner, so the app can show the chip before any tap");
  const items = (await d.registry.call("vault.list", {}, "cli")).data.items;
  assert.ok(items.some((/** @type {any} */ i) => i.name === "anthropic-api-key"), "the credential is in the vault");
  // Disconnect: the credential leaves the vault and the step reads as not signed in.
  const off = await d.registry.call("onboard.claude", { mode: "disconnect" }, "deck");
  assert.ok(off.data, JSON.stringify(off.error));
  assert.ok(!(await d.registry.call("vault.list", {}, "cli")).data.items.some((/** @type {any} */ i) => i.name === "anthropic-api-key"), "the credential is gone");
  const gone = (await d.registry.call("onboard.status", {}, "deck")).data;
  assert.notEqual(gone.steps.claude, "done");
  assert.equal(code(await d.registry.call("onboard.claude", { mode: "disconnect" }, "mcp")), "denied", "a model cannot disconnect");
});

test("with an owner, a model, another module, an agent and a second person's label still cannot sign in or claim a name", { timeout: 60_000 }, async t => {
  const d = await box(t, { ownerSeen: true });
  for (const caller of ["mcp", "mcp:thread:t", "mcp:agent:a", "module:other", "agent:juno", "tailnet-guest:bob", "anonymous", "hook"]) {
    for (const [tool, input] of [["onboard.claude", { mode: "api-key", key: KEY }], ["onboard.name", { action: "claim", name: "alexbox", confirm: true }], ["onboard.tailscale", { action: "connect" }], ["onboard.finish", {}]]) {
      const r = await d.registry.call(/** @type {string} */ (tool), input, caller);
      assert.ok(r.error && /^(denied|no_such_tool|not_allowed|forbidden)$/.test(r.error.code || ""), `${caller} ${tool} -> ${code(r)} ${r.error ? r.error.message : ""}`);
    }
  }
  const agentOnPerson = await d.registry.call("onboard.claude", { mode: "api-key", key: KEY }, "deck", { agent: "juno" });
  assert.ok(agentOnPerson.error, "an agent riding the person's surface is refused");
  const items = (await d.registry.call("vault.list", {}, "cli")).data.items;
  assert.ok(!items.some((/** @type {any} */ i) => i.name === "anthropic-api-key"), "nothing was stored");
});

test("there is no first-passkey path: onboard.passkey refuses with the pairing message, and no status or link answer carries a passkey link", { timeout: 60_000 }, async t => {
  for (const network of [{}, { ownerSeen: true }]) {
    const d = await box(t, network);
    for (const caller of ["deck", "cli", "local", "onboard", "mcp"]) {
      const r = await d.registry.call("onboard.passkey", {}, caller);
      assert.ok(r.error, `${caller} must be refused`);
      assert.ok(/Pair this server to your Vyre app first|denied|no_such_tool/.test(String(r.error.message) + String(r.error.code)), `${caller}: ${JSON.stringify(r.error)}`);
    }
    const st = await d.registry.call("onboard.status", {}, "deck");
    assert.ok(!JSON.stringify(st.data).includes("passkeyUrl"), "the status offers no passkey link");
    const link = await d.registry.call("onboard.link", { mint: false }, "cli");
    assert.ok(!JSON.stringify(link).includes("passkeyUrl"), "the link answer offers none either");
  }
});

test("`owned` follows whichever way the machine's owner exists: a paired server, a this-computer home after the identity is claimed, and a fresh home of either kind is not owned (and says the first step)", { timeout: 90_000 }, async t => {
  // A fresh server: not owned; the first step is to pair. A paired one (the tailnet owner flag stands in for the pairing): owned, no first step.
  const fresh = await box(t);
  const f = (await fresh.registry.call("onboard.status", {}, "deck")).data;
  assert.deepEqual([f.owned, f.ownerFirst], [false, "pair"]);
  const paired = await box(t, { ownerSeen: true });
  const p = (await paired.registry.call("onboard.status", {}, "deck")).data;
  assert.deepEqual([p.owned, p.ownerFirst], [true, null]);
  // A this-computer home (solo: no pairing): not owned until the person claims their identity there, then owned.
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
  const port = await new Promise(res => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const pt = /** @type {any} */ (sv.address()).port; sv.close(() => res(pt)); }); });
  const child = spawn(process.execPath, [script, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "mac", machine: "solo", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, presence: present, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "deck" });
  const before = (await deck("onboard.status")).data;
  assert.deepEqual([before.owned, before.ownerFirst], [false, "name"], "a fresh this-computer home: not owned, the first step is the name");
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  const after = (await deck("onboard.status")).data;
  assert.deepEqual([after.owned, after.ownerFirst], [true, null], "after the claim the owner exists");
});
