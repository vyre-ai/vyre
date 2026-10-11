// @ts-check
// ONE SPACE PER SERVER: the server's own (home) Space can be given its team name. spaces.name-here makes its root key once (held exactly as spaces.host-here holds a hosted Space's), the app then publishes the
// directory record for the existing id, and the listing shows the team name; a hosted Space is unchanged. A real daemon with its own kernel on a test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome, present } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";

/** @param {string} dir @param {string} id */
const keyFileOf = (dir, id) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name === "node_modules") continue; const r = keyFileOf(p, id); if (r) return r; } else if (e.name === "root.key" && path.basename(dir) === id) return p; } return null; };

test("naming the server's own Space makes its key once, lists it under the team name, and leaves a hosted Space as it was", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "name-box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, presence: present, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const home = d.kernel.id.space;

  assert.equal(keyFileOf(root, home), null, "an unnamed home Space has no root key: nothing to prove it with");
  assert.equal((await deck("spaces.name-here", { name: "x" })).error?.code, "bad_name", "a bad name is refused and says what a name is");
  assert.equal(keyFileOf(root, home), null, "a refused name makes no key");

  const first = await deck("spaces.name-here", { name: "teamone" });
  assert.ok(!first.error, JSON.stringify(first.error));
  assert.equal(first.data.space, home, "it is the server's own Space, not a new one");
  assert.match(first.data.rootPublic, /^[A-Za-z0-9_-]{43}$/);
  const keyFile = keyFileOf(root, home);
  assert.ok(keyFile, "the key is held with the Space");
  assert.equal(fs.statSync(/** @type {string} */ (keyFile)).mode & 0o777, 0o600, "held exactly as host-here holds one");
  const text = fs.readFileSync(/** @type {string} */ (keyFile), "utf8");

  const second = await deck("spaces.name-here", { name: "teamone", done: true });
  assert.equal(second.data.rootPublic, first.data.rootPublic, "a second naming does not make a second key");
  assert.equal(fs.readFileSync(/** @type {string} */ (keyFile), "utf8"), text, "the key file is untouched");

  const listed = (await deck("spaces.list", {})).data;
  const rows = Array.isArray(listed) ? listed : listed.spaces;
  const row = rows.find((/** @type {any} */ r) => r.id === home);
  assert.equal(row.label, "teamone", "the home Space is listed under its team name");
  assert.equal(row.name, "teamone.vyre.run");
  assert.equal(rows.filter((/** @type {any} */ r) => r.id === home).length, 1, "and only once");

  // a different name after `done` is refused with the next step, and nothing changes
  const other = await deck("spaces.name-here", { name: "teamtwo" });
  assert.equal(other.error?.code, "already_named");
  assert.match(other.error?.message || "", /keep using teamone/);
  assert.equal(fs.readFileSync(/** @type {string} */ (keyFile), "utf8"), text);

  // nobody but the owner's own direct hand names it: a member, and the owner's assistant (two hops), are both refused and make no key
  const asFacts = (/** @type {any} */ facts) => d.registry.call("spaces.name-here", { name: "teamone" }, "cli", { kernelFacts: facts });
  const member = await asFacts({ kind: "device", device_key_id: "d-member", person: "per_" + "b".repeat(26), path: "direct", session: "s" });
  assert.equal(member.error?.code, "forbidden", JSON.stringify(member));
  const assistant = await asFacts({ kind: "agent_session", vouched: true, person: d.kernel.id.owner, agent: "assistant", session: "s" });
  assert.equal(assistant.error?.code, "forbidden", JSON.stringify(assistant));

  // a hosted Space is unchanged: its own key, its own name, the home's naming does not touch it
  const hosted = await deck("spaces.host-here", { name: "servedhere" });
  assert.ok(!hosted.error, JSON.stringify(hosted.error));
  assert.notEqual(hosted.data.rootPublic, first.data.rootPublic);
  assert.ok(keyFileOf(root, hosted.data.space));
  assert.equal(hosted.data.existed, false);
});

test("a home Space that was never named is listed as the person's own", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "plain-box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, presence: present, log: () => {} });
  t.after(() => d.stop());
  const listed = (await call("spaces.list", {}, { root, caller: "cli" })).data;
  const rows = Array.isArray(listed) ? listed : listed.spaces;
  assert.equal(rows.find((/** @type {any} */ r) => r.id === d.kernel.id.space).label, "personal");
});
