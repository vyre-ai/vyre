// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { FakeDriver } from "./driver/fake.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { SharedBrowser } from "./shared-browser.js";
import { AgentBrowser } from "./agent-browser.js";
import { glassStreamPath } from "../../lib/browser-access.js";

const AGENTS = [{ name: "kit", kind: "agent", computer: true, uid: "agt_01234567-89ab-4cde-b012-3456789abcde" }];

function setup(t, { browse = "browser" } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const driver = new FakeDriver();
  const pool = new Pool({
    db, driver,
    call: async (tool) => (tool === "agents.list" ? { data: AGENTS } : { error: { message: "no" } }),
    emit: () => {},
    config: { driver: "fake", browse, sweepMs: 0 },
    memberTokenKey: () => Promise.resolve("test-member-key"),
  });
  pool._helperFetch = async () => ({ ok: true, json: async () => ({}) });
  const shared = new SharedBrowser({ pool, call: pool.call, cfg: () => ({ driver: "fake", browse }) });
  const agentBrowser = new AgentBrowser({ pool, shared, cfg: () => ({ driver: "fake", browse }) });
  return { pool, shared, agentBrowser, driver };
}

test("AgentBrowser: glass path follows browse mode", () => {
  const desktop = new AgentBrowser({ pool: /** @type {any} */ ({}), shared: /** @type {any} */ ({}), cfg: () => ({ browse: "desktop" }) });
  const browser = new AgentBrowser({ pool: /** @type {any} */ ({}), shared: /** @type {any} */ ({}), cfg: () => ({ browse: "browser" }) });
  assert.equal(desktop.glassPath(), glassStreamPath("desktop"));
  assert.equal(browser.glassPath(), glassStreamPath("browser"));
});

test("AgentBrowser: checkout in browser mode holds without a screen", async t => {
  const { agentBrowser } = setup(t);
  const out = await agentBrowser.checkout("kit", { thread: "th-1", why: "hands" });
  assert.equal(out.agent, "kit");
  assert.equal(out.screen, null);
  assert.equal(out.thread, "th-1");
});

test("AgentBrowser: with per-agent users on and computers.browse unset an agent is never put on the shared browser: its Chrome is its own on the Space's computer, or the call fails loudly", async t => {
  const { pool, shared } = setup(t);
  const lines = [];
  const ab = new AgentBrowser({ pool, shared, cfg: () => ({ agentUsers: true }) });
  ab.log = m => lines.push(m);
  let sharedUsed = 0;
  const realEndpoint = shared.endpoint.bind(shared);
  shared.endpoint = async a => { sharedUsed += 1; return realEndpoint(a); };
  // no Space computer wired: a plain refusal, not the shared browser
  await assert.rejects(ab.endpoint("kit", { why: "hands" }), /computers\.browse is "browser"/);
  await assert.rejects(ab.helper("kit"), /computers\.browse is "browser"/);
  await assert.rejects(ab.checkout("kit", {}), /computers\.browse is "browser"/);
  assert.equal(sharedUsed, 0, "the shared browser served nobody");
  // the Space computer wired: it answers, and the model in use is said and returned
  ab.space = { endpoint: async a => ({ url: `http://space/${a}`, token: "t" }) };
  const ep = await ab.endpoint("kit", { why: "hands" });
  assert.equal(ep.mode, "computer");
  assert.equal(ep.helper.url, "http://space/kit");
  assert.equal((await ab.checkout("kit", {})).model, "computer");
  assert.equal(sharedUsed, 0);
  assert.equal(lines.filter(l => /own Linux user on the Space's computer/.test(l)).length, 1, "said once");
});

test("AgentBrowser: computers.browse \"browser\" on purpose is the one way onto the shared browser, and the model is said", async t => {
  const { pool, shared } = setup(t);
  const lines = [];
  const ab = new AgentBrowser({ pool, shared, cfg: () => ({ browse: "browser" }) });
  ab.log = m => lines.push(m);
  ab.space = { endpoint: async () => { throw new Error("the Space's computer must not be asked"); } };
  assert.equal((await ab.checkout("kit", {})).model, "browser");
  assert.ok(lines.some(l => /shared browser \(computers\.browse is "browser" on purpose\)/.test(l)));
});

test("AgentBrowser: unset means one computer for each agent; computers.agentUsers true means the agent's own Linux user on the Space's computer, and the two never mix", async t => {
  const { pool, shared } = setup(t);
  const off = new AgentBrowser({ pool, shared, cfg: () => ({}) });
  assert.equal(off.mode(), "desktop", "unset: the agent's own desktop container");
  off.space = { endpoint: async () => { throw new Error("the Space's computer must not be asked"); } };
  assert.equal((await off.checkout("kit", {})).model, "desktop");
  const on = new AgentBrowser({ pool, shared, cfg: () => ({ agentUsers: true }) });
  assert.equal(on.mode(), "browser", "agentUsers: the Space's computer");
  on.space = { endpoint: async a => ({ url: `http://space/${a}`, token: "t" }) };
  assert.equal((await on.checkout("kit", {})).model, "computer");
  assert.equal(on.explicitShared(), false, "and not the shared browser, which only browse: browser asks for");
  const desk = new AgentBrowser({ pool, shared, cfg: () => ({ agentUsers: true, browse: "desktop" }) });
  assert.equal(desk.mode(), "desktop", "an explicit desktop wins");
});
