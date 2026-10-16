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
