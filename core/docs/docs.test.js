// @ts-check
// core/docs: docs.find and docs.read over the real docs tree. A person's own surface gets the human docs only; a session, an agent or the harness also gets the agent docs. Ranking is pinned by
// intent: a fixed set of things an agent or a person might ask, each with the page that must come first (or among the first three), so a change to the ranker or to a page that makes the docs worse shows here.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import docs, { resolve } from "./index.js";
import { loadCorpus } from "../../lib/docs-corpus.js";
import { PKG_ROOT } from "../../kernel/devbuild.js";

/** The module started on a fake ctx: the tools it registers, callable with a caller label. */
async function tools() {
  /** @type {Record<string, any>} */ const t = {};
  await docs.start({ paths: { root: "/nowhere" }, tool: (/** @type {string} */ n, /** @type {any} */ d) => { t[n] = d; } });
  return {
    find: (/** @type {any} */ input, caller = "mcp:agent:kit") => t["docs.find"].run(input, { caller }),
    read: (/** @type {any} */ input, caller = "mcp:agent:kit") => t["docs.read"].run(input, { caller }),
  };
}

const AGENT = "mcp:agent:kit", PERSON = "cli";

test("an agent is offered the agent pages and the human pages; a person only the human pages, whatever they ask for", async () => {
  const d = await tools();
  const a = await d.find({ query: "approve an outward send", limit: 8 }, AGENT);
  assert.ok(a.pages.some((p) => p.page.startsWith("agents/")), "an agent gets agent pages");
  const p = await d.find({ query: "approve an outward send", limit: 8, set: "agent" }, PERSON);
  assert.ok(p.pages.length > 0 && p.pages.every((x) => !x.page.startsWith("agents/") && x.set === "human"), "a person never gets an agent page, even when asking for the agent set");
  await assert.rejects(d.read({ page: "agents/authority.md" }, PERSON), (e) => e.code === "not_found" && !/Closest:.*agents\//.test(e.message), "to a person an agent page does not exist, and the miss does not suggest one");
  assert.match((await d.read({ page: "agents/authority" }, AGENT)).text, /chain/);
  assert.match((await d.read({ page: "authority" }, AGENT)).page, /agents\/authority\.md/, "a unique file name finds the page");
});

const ASK = [
  ["send an email to a client", "agents/outward-acts.md", 1],
  ["I need the client's social security number", "agents/sealed-and-secrets.md", 1],
  ["my call came back not found", "agents/authority.md", 3],
  ["why was I refused", "agents/authority.md", 3],
  ["what does version_conflict mean", "agents/errors.md", 1],
  ["write an automation that runs when a new lead arrives", "agents/flows.md", 1],
  ["which tools can I call in this space", "agents/tools.md", 1],
  ["create a contact record", "agents/records.md", 1],
  ["connect to stripe", "agents/connections.md", 1],
  ["use a browser on my own computer", "agents/computers-and-files.md", 1],
  ["where am I running and what can I not reach", "agents/environment.md", 2],
  ["should I act or ask the person", "agents/behaviour.md", 2],
  ["how do I remember something for next time", "agents/sessions-and-context.md", 2],
  ["gate.request", "agents/outward-acts.md", 1],
  ["a skill I was offered", "agents/skills.md", 1],
];
for (const [q, want, within] of ASK) {
  test(`an agent asking "${q}" finds ${want} in the first ${within}`, async () => {
    const d = await tools();
    const r = await d.find({ query: q, limit: within }, AGENT);
    assert.ok(r.pages.map((p) => p.page).includes(want), `got ${r.pages.map((p) => p.page).join(", ")}`);
  });
}

test("a person asking in plain words finds the human page", async () => {
  const d = await tools();
  for (const [q, want] of [["how do I back up the server", "using/box-care.md"], ["install vyre on a mac", "get-started/install.md"], ["how is vyre built", "architecture/map.md"]]) {
    const r = await d.find({ query: q, limit: 3 }, PERSON);
    assert.ok(r.pages.map((p) => p.page).includes(want), `${q}: got ${r.pages.map((p) => p.page).join(", ")}`);
  }
});

test("a result says what the page is for and what reading it costs", async () => {
  const d = await tools();
  const r = await d.find({ query: "errors", limit: 3 }, AGENT);
  for (const p of r.pages) { assert.ok(p.when && p.when.length > 10); assert.ok(Number.isInteger(p.tokens) && p.tokens > 0); assert.ok(["human", "agent"].includes(p.set)); }
});

test("read returns one section, or the whole page, or an outline within a budget, and a miss teaches", async () => {
  const d = await tools();
  const one = await d.read({ page: "agents/authority.md", heading: "tasks" }, AGENT);
  assert.match(one.text, /^## Tasks/); assert.ok(one.tokens < 400);
  const whole = await d.read({ page: "agents/authority.md" }, AGENT);
  assert.ok(whole.tokens > one.tokens && whole.text.includes("## Tasks"));
  const big = await d.read({ page: "architecture/map.md", max_tokens: 800 }, AGENT);
  assert.ok(big.of > 800 && big.tokens <= 1300 && Array.isArray(big.more) && big.more.length > 0, "a long page comes back as what fits, with the rest listed");
  const sec = await d.read({ page: "architecture/map.md", heading: "6. The Vault and sealing" }, AGENT);
  assert.match(sec.text, /sealing process/);
  await assert.rejects(d.read({ page: "agents/nope.md" }, AGENT), (e) => e.code === "not_found" && /docs\.find/.test(e.message));
  await assert.rejects(d.read({ page: "agents/authority.md", heading: "nope" }, AGENT), (e) => e.code === "not_found" && /Its sections:/.test(e.message));
});

test("a name resolves to a page by path, with or without .md, or by a unique file name", () => {
  const c = loadCorpus(PKG_ROOT), all = [...c.human, ...c.agent];
  assert.equal(resolve(all, "agents/errors")?.path, "agents/errors.md");
  assert.equal(resolve(all, "/agents/errors.md#x")?.path, "agents/errors.md");
  assert.equal(resolve(all, "no-such-page"), null);
});
