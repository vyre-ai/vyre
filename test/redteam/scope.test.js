// @ts-check
// Red-team refusals for an api-credential's read scope: a model or agent reads through a credential only inside its
// {projects, agents} scope, and a credential with no scope is for the person, their own unnamed session and the
// assistant. One test per finding, "redteam <ID>: <attack> is refused". These register the vault's request tool over a real
// vault in a temp folder with an injected resolver and transport (as core/vault/request.test.js does), because the
// scope is decided after the request is planned and a real daemon cannot resolve a made-up host; nothing here boots a
// vyred, so they run anywhere and nothing leaves the machine.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import * as saidTools from "../../core/vault/said.js";
import { register } from "../../core/vault/request.js";
import { SCRATCH } from "../scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const HOST = "graph.example.test";
const URL_ = `https://${HOST}/v1.0/me/messages`;

async function world(t, scope) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-scope-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "test-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {string[]} */ ([]) };
  const tools = new Map();
  const tool = (name, callers, description, input, run) => tools.set(name, { callers, run });
  const internal = (name, description, input, run) => tools.set(name, { callers: null, run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: async () => ({ error: { code: "no_such_tool", message: "x" } }), said,
    deps: { lookup: async () => [{ address: "93.184.216.34", family: 4 }], transport: async r => { net.calls.push(`${r.method} ${r.url.pathname}`); return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; } } });
  const cfg = { auth: { type: "bearer" }, hosts: [HOST], ...(scope ? { scope } : {}) };
  await v.put({ name: "ms", kind: "api-credential", fields: { config: JSON.stringify(cfg), secret: fake("s") } }, "cli");
  const read = (caller, meta = {}, extra = {}) => Promise.resolve().then(() => tools.get("vault.request").run({ credential: "ms", method: "GET", url: URL_, ...extra }, { caller, ...meta }))
    .then(data => ({ data }), error => ({ error }));
  return { v, net, read, put: (input, who) => v.put(input, who).then(data => ({ data }), error => ({ error })) };
}

const outside = r => { assert.equal(r.error?.code, "denied", String(r.error?.message)); assert.match(r.error.message, /scope/); };
const inside = r => assert.ok(r.data && r.data.status === 200, String(r.error?.message));

test("redteam RT-S1: a named agent outside the credential's scope reading through it is refused", async t => {
  const w = await world(t, { projects: "*", agents: ["kit"] });
  outside(await w.read("mcp:agent:juno", { agent: "juno" }));
  inside(await w.read("mcp:agent:kit", { agent: "kit" }));
  inside(await w.read("cli"));
  assert.equal(w.net.calls.length, 2, "the refused read never reached the network");
});

test("redteam RT-S2: a credential with no scope is refused to every named agent, and open to the person and their own session", async t => {
  const w = await world(t);
  for (const a of ["kit", "juno", "teammate-x"]) outside(await w.read(`mcp:agent:${a}`, { agent: a }));
  inside(await w.read("cli"));
  inside(await w.read("mcp", {}));
  assert.equal(w.net.calls.length, 2);
});

test("redteam RT-S3: a session bound to a project outside the credential's projects is refused", async t => {
  const w = await world(t, { projects: ["harlow-site"], agents: "*" });
  outside(await w.read("mcp", { project: "northwind" }));
  inside(await w.read("mcp", { project: "harlow-site" }));
});

test("redteam RT-S4: a model cannot give itself scope, and cannot claim to be the assistant", async t => {
  const w = await world(t);
  const wide = JSON.stringify({ auth: { type: "bearer" }, hosts: [HOST], scope: { projects: "*", agents: "*" } });
  for (const who of ["mcp", "mcp:agent:kit", "module:sessions", "module:connectors", "hook"]) {
    assert.ok((await w.put({ name: "ms", kind: "api-credential", fields: { config: wide, secret: fake("x") } }, who)).error, who);
  }
  // a claim in the call's own input is not heard: the agent's kind comes from vyred's meta, not from the model's words
  outside(await w.read("mcp:agent:kit", { agent: "kit" }, { agentKind: "assistant", agent_kind: "assistant", scope: { agents: ["kit"] } }));
  assert.equal(w.net.calls.length, 0);
});
