// @ts-check
// Vyre Computer's front door (R031-90) with the engines faked: which computer, which engine, interface first (offered once), the question when the name is not one computer, the Mac through the link,
// and a login typed by the Vault (the tool never carries a value).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import mod, { engineFor, CLASS } from "./index.js";

/** The module started on fake registry pieces: every tool it registers, and every call it makes. */
async function boot({ role = "box", macs = [], connections = [], answers = {} } = {}) {
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {{ tool: string, input: any }[]} */ const calls = [];
  const ctx = { config: { role }, tool: (name, def) => tools.set(name, def),
    call: async (tool, input) => {
      calls.push({ tool, input });
      if (tool === "link.macs") return { data: macs };
      if (tool === "connectors.connection.list") return { data: { connections } };
      if (tool in answers) { const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; return a && a.error ? a : { data: a }; }
      return { data: { ok: true, via: tool } };
    } };
  await mod.start(ctx);
  const run = (input, caller = "mcp agent:kit", meta = {}) => tools.get("computer").run(input, { caller, ...meta });
  return { tools, calls, run };
}

const MACS = [{ mac: "m1", name: "Alex's MacBook", online: true }, { mac: "m2", name: "Office Mac mini", online: true }];

test("engines: the cloud's Chrome and desktop, the Mac's Chrome and apps", () => {
  assert.equal(engineFor("cloud", "look"), "chrome.snapshot");
  assert.equal(engineFor("cloud", "look", { app: "gimp" }), "hands-desktop.tree");
  assert.equal(engineFor("here", "look", { app: "Notes" }), "hands.observe");
  assert.equal(engineFor("here", "open"), "chrome.open");
  assert.equal(engineFor("cloud", "tabs"), null);
  assert.equal(CLASS.get, "files");
});

test("no name is the cloud computer, as the caller's own agent; the engine's input carries the agent", async () => {
  const b = await boot({ macs: MACS });
  const r = await b.run({ do: "open", url: "https://example.org/x", screen: true });
  assert.equal(r.computer, "Cloud computer");
  assert.equal(r.engine, "chrome.open");
  const c = b.calls.find(c => c.tool === "chrome.open");
  assert.deepEqual(c.input, { url: "https://example.org/x", agent: "kit" });
});

test("a model may use only its own agent's computer", async () => {
  const b = await boot({ macs: MACS });
  await assert.rejects(b.run({ do: "look", agent: "juno" }), /can only use its own computer/);
  await assert.rejects(b.run({ do: "look" }, "mcp"), /names no agent/);
  assert.equal((await b.run({ do: "look", agent: "juno" }, "cli")).engine, "chrome.snapshot", "a person's surface may name the agent");
});

test("'on my office computer' goes to that Mac through the link, as computer.call; two Macs and no name is a question", async () => {
  const b = await boot({ macs: MACS, answers: { "link.macs.call": [{ ok: true, mac: "m2", data: { engine: "chrome.snapshot", title: "Inbox" } }] } });
  const r = await b.run({ do: "look", on: "the office computer" });
  assert.deepEqual([r.computer, r.title], ["Office Mac mini", "Inbox"]);
  const c = b.calls.find(c => c.tool === "link.macs.call");
  assert.deepEqual([c.input.tool, c.input.mac, c.input.input.action], ["computer.call", "m2", "look"]);
  const q = await b.run({ do: "look", on: "mac" });
  assert.equal(q.asked, true);
  assert.deepEqual(q.choices, ["Alex's MacBook", "Office Mac mini"]);
  assert.equal(q.allowOwn, true);
  const none = await b.run({ do: "look", on: "the lab pc" });
  assert.equal(none.asked, true);
  assert.ok(none.choices.includes("Cloud computer"));
});

test("an offline Mac is said plainly", async () => {
  const b = await boot({ macs: [{ mac: "m1", name: "Alex's MacBook", online: false }] });
  await assert.rejects(b.run({ do: "look", on: "my Mac" }), /Alex's MacBook is offline/);
});

test("interface first: a Connection that covers the site is offered once, then the same call goes through; screen:true skips the offer", async () => {
  const b = await boot({ connections: [{ id: "c1", label: "Slack", host: "slack.com", operations: [] }] });
  const first = await b.run({ do: "open", url: "https://app.slack.com/client" });
  assert.equal(first.interfaceFirst, true);
  assert.equal(first.route, "connection");
  assert.ok(!b.calls.some(c => c.tool === "chrome.open"), "nothing touched the screen");
  const second = await b.run({ do: "open", url: "https://app.slack.com/client" });
  assert.equal(second.engine, "chrome.open", "the same call again goes through");
  const forced = await b.run({ do: "open", url: "https://app.slack.com/other", screen: true });
  assert.equal(forced.engine, "chrome.open");
  // A look never needs the offer: reading a page is not the thing that has an interface.
  const l = await b.run({ do: "look" });
  assert.equal(l.engine, "chrome.snapshot");
  const r = await b.run({ do: "route", goal: "send this on Slack to Dana" });
  assert.equal(r.route, "connection");
});

test("a learned operation for the site is offered the same way", async () => {
  const b = await boot({ connections: [{ id: "s1", label: "Harlow CRM", host: "app.harlow.test", transport: "site", site: "https://app.harlow.test", operations: [{ name: "listContacts" }] }] });
  const r = await b.run({ do: "open", url: "https://app.harlow.test/contacts" });
  assert.deepEqual([r.interfaceFirst, r.route, r.operations], [true, "operation", ["listContacts"]]);
});

test("signin goes to the Vault with the agent and conversation the registry vouched for, and carries no value", async () => {
  const b = await boot({ answers: { "vault.agent.fill": { filled: ["username", "password"], origin: "https://app.harlow.test", navigated: true, tab: "T1" } } });
  const r = await b.run({ do: "signin", login: "Harlow-Test", url: "https://app.harlow.test/login" }, "mcp agent:kit", { thread: "t-9" });
  assert.deepEqual(r.filled, ["username", "password"]);
  const c = b.calls.find(c => c.tool === "vault.agent.fill");
  assert.deepEqual(c.input, { item: "Harlow-Test", origin: "https://app.harlow.test", agent: "kit", thread: "t-9", lineage: undefined });
  const m = await boot({ macs: [{ mac: "m1", name: "Alex's MacBook", online: true }] });
  await assert.rejects(m.run({ do: "signin", login: "x", on: "my Mac" }, "mcp agent:kit"), /signing in from a Vault login is done on the cloud computer/);
});

test("the Mac's own side: only the link may run an action for the box", async () => {
  const b = await boot({ role: "local" });
  const exec = b.tools.get("computer.exec");
  await assert.rejects(exec.run({ action: "look" }, { caller: "mcp agent:kit" }), /only the link/);
  const r = await exec.run({ action: "look", args: {} }, { caller: "module:link" });
  assert.equal(r.engine, "chrome.snapshot");
  const app = await exec.run({ action: "look", app: "Notes" }, { caller: "module:link" });
  assert.equal(app.engine, "hands.observe");
});
