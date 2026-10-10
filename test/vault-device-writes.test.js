// @ts-check
// R031 trust queue 3: the person's own device writes to shared vaults. On a real daemon, a device that signed in (the relay's cookie session) creates, lists and syncs shared vaults with no question, and
// invites, changes a role, removes a member or rotates a key only with the person's one yes (the vault moment: presence_required names it, and the card sentence says what will happen). A model session
// (mcp, harness) is refused every one of them before the tool runs. With the yes given (the test presence stand-in), the call reaches the tool itself. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import { COOKIE } from "../core/presence/person.js";
import { lineOfOp } from "../lib/one-yes.js";
import { tempHome, present } from "./helpers.js";

const DEVICE = "abcdefghijklmnop";
const ASKS_YES = [
  ["vault.vaults.rotate", { vault: "team" }],
  ["vault.members.invite", { vault: "team", person: "dana" }],
  ["vault.members.role", { vault: "team", person: "dana", role: "admin" }],
  ["vault.members.remove", { vault: "team", person: "dana" }],
];
const NO_YES = [["vault.vaults.list", {}], ["vault.vaults.sync", {}]];
const MODELS = ["mcp", "harness"];

/** A daemon with the owner's device signed in, answering as the relay does for it. @param {import("node:test").TestContext} t @param {boolean} yes the test presence stand-in (every yes given) */
async function box(t, yes) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, ...(yes ? { presence: present } : {}), log: () => {} });
  t.after(() => d.stop());
  const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
  const sess = d.registry.deps.cliSessions.startStandIn("dev1");
  /** @param {string} tool @param {any} input */
  const device = async (tool, input) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: "POST", url: `/v1/tools/${tool}`, headers: { host: "relay", "content-type": "application/json", cookie: `${COOKIE}=${sess.token}`, "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" } });
    let out = "", status = 0;
    const res = { setHeader() {}, writeHead(/** @type {number} */ s) { status = s; }, end(b = "") { out += b; }, headersSent: false };
    await ctx.handler({})(req, res, `device:${DEVICE}`, { kind: "device", stableId: "dev1", node: "dev1", login: null, tags: [], caps: {} });
    return { status, ...(out ? JSON.parse(out) : {}) };
  };
  return { d, device };
}

test("a signed-in device makes, lists and syncs shared vaults with no question; a model is refused all of it", async t => {
  const { d, device } = await box(t, false);
  const made = await device("vault.vaults.create", { name: "team" });
  assert.equal(made.status, 200, JSON.stringify(made));
  assert.equal(made.data.vault.name, "team");
  assert.equal(made.data.vault.role, "owner");
  assert.deepEqual((await device("vault.vaults.list", {})).data.vaults.map((/** @type {any} */ v) => v.name), ["team"]);
  assert.equal((await device("vault.vaults.sync", {})).status, 200);
  for (const [tool, input] of [["vault.vaults.create", { name: "x" }], ...ASKS_YES, ["vault.members.accept", { invite: "vyre-invite:v1:x" }]]) {
    for (const who of MODELS) {
      const r = await d.registry.call(/** @type {string} */ (tool), input, who);
      assert.equal(r.error && r.error.code, "denied", `${who} is refused ${tool}: ${JSON.stringify(r)}`);
    }
  }
});

test("a device's invite, role change, removal and key rotation each ask for the one yes, in the vault moment, and say what will happen", async t => {
  const { device } = await box(t, false);
  assert.equal((await device("vault.vaults.create", { name: "team" })).status, 200);
  for (const [tool, input] of ASKS_YES) {
    const r = await device(/** @type {string} */ (tool), input);
    assert.equal(r.status, 403, `${tool}: ${JSON.stringify(r)}`);
    assert.equal(r.error.code, "presence_required", tool);
    assert.equal(r.error.moment, "vault", tool);
    assert.equal(r.error.request.op, tool);
    assert.match(lineOfOp(/** @type {string} */ (tool), /** @type {any} */ (input), "Alex's phone"), /"team"/, `${tool}: the card sentence names the vault`);
  }
  for (const [tool, input] of NO_YES) assert.equal((await device(/** @type {string} */ (tool), input)).status, 200, `${tool} asks for nothing`);
});

test("with the yes given, each of the four reaches the tool itself and answers in the tool's own words", async t => {
  const { device } = await box(t, true);
  assert.equal((await device("vault.vaults.create", { name: "team" })).status, 200);
  const rotated = await device("vault.vaults.rotate", { vault: "team" });
  assert.deepEqual([rotated.status, rotated.data.vault, rotated.data.kv], [200, "team", 2]);
  for (const [tool, input] of ASKS_YES.slice(1)) {
    const r = await device(/** @type {string} */ (tool), input);
    assert.notEqual(r.error && r.error.code, "presence_required", `${tool} passed the yes`);
    assert.notEqual(r.error && r.error.code, "denied", `${tool} is open to the device`);
    assert.match(r.error.message, /dana|card|pinned|verified/i, `${tool} reached the Vault, which says what to do next: ${r.error.message}`);
  }
  const bad = await device("vault.members.accept", { invite: "not-an-invite" });
  assert.notEqual(bad.error && bad.error.code, "denied");
});
