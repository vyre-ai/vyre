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
  // the kernel's view of who a call is for: the chain's first hop is the person (meta.person, the box owner unless a test says another)
  const kernel = { owner: "per_owner", chain: async (/** @type {any} */ meta) => ({ hops: [{ actor: { kind: "person", id: meta && meta.person ? meta.person : "per_owner" } }] }) };
  const ctx = { config: { role }, kernel, tool: (name, def) => tools.set(name, def),
    call: async (tool, input) => {
      calls.push({ tool, input });
      if (tool === "link.macs") return { data: macs };
      if (tool === "connectors.connection.list") return { data: { connections } };
      if (tool in answers) { const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; return a && a.error ? a : { data: a }; }
      return { data: { ok: true, via: tool } };
    } };
  await mod.start(ctx);
  const run = (input, caller = "mcp agent:kit", meta = {}) => tools.get("computer.use").run(input, { caller, ...meta });
  const targetsFor = (meta = {}) => tools.get("computer.targets").run({}, { caller: "deck", ...meta });
  return { tools, calls, run, targetsFor };
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
  await assert.rejects(b.run({ do: "look" }, "mcp"), /has no assistant to lend/, "a plain chat with no assistant on the install has no computer");
  const withAssistant = await boot({ macs: MACS, answers: { "agents.list": [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent" }] } });
  const plain = await withAssistant.run({ do: "open", url: "https://example.org/x", screen: true }, "mcp");
  assert.equal(plain.computer, "Cloud computer");
  assert.deepEqual(withAssistant.calls.find(c => c.tool === "chrome.open").input, { url: "https://example.org/x", agent: "juno" }, "a plain chat works on the person's assistant's cloud computer");
  await assert.rejects(withAssistant.run({ do: "look", agent: "kit" }, "mcp"), /not kit's/);
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

test("this Mac: a person's call runs the engine; a model is pointed at the tool that carries its own grant", async () => {
  const b = await boot({ role: "local" });
  const person = await b.run({ do: "look" }, "cli");
  assert.deepEqual([person.computer, person.engine], ["This Mac", "chrome.snapshot"]);
  const model = await b.run({ do: "open", url: "https://example.org/" }, "mcp agent:kit");
  assert.equal(model.direct, true);
  assert.equal(model.tool, "chrome.open");
  assert.ok(!b.calls.some(c => c.tool === "chrome.open"), "nothing was lent an identity");
});

test("the operator card: one per conversation and computer, a plain line for each action, and a stuck line when it fails", async () => {
  const b = await boot({ answers: { "previews.operator": { run: "r1" }, "previews.step": { run: "r1" }, "chrome.open": { ok: true } } });
  await b.run({ do: "open", url: "https://example.org/secret?token=abc" }, "mcp agent:kit", { thread: "t-1" });
  await b.run({ do: "look" }, "mcp agent:kit", { thread: "t-1" });
  await b.run({ do: "look" }, "mcp agent:kit", { thread: "t-2" });
  const ops = b.calls.filter(c => c.tool === "previews.operator");
  assert.deepEqual(ops.map(c => [c.input.computer, c.input.thread]), [["kit", "t-1"], ["kit", "t-2"]], "once per conversation");
  const steps = b.calls.filter(c => c.tool === "previews.step").map(c => c.input);
  assert.deepEqual(steps.slice(0, 2).map(s => [s.run, s.line, s.state]), [["r1", "Opening example.org", "working"], ["r1", "Looking at the page", "working"]]);
  assert.ok(!JSON.stringify(steps).includes("token=abc"), "no query, no value in a line");
  const f = await boot({ answers: { "previews.operator": { run: "r2" }, "previews.step": { run: "r2" }, "chrome.snapshot": { error: { code: "failed", message: "Chrome is not connected" } } } });
  await assert.rejects(f.run({ do: "look" }, "mcp agent:kit", { thread: "t-1" }), /not connected/);
  assert.deepEqual(f.calls.filter(c => c.tool === "previews.step").map(c => c.input.state), ["working", "stuck"]);
  // no conversation, no card; and a missing previews module changes nothing
  const n = await boot({});
  await n.run({ do: "look" }, "mcp agent:kit");
  assert.ok(!n.calls.some(c => c.tool === "previews.operator"));
});

test("an ambiguous computer is one merged question; the answer picks the computer and the work goes on", async () => {
  const b = await boot({ macs: MACS, answers: { "link.macs.call": [{ ok: true, data: { engine: "chrome.snapshot", title: "Inbox" } }], "ask.many": { id: "q1", state: "answered", answers: { computer: { choice: "Office Mac mini" } } } } });
  const r = await b.run({ do: "look", on: "mac" }, "mcp agent:kit", { thread: "t-1" });
  assert.equal(r.computer, "Office Mac mini");
  const q = b.calls.find(c => c.tool === "ask.many").input;
  assert.deepEqual([q.thread, q.questions[0].choices, q.questions[0].allowText], ["t-1", ["Alex's MacBook", "Office Mac mini"], true]);
  // unanswered: the question comes back as an ask, nothing was done
  const u = await boot({ macs: MACS, answers: { "ask.many": { id: "q2", state: "waiting" } } });
  const nope = await u.run({ do: "look", on: "mac" }, "mcp agent:kit", { thread: "t-1" });
  assert.equal(nope.asked, true);
  assert.ok(!u.calls.some(c => c.tool === "link.macs.call"));
});

test("a login nobody lent turns into a sign-in card for the person, not a failure", async () => {
  const b = await boot({ answers: { "vault.agent.fill": { error: { code: "denied", message: "harlow-test is not lent to kit for https://app.harlow.test in this conversation" } }, "previews.signin": { id: "s1", state: "done" } } });
  const r = await b.run({ do: "signin", login: "harlow-test", url: "https://app.harlow.test/login" }, "mcp agent:kit", { thread: "t-1" });
  assert.deepEqual([r.signedIn, r.by], [true, "you"], "done by hand when the retry still finds nothing lent");
  const c = b.calls.find(c => c.tool === "previews.signin").input;
  assert.deepEqual([c.computer, c.site, c.thread], ["kit", "app.harlow.test", "t-1"]);
});

test("the paired Macs are the box owner's: another member's session sees only the cloud computer and cannot drive a Mac (audit: every paired Mac was a target for every caller)", async () => {
  const b = await boot({ macs: MACS, answers: { "link.macs.call": [{ ok: true, data: { engine: "chrome.snapshot", title: "Inbox" } }] } });
  const owner = await b.targetsFor();
  assert.deepEqual(owner.computers.map((/** @type {any} */ c) => c.name), ["Cloud computer", "Alex's MacBook", "Office Mac mini"]);
  const mate = await b.targetsFor({ person: "per_teammate" });
  assert.deepEqual(mate.computers.map((/** @type {any} */ c) => c.name), ["Cloud computer"], "a teammate's session does not see the owner's Macs");
  const r = await b.run({ do: "look", on: "Office Mac mini" }, "deck", { person: "per_teammate" });
  assert.equal(r.asked, true, "naming the Mac is not a way to it: the name matches nothing for this person");
  assert.ok(!b.calls.some(c => c.tool === "link.macs.call"), "no Mac was asked");
});

test("a plain chat works on its own person's assistant's computer: a member's plain chat is refused the owner's", async () => {
  const b = await boot({ macs: MACS, answers: { "agents.list": [{ name: "juno", kind: "assistant" }] } });
  const ok = await b.run({ do: "open", url: "https://example.org/x", screen: true }, "mcp");
  assert.equal(ok.computer, "Cloud computer", "the owner's plain chat");
  await assert.rejects(b.run({ do: "open", url: "https://example.org/x", screen: true }, "mcp", { person: "per_teammate" }), /its own person's assistant's computer/);
  assert.equal(b.calls.filter(c => c.tool === "chrome.open").length, 1, "only the owner's chat reached the browser");
});
