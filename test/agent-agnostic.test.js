// @ts-check
// Agents rule 9 (owner ruling of 16 Oct 2026): secret egress and MCP exposure are the same for
// every session adapter. The set is the registry's providers plus the built-in ones, not a hand list.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { sessionAdapters, sessionCaller } from "../lib/agent-adapters.js";
import { agentClaim } from "../core/modules/index.js";
import { modelCaller, scrubVaultResult } from "../core/modules/needs-you-hold.js";
import { catalogOf, listing } from "../harness/mcp/core-tools.js";
import { offeredTool } from "../harness/mcp/offered.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "VYRE-ADAPTER-SECRET-7f3c1a";
const BODY = { data: { username: "alex", recoveryKey: SECRET, recoveryWrap: SECRET, token: SECRET, client_secret: SECRET } };

test("every registered session adapter gets the same caller, the same secret filter and the same MCP list", async (t) => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    name: "test-box",
    gate: { senders: { hooks: { type: "http", hosts: ["https://hooks.example.test"], vault: "unused-token" } } },
  }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const adapters = sessionAdapters(d.registry.providers.keys());
  for (const id of ["claude", "codex", "grok", "openrouter", "openai-compatible"]) assert.ok(adapters.includes(id), id);
  assert.ok(adapters.length >= 5, "the loop is the registry, plus Claude");

  const rules = fs.readFileSync(path.join(ROOT, "DEVELOPMENT-RULES.md"), "utf8");
  assert.match(rules, /Treat every session adapter the same at the tool door/);
  assert.match(rules, /mcp:agent:<name>/);
  assert.match(fs.readFileSync(path.join(ROOT, "harness/mcp/server.js"), "utf8"), /sessionCaller\(/);
  assert.match(fs.readFileSync(path.join(ROOT, "core/switchboard/index.js"), "utf8"), /VYRE_PROVIDER/);
  assert.match(fs.readFileSync(path.join(ROOT, "harness/mcp/run.js"), "utf8"), /path\.join\(root, "harness", "mcp", "server\.js"\)/);

  /** @type {string[][] } */ const lists = [];
  /** @type {string[][] } */ const offered = [];
  /** @type {string[]} */ const scrubbed = [];
  /** @type {string[]} */ const called = [];
  for (const id of adapters) {
    const bare = sessionCaller(id);
    const named = sessionCaller(id, { agent: "kit" });
    assert.equal(bare, "mcp", id);
    assert.equal(named, "mcp:agent:kit", id);
    // The Gate and an agent's browser profile read the name out of that caller. A bare `mcp` names nobody.
    assert.equal(agentClaim(named), "kit", id);
    assert.equal(agentClaim(bare), null, id);
    assert.equal(modelCaller(bare), true, id);
    assert.equal(modelCaller(named), true, id);
    const tools = d.registry.listTools(bare);
    lists.push(tools.map((/** @type {{ name: string }} */ tool) => tool.name).sort());
    const catalog = catalogOf(tools.filter((/** @type {{ name: string }} */ tool) => offeredTool({ name: tool.name })));
    offered.push(listing(catalog).map((tool) => tool.name));
    const out = scrubVaultResult(bare, "identity.create", BODY);
    assert.equal(JSON.stringify(out).includes(SECRET), false, id);
    scrubbed.push(JSON.stringify(out));
    const live = await d.registry.call("releases.info", {}, bare);
    called.push(JSON.stringify(live.error ? { error: live.error.code } : { ok: true }));
  }
  for (const list of lists) assert.deepEqual(list, lists[0]);
  for (const list of offered) assert.deepEqual(list, offered[0]);
  assert.ok(offered[0].includes("tools_find") && offered[0].includes("vault_request"), "the shared MCP core is what every adapter is offered");
  for (const row of scrubbed) assert.equal(row, scrubbed[0]);
  for (const row of called) assert.equal(row, called[0]);

  // The Gate files the ask under the agent the caller names, with no separate meta.agent.
  const named = sessionCaller(adapters[0], { agent: "kit" });
  const ask = { kind: "send", via: "hooks", to: "hooks.example.test", content: { method: "POST", url: "https://hooks.example.test/x", body: "a note" } };
  const held = await d.registry.call("gate.request", ask, named);
  assert.equal(held.error, undefined, JSON.stringify(held.error));
  const rows = await d.registry.call("gate.held", {}, "local");
  assert.equal(rows.data.find((/** @type {{ id: string, agent: string|null }} */ row) => row.id === held.data.id).agent, "kit");
  const bareAsk = await d.registry.call("gate.request", { ...ask, content: { ...ask.content, url: "https://hooks.example.test/y" } }, sessionCaller(adapters[0]));
  assert.equal(bareAsk.error, undefined, JSON.stringify(bareAsk.error));
  const rowsBare = await d.registry.call("gate.held", {}, "local");
  assert.equal(rowsBare.data.find((/** @type {{ id: string, agent: string|null }} */ row) => row.id === bareAsk.data.id).agent, null);

  // Browser profiles: computers.list keeps an ordinary agent on its own computer, and a bare mcp may not name one.
  for (const name of ["kit", "pax"]) {
    const made = await d.registry.call("agents.create", { name, kind: "agent", projects: [], computer: true }, "local");
    assert.equal(made.error, undefined, JSON.stringify(made.error));
  }
  const mine = await d.registry.call("computers.list", {}, named);
  assert.deepEqual((mine.data.computers || []).map((/** @type {{ agent: string }} */ c) => c.agent), ["kit"]);
  const other = await d.registry.call("computers.get", { agent: "pax" }, named);
  assert.match(other.error.message, /own computer/);
  const unnamed = await d.registry.call("computers.checkout", { agent: "kit" }, sessionCaller(adapters[0]));
  assert.equal(unnamed.error.code, "denied");
});
