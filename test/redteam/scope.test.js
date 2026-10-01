// @ts-check
// Red-team refusals for an api-credential's read scope: a model or agent reads through a credential only inside its
// {projects, agents} scope, and a credential with no scope is for the person, their own unnamed session and the
// assistant. One runner test per finding, "redteam <ID>: <attack> is refused", against a real registry in a temp home.
// Runs on runners and the test box, never on the Mac. The host never resolves, so nothing leaves the machine: a read
// the scope lets through dies later on the name, which is how the tests tell "refused by the scope" from "let through".

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { tempHome, present } from "../helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const HOST = "graph.example.test";
const URL_ = `https://${HOST}/v1.0/me/messages`;

async function world(t, scope) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cfg = { auth: { type: "bearer" }, hosts: [HOST], ...(scope ? { scope } : {}) };
  assert.ok((await d.registry.call("vault.put", { name: "ms", kind: "api-credential", fields: { config: JSON.stringify(cfg), secret: fake("s") } }, "cli")).data);
  const read = (caller, meta = {}) => d.registry.call("vault.request", { credential: "ms", method: "GET", url: URL_ }, caller, meta);
  return { d, read };
}

const outside = r => { assert.equal(r.error?.code, "denied", JSON.stringify(r)); assert.match(r.error.message, /scope/); };
const inside = r => assert.ok(r.error && !/scope|denied/.test(r.error.message), `it was let through to the network: ${JSON.stringify(r.error)}`);

test("redteam RT-S1: a named agent outside the credential's scope reading through it is refused", async t => {
  const w = await world(t, { projects: "*", agents: ["kit"] });
  outside(await w.read("mcp:agent:juno", { agent: "juno" }));
  inside(await w.read("mcp:agent:kit", { agent: "kit" }));
  inside(await w.read("cli"));
});

test("redteam RT-S2: a credential with no scope is refused to every named agent, and open to the person and their own session", async t => {
  const w = await world(t);
  for (const a of ["kit", "juno", "teammate-x"]) outside(await w.read(`mcp:agent:${a}`, { agent: a }));
  inside(await w.read("cli"));
  inside(await w.read("mcp", {}));
});

test("redteam RT-S3: a session bound to a project outside the credential's projects is refused", async t => {
  const w = await world(t, { projects: ["harlow-site"], agents: "*" });
  outside(await w.read("mcp", { project: "northwind" }));
  inside(await w.read("mcp", { project: "harlow-site" }));
});

test("redteam RT-S4: a model cannot give itself scope, and cannot claim to be the assistant", async t => {
  const w = await world(t);
  const wide = JSON.stringify({ auth: { type: "bearer" }, hosts: [HOST], scope: { projects: "*", agents: "*" } });
  for (const who of ["mcp", "mcp:agent:kit", "module:sessions"]) {
    assert.ok((await w.d.registry.call("vault.put", { name: "ms", kind: "api-credential", fields: { config: wide, secret: fake("x") } }, who)).error, who);
  }
  // a claim in the call's own input is not heard: agentKind comes from vyred, not from the model
  outside(await w.d.registry.call("vault.request", { credential: "ms", method: "GET", url: URL_, agentKind: "assistant", agent_kind: "assistant" }, "mcp:agent:kit", { agent: "kit" }));
});
