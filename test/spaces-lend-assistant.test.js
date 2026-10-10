// @ts-check
// Another person's assistant is that person, never the home's owner: it cannot switch the owner's computer lend off or on (spaces.devices.lend). A real
// vyred with an identity of its own (the stand-in names directory), a Space it hosts, and a second person who is a member of that Space only. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("a member's assistant cannot lend or stop the owner's computer, and every Space list is for the person on the call", { timeout: 180_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const mk = (/** @type {string} */ name) => { const root = tempHome(t); fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name, transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } })); return root; };
  const aliceRoot = mk("alice-home"), bobRoot = mk("bob-home");
  const alice = await start({ root: aliceRoot, kernel: true, log: () => {} });
  t.after(() => alice.stop());
  const bob = await start({ root: bobRoot, kernel: true, log: () => {} });
  t.after(() => bob.stop());
  const A = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root: aliceRoot, caller: "cli" });
  const B = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root: bobRoot, caller: "cli" });
  const a = (await A("spaces.identity.create", { name: "alice" })).data;
  const b = (await B("spaces.identity.create", { name: "bobby" })).data;
  fs.writeFileSync(path.join(aliceRoot, "dev-presence-stand-in"), "");
  const sp = await alice.kernel.spaces.host({ owner: a.id, name: "sharedroom" });
  const aliceChain = sp.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000a", person: a.id, path: "direct", session: "s" });
  await sp.gateway.grants.setRole(aliceChain, { person: b.id, role: "member" }, { presence: { method: "stand-in" } });

  // Bob's assistant: a session on alice's box for Bob with an assistant hop
  const bobChain = alice.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev000000000000b0", person: b.id, path: "direct", session: "sb" });
  const assistant = { token: (await alice.kernel.surfaces.open(bobChain, { agent: "assistant" })).token };
  const asBobsAssistant = (/** @type {string} */ tool, /** @type {any} */ input) => alice.registry.call(tool, input, "cli", assistant);
  for (const on of [false, true]) {
    const r = await asBobsAssistant("spaces.devices.lend", { space: alice.kernel.id.space, device: a.eid, on });
    assert.ok(r.error, `lend on=${on}: refused`);
    // turning it on asks for the person's own yes first (the registry's presence rule); stopping it has no such rule, so the caller check is the only guard
    if (!on) assert.equal(r.error.code, "forbidden", `lend off: it is not Bob's to do (${JSON.stringify(r.error)})`);
  }
  // the Space list is for the person on the call, on an identity box too: Bob (and his assistant) get Bob's one Space, never the home identity's list; the local terminal is the owner's own
  const idsOf = (/** @type {any} */ r) => (r.data || []).map((/** @type {any} */ x) => x.id).sort();
  assert.deepEqual(idsOf(await asBobsAssistant("spaces.list", {})), [sp.space], "Bob's assistant lists Bob's one Space");
  assert.deepEqual(idsOf(await alice.registry.call("spaces.list", {}, "cli", { token: (await alice.kernel.surfaces.open(bobChain, {})).token })), [sp.space], "Bob himself, the same");
  assert.ok(idsOf(await alice.registry.call("spaces.list", {}, "cli", {})).includes(alice.kernel.id.space), "the local terminal is the owner's own list");
  assert.deepEqual(((await asBobsAssistant("spaces.records.status", {})).data || { spaces: [] }).spaces.map((/** @type {any} */ x) => x.space), [sp.space]);
});

